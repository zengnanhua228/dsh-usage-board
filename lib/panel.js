/**
 * panel.js — HotDogAPI 面板只读客户端（P2 金额对账）
 *
 * 字段名来自 2026-10-18 实测（probe-panel.mjs / auto-panel-token.mjs 抓到的真实响应）：
 *
 *   GET /api/v1/user/profile            → data.balance / data.total_recharged
 *   GET /api/v1/usage/dashboard/stats   → data.today_actual_cost / total_actual_cost / today_tokens …
 *   GET /api/v1/usage/dashboard/models  → data.models[] { model, requests, tokens, cost, actual_cost }
 *   GET /api/v1/usage?page&page_size    → data.items[] 含 api_key_id / api_key.name / created_at / actual_cost
 *   （注意：/api/v1/user/api-keys 是 404，key 信息只能从 usage 明细里拿）
 *
 * 口径：
 *   - cost = 原价（倍率前），actual_cost = 实付（倍率后）→ 展示用 actual_cost
 *   - 账号级"今日/累计"来自 dashboard/stats（包含所有 key 的流量）
 *   - DSH 专用 key 的今日花费靠 usage 明细按 api_key_id 过滤后累加（只覆盖最近 N 条，
 *     面板无 api_key_id 聚合参数，所以标注为"近似"）
 *
 * 安全：只读；token 不打印、不进响应、不进错误消息。
 */

import {
  closeSync, copyFileSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const BASE = "https://sub.ihc.qzz.io";
const REF = "HOTDOG_PANEL_REFRESH_TOKEN";
const ACCESS_MARGIN_MS = 5 * 60_000;
const RECENT_PAGES = 2; // 明细取 2 页 × 100 条，用于按 key 近似汇总

/**
 * 跨进程互斥 + access_token 共享缓存。
 *
 * 为什么必须有：面板的 refresh_token 是**单次轮换**的——用一次就发新的、旧的作废。
 * 如果插件（每 ~1 小时刷一次）和任何探测脚本/第二个进程同时刷，就会互相把对方
 * 刚拿到的 token 作废，最终 401 需要重新登录（这个坑已经踩过两次）。
 *
 * 方案：
 *   - 缓存文件 %TEMP%\dsh-hotdog-panel-session.json 共享 access_token + 过期时间；
 *   - 刷新前抢 %TEMP%\dsh-hotdog-panel.lock（wx 独占创建，60s 视为陈旧锁）；
 *   - 抢到锁后**重新读凭据/缓存**，别人刚刷过就直接复用，不再刷第二次。
 */
const LOCK_PATH = join(tmpdir(), "dsh-hotdog-panel.lock");
const SESSION_PATH = join(tmpdir(), "dsh-hotdog-panel-session.json");
const LOCK_STALE_MS = 60_000;

function readSession() {
  try {
    const j = JSON.parse(readFileSync(SESSION_PATH, "utf8"));
    if (j && j.access && Number(j.exp) > Date.now() + 60_000) return j;
  } catch {
    /* 无缓存/损坏 */
  }
  return null;
}

function writeSession(access, exp) {
  try {
    writeFileSync(SESSION_PATH, JSON.stringify({ access, exp, at: Date.now() }), "utf8");
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const t = Date.now() + ms;
    while (Date.now() < t) { /* busy wait 兜底 */ }
  }
}

/** 返回释放函数；超时返回 null。 */
function acquireLock(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(LOCK_PATH); } catch { /* ignore */ } };
    } catch {
      try {
        const st = statSync(LOCK_PATH);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { unlinkSync(LOCK_PATH); continue; }
      } catch { /* 锁已被释放，重试 */ }
      if (Date.now() > deadline) return null;
      sleepSync(100);
    }
  }
}

const toNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function credPath() {
  return join(process.env.USERPROFILE || homedir(), ".dsh", ".credentials.yaml");
}

export function readToken() {
  const p = credPath();
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(new RegExp(`^\\s*${REF}:\\s*"?(.+?)"?\\s*$`, "m"));
  return m ? m[1] : null;
}

