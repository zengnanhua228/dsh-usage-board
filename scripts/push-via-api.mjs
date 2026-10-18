#!/usr/bin/env node
/**
 * push-via-api.mjs — 当 github.com:443 不可达、但 api.github.com 可达时，
 * 用 GitHub REST API 把当前仓库工作树推成一次提交。
 *
 * 依赖：gh CLI 已登录（用 `gh auth token` 取 token），git 可用（取文件列表）。
 * 用法：node push-via-api.mjs [--branch main] [--message "commit message"]
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const REPO = "zengnanhua228/dsh-usage-board";
const API = "https://api.github.com";
const branchArg = process.argv.indexOf("--branch");
const branch = branchArg > 0 ? process.argv[branchArg + 1] : "main";
const msgArg = process.argv.indexOf("--message");
const message = msgArg > 0 ? process.argv[msgArg + 1] : "dsh-usage-board v0.3.0";

const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const headers = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "content-type": "application/json",
  "user-agent": "dsh-usage-board-push",
};

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

const files = execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

console.log(`文件数: ${files.length}，目标分支: ${branch}`);
console.log(`仓库: ${REPO}`);

// 0) 空仓库不能建 blob（409 Git Repository is empty）→ 先用 Contents API 引导一个提交
let parents = [];
try {
  const ref = await api("GET", `/repos/${REPO}/git/ref/heads/${branch}`);
  parents = [ref.object.sha];
  console.log(`已有分支 ${branch}，父提交: ${ref.object.sha}`);
} catch (e) {
  if (/HTTP 404|HTTP 409/i.test(e.message)) {
    const boot = await api("PUT", `/repos/${REPO}/contents/.bootstrap`, {
      message: "chore: bootstrap repository (api push)",
      content: Buffer.from("bootstrap\n").toString("base64"),
    });
    parents = [boot.commit.sha];
    console.log(`空仓库已引导，初始提交: ${boot.commit.sha}`);
  } else {
    throw e;
  }
}

// 1) 逐个文件建 blob（并发 4 个，避免触发次级限流）
const tree = [];
const queue = [...files];
const workers = Array.from({ length: 4 }, async () => {
  for (;;) {
    const path = queue.shift();
    if (!path) return;
    const content = readFileSync(path);
    const blob = await api("POST", `/repos/${REPO}/git/blobs`, {
      content: content.toString("base64"),
      encoding: "base64",
    });
    tree.push({ path: path.replace(/\\/g, "/"), mode: "100644", type: "blob", sha: blob.sha });
    process.stdout.write(`  blob ${path}\n`);
  }
});
await Promise.all(workers);

// 2) 建 tree
const treeRes = await api("POST", `/repos/${REPO}/git/trees`, { tree });
console.log(`tree: ${treeRes.sha}`);

// 3) 建 commit
const now = new Date().toISOString();
const commitRes = await api("POST", `/repos/${REPO}/git/commits`, {
  message,
  tree: treeRes.sha,
  parents,
  author: { name: "zengnanhua228", email: "1261429524@qq.com", date: now },
  committer: { name: "zengnanhua228", email: "1261429524@qq.com", date: now },
});
console.log(`commit: ${commitRes.sha}`);

// 4) 更新/创建分支引用
try {
  await api("PATCH", `/repos/${REPO}/git/refs/heads/${branch}`, { sha: commitRes.sha, force: true });
  console.log(`已更新 refs/heads/${branch}`);
} catch (e) {
  if (/HTTP 422|not found/i.test(e.message)) {
    await api("POST", `/repos/${REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha: commitRes.sha });
    console.log(`已创建 refs/heads/${branch}`);
  } else {
    throw e;
  }
}

console.log(`\n✅ 推送完成: https://github.com/${REPO}/tree/${branch}`);
