#!/usr/bin/env node
/**
 * patch-merge.cjs — 把插件行合并进 DSH profile 的 cordis.patch.yml（或移除）
 *
 * 参数：
 *   node patch-merge.cjs <patchFile> add|remove [configJson]
 *
 * 输出：一行 JSON {ok, changed, reason, rows}
 * 退出码：0 成功（含"无需改动"），非 0 失败
 *
 * 为什么用 js-yaml：手工拼 YAML 缩进容易出错，而这个文件一旦非法 DSH 就起不来。
 * js-yaml 从 DSH 安装目录里找（DSH 自带），不要求全局安装。
 */

const fs = require("fs");
const path = require("path");

const PLUGIN_ID = "usage-board";
const PLUGIN_NAME = "dsh-usage-board";

function findYaml() {
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "js-yaml"));
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    candidates.push(path.join(home, ".dsh", "profiles", "node_modules", "js-yaml"));
  }
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  try { return require("js-yaml"); } catch { /* none */ }
  return null;
}

function isOurRow(row) {
  return Boolean(
    row && Array.isArray(row.insert) &&
    row.insert.some((x) => x && (x.id === PLUGIN_ID || x.name === PLUGIN_NAME)),
  );
}

function main() {
  const [patchFile, action, configJson] = process.argv.slice(2);
  if (!patchFile || !action) {
    console.log(JSON.stringify({ ok: false, reason: "usage: patch-merge.cjs <patchFile> add|remove [configJson]" }));
    process.exit(2);
  }
  const yaml = findYaml();
  if (!yaml) {
    console.log(JSON.stringify({ ok: false, reason: "js-yaml-not-found" }));
    process.exit(3);
  }
  if (!fs.existsSync(patchFile)) {
    console.log(JSON.stringify({ ok: false, reason: "patch-file-missing" }));
    process.exit(4);
  }

  let doc;
  try {
    doc = yaml.load(fs.readFileSync(patchFile, "utf8"));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, reason: "yaml-parse-error: " + (e.reason || e.message) }));
    process.exit(5);
  }
  if (!Array.isArray(doc)) {
    console.log(JSON.stringify({ ok: false, reason: "patch-file-not-array" }));
    process.exit(6);
  }

  let changed = false;
  if (action === "add") {
    if (!doc.some(isOurRow)) {
      let config = {};
      if (configJson) {
        try { config = JSON.parse(configJson); } catch { config = {}; }
      }
      doc.push({
        insert: [{ id: PLUGIN_ID, name: PLUGIN_NAME, config }],
      });
      changed = true;
    }
  } else if (action === "remove") {
    const before = doc.length;
    const next = doc.filter((row) => !isOurRow(row));
    if (next.length !== before) {
      doc.length = 0;
      doc.push(...next);
      changed = true;
    }
  } else {
    console.log(JSON.stringify({ ok: false, reason: "unknown-action" }));
    process.exit(7);
  }

  if (changed) {
    fs.writeFileSync(patchFile, yaml.dump(doc, { lineWidth: -1, noRefs: true }), "utf8");
  }
  // 写后复读校验
  try {
    const check = yaml.load(fs.readFileSync(patchFile, "utf8"));
    if (!Array.isArray(check)) throw new Error("not array after write");
  } catch (e) {
    console.log(JSON.stringify({ ok: false, reason: "post-write-verify-failed: " + e.message }));
    process.exit(8);
  }
  console.log(JSON.stringify({ ok: true, changed, rows: doc.length }));
}

main();