/** 轮换时原子写回（带备份）；失败不阻塞请求。 */
export function writeToken(next) {
  const p = credPath();
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  copyFileSync(p, `${p}.bak-${stamp}`);
  let found = false;
  const out = lines.map((line) => {
    if (!found && new RegExp(`^\\s*${REF}:`).test(line)) {
      found = true;
      const indent = (line.match(/^(\s*)/) || ["", "  "])[1];
      return `${indent}${REF}: "${next}"`;
    }
    return line;
  });
  if (!found) {
    const idx = out.findIndex((l) => /^\s*HOTDOG_API_KEY:/.test(l));
    const indent = idx >= 0 ? (out[idx].match(/^(\s*)/) || ["", "  "])[1] : "  ";
    out.splice(idx >= 0 ? idx + 1 : out.length - 1, 0, `${indent}${REF}: "${next}"`);
  }
  writeFileSync(p, out.join("\n"), "utf8");
  return `${p}.bak-${stamp}`;
}

const state = { access: null, exp: 0, lastError: null, rotations: 0, lastRefreshAt: 0 };

async function fetchJson(path, { method = "GET", token, body } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  try {
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: String(err && err.message) };
  }
}

/** 换票；若上游轮换则立刻写回（否则下次必 401）。 */
async function exchange(rt) {
  const r = await fetchJson("/api/v1/auth/refresh", { method: "POST", body: { refresh_token: rt } });
  const access = r.json && r.json.data && r.json.data.access_token;
  if (!r.ok || !access) {
    return { ok: false, error: `refresh failed (HTTP ${r.status || "?"})` };
  }
  const ttl = Math.max(60_000, (Number(r.json.data.expires_in) || 3600) * 1000);
  state.access = access;
  state.exp = Date.now() + ttl - ACCESS_MARGIN_MS;
  state.lastRefreshAt = Date.now();
  const next = r.json.data.refresh_token;
  if (next && next !== rt) {
    state.rotations++;
    try { writeToken(next); } catch { /* 写回失败：保持内存可用，日志里会有 401 */ }
  }
  state.lastError = null;
  return { ok: true };
}

async function accessToken(force = false) {
  // 1) 本进程内存缓存
  if (!force && state.access && Date.now() < state.exp) return state.access;

  // 2) 跨进程共享缓存（别的进程刚刷过就直接用，避免二次轮换）
  if (!force) {
    const shared = readSession();
    if (shared) {
      state.access = shared.access;
      state.exp = Number(shared.exp);
      return state.access;
    }
  }

  // 3) 抢锁后刷新（锁内重读，防止并发轮换互相作废）
  const release = acquireLock();
  if (!release) {
    state.lastError = "LOCK_TIMEOUT";
    return null;
  }
  try {
    if (!force) {
      const shared = readSession();
      if (shared) {
        state.access = shared.access;
        state.exp = Number(shared.exp);
        return state.access;
      }
    }
    const rt = readToken(); // 锁内重读：可能刚被别的进程轮换过
    if (!rt) {
      state.lastError = "MISSING_REFRESH_TOKEN";
      return null;
    }
    const r = await exchange(rt);
    if (!r.ok) {
      state.lastError = r.error;
      state.access = null;
      return null;
    }
    writeSession(state.access, state.exp);
    return state.access;
  } finally {
    release();
  }
}

async function apiGet(path) {
  let at = await accessToken();
  if (!at) return { ok: false, status: 0, error: state.lastError };
  let r = await fetchJson(path, { token: at });
  if (r.status === 401) {
    at = await accessToken(true);
    if (!at) return { ok: false, status: 401, error: state.lastError };
    r = await fetchJson(path, { token: at });
  }
  return r;
}

function sum(items, fn) {
  let s = 0;
  for (const it of items) {
    const v = fn(it);
    if (typeof v === "number" && Number.isFinite(v)) s += v;
  }
  return s;
}

const round = (v, d = 6) => (typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(d)) : null);

