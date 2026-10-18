#!/usr/bin/env node
/**
 * watch-panel-token.mjs — 实时监听 Edge 的 Local Storage 日志，捕获新 refresh_token
 *
 * 背景：Edge/Chromium 的 localStorage 是写后台缓存的，页面不导航/不关闭就不落盘。
 * 这个脚本每 2.5 秒复制一次 leveldb 的 .log（被锁也能复制），在里面找
 * refresh_token 的值；一旦换票成功就写入 DSH 凭据并退出。
 *
 * 用法：node watch-panel-token.mjs [超时秒数，默认 600]
 * 输出：只打掩码；成功时 exit 0。
 */

import {
  copyFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const BASE = "https://sub.ihc.qzz.io";
const REF = "HOTDOG_PANEL_REFRESH_TOKEN";
const CRED = join(process.env.USERPROFILE || homedir(), ".dsh", ".credentials.yaml");
const LS_DIR = join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data", "Default", "Local Storage", "leveldb");
const TIMEOUT_S = Number(process.argv[2] || 600);
const LOG = join(tmpdir(), "dsh-watch-token.log");

const tail = (msg) => {
  try { writeFileSync(LOG, `${new Date().toISOString()} ${msg}\n`, { flag: "a" }); } catch {}
};
const mask = (v) => (!v ? "(空)" : v.length <= 14 ? "*".repeat(v.length) : `${v.slice(0, 8)}…${v.slice(-6)} (len=${v.length})`);

function snapshotFiles() {
  const out = [];
  if (!existsSync(LS_DIR)) return out;
  for (const name of readdirSync(LS_DIR)) {
    if (!/\.(ldb|log)$/i.test(name)) continue;
    const full = join(LS_DIR, name);
    try {
      const st = statSync(full);
      out.push({ full, name, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function readText(full) {
  try {
    return readFileSync(full).toString("latin1");
  } catch {
    const tmp = join(tmpdir(), `watch-${process.pid}-${Math.random().toString(36).slice(2)}.bin`);
    try {
      copyFileSync(full, tmp);
      const t = readFileSync(tmp).toString("latin1");
      unlinkSync(tmp);
      return t;
    } catch {
      return null;
    }
  }
}

/** 从文本里挖 refresh_token 候选：优先 rt_ 形式，其次 refresh_token 之后的可打印串。 */
function harvest(text) {
  const found = new Set();
  for (const m of text.matchAll(/rt_[A-Za-z0-9]{40,80}/g)) found.add(m[0]);
  // 通用：refresh_token 键后面 400 字节内的可打印长串
  let idx = 0;
  while ((idx = text.indexOf("refresh_token", idx)) >= 0) {
    const win = text.slice(idx, idx + 400);
    for (const m of win.matchAll(/[A-Za-z0-9_\-.~=+/]{24,}/g)) {
      const v = m[0];
      if (/^(https?|META|true|false|refresh)/i.test(v)) continue;
      found.add(v);
    }
    idx += 1;
  }
  return [...found];
}

async function exchange(rt) {
  const res = await fetch(`${BASE}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ refresh_token: rt }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const access = json && json.data && json.data.access_token;
  return { ok: res.ok && Boolean(access), status: res.status, next: json && json.data && json.data.refresh_token };
}

function saveToken(token) {
  const lines = readFileSync(CRED, "utf8").split(/\r?\n/);
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  copyFileSync(CRED, `${CRED}.bak-${stamp}`);
  let found = false;
  const out = lines.map((line) => {
    if (!found && new RegExp(`^\\s*${REF}:`).test(line)) {
      found = true;
      const indent = (line.match(/^(\s*)/) || ["", "  "])[1];
      return `${indent}${REF}: "${token}"`;
    }
    return line;
  });
  if (!found) {
    const i = out.findIndex((l) => /^\s*HOTDOG_API_KEY:/.test(l));
    const indent = i >= 0 ? (out[i].match(/^(\s*)/) || ["", "  "])[1] : "  ";
    out.splice(i >= 0 ? i + 1 : out.length - 1, 0, `${indent}${REF}: "${token}"`);
  }
  writeFileSync(CRED, out.join("\n"), "utf8");
}

const tried = new Set();
const started = Date.now();
tail(`watch start dir=${LS_DIR} timeout=${TIMEOUT_S}s`);
console.log(`监听中…（最多 ${TIMEOUT_S} 秒）目录: ${LS_DIR}`);

let lastReport = 0;
for (;;) {
  if (Date.now() - started > TIMEOUT_S * 1000) {
    tail("timeout");
    console.log("超时：没捕获到新 token。");
    process.exit(3);
  }
  for (const f of snapshotFiles()) {
    const text = readText(f.full);
    if (!text) continue;
    for (const cand of harvest(text)) {
      if (tried.has(cand)) continue;
      tried.add(cand);
      const r = await exchange(cand);
      if (r.ok) {
        const toSave = r.next && r.next !== cand ? r.next : cand;
        saveToken(toSave);
        tail(`SUCCESS ${mask(toSave)} from ${f.name} rotated=${toSave !== cand}`);
        console.log(`✅ 捕获并写入: ${mask(toSave)} (来源 ${f.name}${toSave !== cand ? "，含轮换" : ""})`);
        process.exit(0);
      }
      tail(`try ${mask(cand)} from ${f.name} -> HTTP ${r.status}`);
    }
  }
  if (Date.now() - lastReport > 30_000) {
    console.log(`…仍在监听（已试 ${tried.size} 个候选）`);
    lastReport = Date.now();
  }
  await new Promise((r) => setTimeout(r, 2500));
}