/**
 * 快照缓存（stale-while-revalidate）：
 * 面板一次快照要打 5 个接口（约 4s），任何一步抖动都会让前端闪一下"取数失败"。
 * 这里做三件事：
 *   1. 20 秒内直接复用结果；
 *   2. 并发请求合并（同时多个轮询只发一轮）；
 *   3. 刷新失败但手里有上次成功结果 → 返回旧数据 + stale 标记，而不是报错。
 */
const SNAP_TTL_MS = 20_000;
const SNAP_MAX_STALE_MS = 10 * 60_000;
const snapCache = { data: null, at: 0, inflight: null };

/**
 * 内部实现：并行取数。
 */
async function doSnapshot({ balanceThreshold = 5 } = {}) {
  const rt = readToken();
  if (!rt) {
    return { ok: true, configured: false, reason: "MISSING_REFRESH_TOKEN" };
  }

  // 日期区间先算出来，trend 和后续统计共用
  const TZ_OFFSET_MIN = 480;
  const localDay = (ms) => new Date(ms + TZ_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
  const endKey = localDay(Date.now());
  const startKey = localDay(Date.now() - 13 * 86_400_000);

  // 五个互相独立的只读请求 → 并行（原来串行约 4.4s，并行约 1.5s）
  const [profile, stats, models, usageP1] = await Promise.all([
    apiGet("/api/v1/user/profile"),
    apiGet("/api/v1/usage/dashboard/stats"),
    apiGet("/api/v1/usage/dashboard/models"),
    apiGet("/api/v1/usage?page=1&page_size=100"),
  ]);
  const trendRes = await apiGet(`/api/v1/usage/dashboard/trend?start_date=${startKey}&end_date=${endKey}`);

  if (!stats.ok) {
    return {
      ok: false,
      configured: true,
      auth: state.access ? "ok" : "fail",
      error: stats.error || `HTTP ${stats.status}`,
      rotations: state.rotations,
      hint: state.lastError === "MISSING_REFRESH_TOKEN" ? "token 缺失" : "refresh_token 可能已失效，需重新登录面板",
    };
  }

  const p = (profile.json && profile.json.data) || {};
  const s = (stats.json && stats.json.data) || {};
  const modelRows = ((models.json && models.json.data && models.json.data.models) || []).map((m) => ({
    model: m.model,
    requests: m.requests,
    tokens: m.total_tokens,
    inputTokens: m.input_tokens,
    outputTokens: m.output_tokens,
    cacheReadTokens: m.cache_read_tokens,
    cost: round(m.cost),
    actualCost: round(m.actual_cost),
  }));

  // 明细：只看第 1 页（100 条）——足够定位 DSH 专用 key 与今日用量，
  // 且能把快照压到 1 次请求的延迟内（第 2 页要再加 0.9s）。
  const pages =
    usageP1.ok && usageP1.json && usageP1.json.data && Array.isArray(usageP1.json.data.items)
      ? usageP1.json.data.items
      : [];

  let dshKeyId = null;
  let dshKeyName = null;
  let groupMultiplier = null;
  for (const it of pages) {
    const k = it.api_key || {};
    const name = String(k.name || "");
    if (/dsh/i.test(name)) {
      dshKeyId = k.id;
      dshKeyName = name;
      if (it.group && toNum(it.group.rate_multiplier) !== null) groupMultiplier = it.group.rate_multiplier;
      break;
    }
  }
  if (dshKeyId === null && pages.length) {
    // 兜底：最近一条请求所属 key
    dshKeyId = pages[0].api_key_id;
    dshKeyName = (pages[0].api_key && pages[0].api_key.name) || null;
    if (pages[0].group) groupMultiplier = toNum(pages[0].group.rate_multiplier);
  }

  // 本地日期（固定 +08:00）已在函数开头算好（localDay / todayKey）
  const todayKey = localDay(Date.now());

  // 明细可能按 id 升序返回（旧的在前），按时间排序后再取首尾
  const dshItems =
    dshKeyId === null
      ? []
      : pages
          .filter((it) => it.api_key_id === dshKeyId)
          .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));

  const itemDay = (it) => {
    const raw = String(it.created_at || "");
    // 服务器返回带 +08:00 偏移，直接 slice 就是本地日期；兜底用时间戳换本地日期
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? localDay(ms) : "";
  };
  // 明细里没有 total_tokens 字段，用四桶相加
  const itemTokens = (it) =>
    toNum(it.total_tokens) ||
    toNum(it.input_tokens) + toNum(it.output_tokens) + toNum(it.cache_read_tokens) + toNum(it.cache_creation_tokens);

  const dshTodayItems = dshItems.filter((it) => itemDay(it) === todayKey);

  const keyStats = {
    id: dshKeyId,
    name: dshKeyName,
    multiplier: groupMultiplier,
    sampledRequests: dshItems.length,
    todayRequests: dshTodayItems.length,
    todayActualCost: round(sum(dshTodayItems, (x) => x.actual_cost)),
    todayTokens: sum(dshTodayItems, itemTokens),
    sampledActualCost: round(sum(dshItems, (x) => x.actual_cost)),
    sampledTokens: sum(dshItems, itemTokens),
    sampledFrom: dshItems.length ? dshItems[0].created_at : null,
    sampledTo: dshItems.length ? dshItems[dshItems.length - 1].created_at : null,
    todayKey,
  };

  // 近 14 天金额趋势（已在开头与其它请求并行取到）
  const trendRows = ((trendRes.json && trendRes.json.data && trendRes.json.data.trend) || []).map((d) => ({
    date: d.date,
    requests: d.requests,
    tokens: d.total_tokens,
    cost: round(d.cost),
    actualCost: round(d.actual_cost),
  }));

  const balance = round(p.balance, 8);
  const threshold = Number.isFinite(balanceThreshold) ? balanceThreshold : 5;

  return {
    ok: true,
    configured: true,
    auth: "ok",
    rotations: state.rotations,
    refreshedAt: state.lastRefreshAt,
    account: {
      balance,
      totalRecharged: round(p.total_recharged, 8),
      lastActiveAt: p.last_active_at || null,
      balanceThreshold: threshold,
      lowBalance: typeof balance === "number" && balance < threshold,
    },
    today: {
      requests: s.today_requests,
      tokens: s.today_tokens,
      cost: round(s.today_cost),
      actualCost: round(s.today_actual_cost),
    },
    total: {
      requests: s.total_requests,
      tokens: s.total_tokens,
      cost: round(s.total_cost),
      actualCost: round(s.total_actual_cost),
      apiKeys: s.total_api_keys,
    },
    models: modelRows.slice(0, 20),
    moneyTrend: trendRows,
    keyStats,
    note: "账号级金额含所有 key；dshKey 数据来自最近 100 条明细，为近似值",
  };
}

/**
 * 对外入口：带缓存 / 合并并发 / 失败回退旧数据。
 * 前端因此不会再出现"先显示失败、过一会又好了"的闪烁。
 */
export async function panelSnapshot(opts = {}) {
  const now = Date.now();
  if (snapCache.data && now - snapCache.at < SNAP_TTL_MS) {
    return { ...snapCache.data, cached: true };
  }
  if (!snapCache.inflight) {
    snapCache.inflight = doSnapshot(opts)
      .then((s) => {
        if (s && s.ok) {
          snapCache.data = s;
          snapCache.at = Date.now();
        }
        return s;
      })
      .catch((e) => ({ ok: false, configured: true, error: String((e && e.message) || e) }))
      .finally(() => {
        snapCache.inflight = null;
      });
  }
  const res = await snapCache.inflight;
  if (res && !res.ok && snapCache.data && Date.now() - snapCache.at < SNAP_MAX_STALE_MS) {
    // 刷新失败但手里有上次成功的结果：给旧数据，标 stale，前端只显示"更新中"
    return { ...snapCache.data, stale: true, staleAgeMs: Date.now() - snapCache.at, lastError: res.error };
  }
  return res;
}

/**
 * 供其它脚本/探测复用：走同一套锁与共享缓存，避免绕过锁把 token 刷死。
 * 用法：await panelGet("/api/v1/usage/dashboard/stats")
 */
export async function panelGet(path) {
  return apiGet(path);
}

/**
 * 失败请求看板：读面板 /api/v1/usage/errors，按类别/模型/状态码聚合。
 * 字段实测：{ id, created_at, model, status_code, category, message, key_name, group_name, platform }
 */
export async function panelErrors({ days = 7, limit = 50 } = {}) {
  const TZ = 480;
  const localDay2 = (ms) => new Date(ms + TZ * 60_000).toISOString().slice(0, 10);
  const endKey2 = localDay2(Date.now());
  const startKey2 = localDay2(Date.now() - (Math.max(1, days) - 1) * 86_400_000);
  const r = await apiGet(`/api/v1/usage/errors?page=1&page_size=${Math.min(limit, 100)}&start_date=${startKey2}&end_date=${endKey2}`);
  if (!r.ok) {
    return { ok: false, configured: true, error: r.error || `HTTP ${r.status}` };
  }
  const d = (r.json && r.json.data) || {};
  const items = Array.isArray(d.items) ? d.items : [];

  const byCategory = {};
  const byModel = {};
  const byStatus = {};
  for (const it of items) {
    const cat = it.category || "unknown";
    const model = it.model || "?";
    const status = String(it.status_code || "?");
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    byModel[model] = (byModel[model] || 0) + 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  const top = (obj, n = 5) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v }));

  return {
    ok: true,
    configured: true,
    range: { start: startKey2, end: endKey2 },
    total: Number(d.total) || items.length,
    sampleSize: items.length,
    byCategory: top(byCategory),
    byModel: top(byModel),
    byStatus: top(byStatus, 6),
    items: items.slice(0, limit).map((it) => ({
      at: it.created_at,
      model: it.model,
      status: it.status_code,
      category: it.category,
      message: String(it.message || "").slice(0, 160),
      keyName: it.key_name || null,
      endpoint: it.inbound_endpoint || null,
    })),
  };
}

/**
 * 余额告警：低于阈值时发一条 Windows 系统通知（每 minIntervalHours 最多一次）。
 * 纯兜底：DSH 不运行时不会检查。
 */
const ALERT_STATE = join(tmpdir(), "dsh-usage-board-alert.json");

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

/** 发 Windows toast（best-effort；失败静默）。 */
export function sendToast(title, message) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(message)}</text></binding></visual></toast>`;
  const ps = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml('${xml.replace(/'/g, "''")}')`,
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($toast)",
  ].join("; ");
  try {
    const p = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      windowsHide: true, stdio: "ignore", detached: true,
    });
    p.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查余额并在需要时告警。返回 {ok, balance, alerted, reason}。
 * 状态文件记最后一次告警时间，避免刷屏。
 */
export async function checkBalanceAlert({ threshold = 5, minIntervalHours = 12, enabled = true } = {}) {
  if (!enabled) return { ok: true, skipped: "disabled" };
  const profile = await apiGet("/api/v1/user/profile");
  if (!profile.ok) {
    return { ok: false, error: profile.error || `HTTP ${profile.status}` };
  }
  const balance = Number(profile.json && profile.json.data && profile.json.data.balance);
  if (!Number.isFinite(balance)) return { ok: false, error: "balance missing" };

  let st = {};
  try { st = JSON.parse(readFileSync(ALERT_STATE, "utf8")) || {}; } catch { /* 无状态 */ }
  const lastAt = Number(st.at) || 0;
  const dueAt = lastAt + Math.max(1, minIntervalHours) * 3_600_000;
  const due = balance < threshold && Date.now() >= dueAt;

  if (!due) return { ok: true, alerted: false, balance, threshold, low: balance < threshold };

  const sent = sendToast(
    "HotDogAPI 余额偏低",
    `当前 $${balance.toFixed(2)}，低于阈值 $${threshold}。面板为人工充值，请及时处理。`,
  );
  if (sent) {
    try { writeFileSync(ALERT_STATE, JSON.stringify({ at: Date.now(), balance, threshold }), "utf8"); } catch { /* ignore */ }
  }
  return { ok: true, alerted: sent, balance, threshold, low: true };
}

/**
 * 一键登录：用面板账号密码换 token 并保存（不用再 F12 复制 refresh_token）。
 *
 * 面板没有启用任何 OAuth，但有标准的邮箱+密码登录接口：
 *   POST /api/v1/auth/login { email, password } → { data: { access_token, refresh_token, user } }
 * 当前站点未启用验证码（turnstile/tencent/aliyun 均 false），所以可自动化。
 *
 * 安全：密码只在本次请求内存里使用，不写盘、不进日志、不回显。
 * 记住邮箱：成功后把邮箱写到 ~/.dsh/usage-board-login.json（仅邮箱，不含密码）。
 */
const LOGIN_INFO_PATH = join(process.env.USERPROFILE || homedir(), ".dsh", "usage-board-login.json");

export function readLoginInfo() {
  try {
    const o = JSON.parse(readFileSync(LOGIN_INFO_PATH, "utf8"));
    return { email: typeof o.email === "string" ? o.email : null, at: Number(o.at) || 0 };
  } catch {
    return { email: null, at: 0 };
  }
}

function writeLoginInfo(email) {
  try {
    writeFileSync(LOGIN_INFO_PATH, JSON.stringify({ email, at: Date.now() }), "utf8");
  } catch {
    /* 记住邮箱失败不影响登录 */
  }
}

/**
 * 登录失败分类：把面板/网络的各种错误翻译成"用户能据此行动"的提示。
 */
export function classifyLoginFailure(status, json, networkError) {
  const raw =
    (json && (json.message || json.reason)) ||
    networkError ||
    "";
  const reason = String((json && json.reason) || "").toUpperCase();
  const low = String(raw).toLowerCase();

  if (status === 401 || reason.includes("INVALID_CREDENTIALS")) {
    return {
      code: "BAD_CREDENTIALS",
      error: "账号或密码不正确",
      hint: "检查邮箱是否完整（带 @ 后缀）、密码大小写和特殊字符；也可改用「粘贴 refresh_token」。",
      retryable: true,
    };
  }
  if (status === 429) {
    return {
      code: "RATE_LIMITED",
      error: "登录尝试过于频繁",
      hint: "等 1–2 分钟再试。连续失败可能触发临时锁定。",
      retryable: true,
    };
  }
  if (status === 403) {
    return {
      code: "FORBIDDEN",
      error: "账号被限制或需要额外验证",
      hint: "到网页面板确认账号状态（禁用/人机验证）；也可改用「粘贴 refresh_token」。",
      retryable: false,
    };
  }
  if (status === 400 && /captcha|turnstile|verify|验证|人机/.test(low)) {
    return {
      code: "CAPTCHA_REQUIRED",
      error: "面板要求人机验证",
      hint: "先在浏览器登录一次，再用「粘贴 refresh_token」方式配置。",
      retryable: false,
    };
  }
  if (/email.*(not|no).*(found|exist)|no such user|user not found|unknown user/.test(low)) {
    return {
      code: "NO_SUCH_ACCOUNT",
      error: "该邮箱在面板上不存在",
      hint: "确认邮箱拼写；如果你在面板用的是另一个邮箱，请换一个。",
      retryable: true,
    };
  }
  if (/locked|disabled|banned|suspend|冻结|禁用/.test(low)) {
    return {
      code: "ACCOUNT_LOCKED",
      error: "账号已被锁定/禁用",
      hint: "联系面板管理员（人工微信）处理；临时方案是用「粘贴 refresh_token」。",
      retryable: false,
    };
  }
  if (/password/.test(low)) {
    return {
      code: "PASSWORD_REJECTED",
      error: "密码不符合要求或被拒",
      hint: "确认没有多余空格；如果是刚改过密码，用新密码重试。",
      retryable: true,
    };
  }
  if (status === 0 || /network|fetch failed|timeout|timed out|ECONN|ENOTFOUND/i.test(String(networkError || raw))) {
    return {
      code: "NETWORK",
      error: "连不上面板服务",
      hint: "检查网络/代理是否正常，稍后重试。",
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      code: "SERVER_ERROR",
      error: "面板服务端异常（HTTP " + status + "）",
      hint: "面板可能正在维护，稍后重试。",
      retryable: true,
    };
  }
  return { code: "UNKNOWN", error: String(raw || "登录失败"), hint: "", retryable: false };
}

export async function panelLogin({ email, password, remember = true }) {
  const e = String(email || "").trim();
  const p = String(password || "");
  if (!e || !p) return { ok: false, code: "MISSING_INPUT", error: "请填写邮箱和密码", retryable: true };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    return { ok: false, code: "BAD_EMAIL_FORMAT", error: "邮箱格式看起来不对", hint: "例如 1261429524@qq.com", retryable: true };
  }

  const r = await fetchJson("/api/v1/auth/login", { method: "POST", body: { email: e, password: p } });
  const d = r.json && r.json.data;
  const access = d && d.access_token;
  const rt = d && d.refresh_token;
  if (!r.ok || !access || !rt) {
    const info = classifyLoginFailure(r.status || 0, r.json, r.error);
    return { ok: false, code: info.code, error: info.error, hint: info.hint, retryable: info.retryable, status: r.status || 0 };
  }

  // 保存 refresh_token（这是长期凭据）
  try {
    writeToken(rt);
  } catch (err) {
    return { ok: false, error: "WRITE_CREDENTIALS_FAILED: " + (err && err.message ? err.message : String(err)) };
  }

  // 缓存 access_token，避免立刻又走一次 refresh（refresh 会轮换）
  const ttl = Math.max(60_000, (Number(d.expires_in) || 3600) * 1000);
  state.access = access;
  state.exp = Date.now() + ttl - ACCESS_MARGIN_MS;
  state.lastRefreshAt = Date.now();
  state.lastError = null;
  writeSession(state.access, state.exp);

  // 让下次快照重新取数
  snapCache.data = null;
  snapCache.at = 0;

  const finalEmail = (d.user && d.user.email) || e;
  if (remember) writeLoginInfo(finalEmail);

  // 顺手回报余额，让界面立刻有反馈
  let balance = null;
  try {
    const prof = await apiGet("/api/v1/user/profile");
    balance = prof.json && prof.json.data && prof.json.data.balance;
  } catch {
    /* 余额拿不到不影响登录成功 */
  }
  return { ok: true, balance, email: finalEmail, remembered: Boolean(remember), rotations: state.rotations };
}

/** 退出：只删本地保存的 refresh_token（不改面板侧登录态）。 */
export function panelLogout() {
  const p = credPath();
  if (!existsSync(p)) return { ok: true, removed: false };
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  copyFileSync(p, `${p}.bak-logout-${stamp}`);
  const kept = lines.filter((line) => !new RegExp(`^\\s*${REF}:`).test(line));
  if (kept.length === lines.length) return { ok: true, removed: false };
  writeFileSync(p, kept.join("\n"), "utf8");
  state.access = null;
  state.exp = 0;
  snapCache.data = null;
  snapCache.at = 0;
  return { ok: true, removed: true };
}

export function panelAuthState() {
  const rt = readToken();
  const mask = !rt ? "(空)" : rt.length <= 14 ? "*".repeat(rt.length) : `${rt.slice(0, 8)}…${rt.slice(-6)} (len=${rt.length})`;
  const info = readLoginInfo();
  return {
    hasRefreshToken: Boolean(rt),
    tokenMask: mask,
    lastEmail: info.email || null,
    lastEmailAt: info.at || 0,
    accessCached: Boolean(state.access && Date.now() < state.exp),
    lastError: state.lastError,
    rotations: state.rotations,
  };
}

/** 供诊断：把最近一次原始响应写到临时文件。 */
export function rawPath() {
  return join(tmpdir(), "dsh-usage-board-panel-raw.json");
}
