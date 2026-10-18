/**
 * dsh-usage-board — 服务端
 *
 * 只读 DSH 自己的会话投影缓存（session_projcache），把每次会话的
 * provider 上报 token 用量按「天 / provider / 模型」聚合，经 DSH 的
 * HTTP 面同源暴露给浏览器端看板。
 *
 * 三条硬约束：
 *   1. 只读 —— 不写 DSH 数据、不写配置；
 *   2. 零凭据 —— 不碰任何 API key / refresh_token；
 *   3. 零网络 —— 不请求任何外部服务（也不请求 wb 网关）。
 *
 * 数据来源：<DSH_HOME>/storages/session_projcache/sessions/*.json
 *   record.rows.tokenUsage.val.totals          → 四桶 token（provider 上报值）
 *   record.rows.modelSelection.val.lastUsed    → provider / model
 *   record.rows.sessionListMetadata.val.lastPromptAt → 最后活动时间
 *   record.identity.createdAt / cwd            → 兜底与展示
 *
 * 已知限制（写在 README，不要试图在这里"修好"）：
 *   - 模型归因是**会话级**（中途换模型会归到最后一次）；
 *   - 时间用最后活动时间，跨多天的长会话整体落在最后一天；
 *   - 这是 DSH 内部存储，升级可能改结构 → 缺字段一律跳过并计数。
 */

/** 插件身份（Cordis 约定）。 */
export const name = "usage-board";

/**
 * 刻意不把 webServer 放进 inject：headless profile 没有 HTTP 面，
 * 放进去会让插件永远 PENDING。改为 ctx.inject 里按需等待。
 */
export const inject = [];

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkBalanceAlert, panelAuthState, panelErrors, panelLogin, panelLogout, panelSnapshot } from "./panel.js";

const MARKER = join(tmpdir(), "dsh-usage-board-loaded.log");
const TZ_OFFSET_MIN = 480; // Asia/Shanghai，本机固定 +08:00
const DEFAULT_CACHE_MS = 4000;
const TREND_DAYS = 14;

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function cacheDir() {
  return join(dshHome(), "storages", "session_projcache", "sessions");
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mark(extra) {
  try {
    appendFileSync(MARKER, `${new Date().toISOString()} pid=${process.pid} ${extra}\n`);
  } catch {
    /* 标记失败不影响主流程 */
  }
}

/** 本地日期键（YYYY-MM-DD），固定按 +08:00 折算。 */
function dayKey(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const shifted = new Date(ms + TZ_OFFSET_MIN * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** 今天 00:00（本地）对应的毫秒。 */
function startOfLocalDay(now) {
  const shifted = new Date(now + TZ_OFFSET_MIN * 60_000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  return Date.UTC(y, m, d) - TZ_OFFSET_MIN * 60_000;
}

function emptyTokens() {
  return { uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addTokens(acc, t) {
  acc.uncached += t.uncached;
  acc.output += t.output;
  acc.cacheRead += t.cacheRead;
  acc.cacheWrite += t.cacheWrite;
  acc.total += t.uncached + t.output + t.cacheRead + t.cacheWrite;
}

function readOne(file) {
  const full = join(cacheDir(), file);
  const raw = JSON.parse(readFileSync(full, "utf8"));
  const record = raw.record || raw;
  const rows = record.rows || {};
  const t = rows.tokenUsage && rows.tokenUsage.val && rows.tokenUsage.val.totals;
  if (!t) return null;

  const tokens = {
    uncached: num(t.uncachedInputTokens),
    output: num(t.outputTokens),
    cacheRead: num(t.cacheReadTokens),
    cacheWrite: num(t.cacheWriteTokens),
  };

  const sel = rows.modelSelection && rows.modelSelection.val && rows.modelSelection.val.lastUsed;
  const meta = rows.sessionListMetadata && rows.sessionListMetadata.val;
  const titleRaw = rows.title && rows.title.val;

  let mtime = 0;
  try {
    mtime = statSync(full).mtimeMs;
  } catch {
    /* ignore */
  }

  return {
    id: file.replace(/^session-/, "").replace(/\.json$/, ""),
    provider: (sel && sel.provider) || "(unknown)",
    model: (sel && sel.model) || "(unknown)",
    title: typeof titleRaw === "string" ? titleRaw : null,
    tokens,
    at: num(meta && meta.lastPromptAt) || num(record.identity && record.identity.createdAt) || mtime,
    cwd: (record.identity && record.identity.cwd) || null,
  };
}

/** 标题清理：子代理会话的首条 prompt 是 system-reminder，太吵。 */
function cleanTitle(t) {
  if (!t) return null;
  const s = String(t).replace(/\s+/g, " ").trim();
  if (/^<system-reminder>/i.test(s)) return "(子代理会话)";
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

/**
 * 读取全部会话。返回 { sessions, skipped, dir }。
 * 单个文件坏掉只计数，不抛错。
 */
export function collect() {
  const dir = cacheDir();
  const out = { sessions: [], skipped: 0, dir };
  if (!existsSync(dir)) return out;

  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }

  for (const f of files) {
    try {
      const s = readOne(f);
      if (s) out.sessions.push(s);
      else out.skipped++;
    } catch {
      out.skipped++;
    }
  }
  return out;
}

function rangeStats(sessions, fromMs) {
  const tokens = emptyTokens();
  let count = 0;
  const models = new Map();

  for (const s of sessions) {
    if (s.at < fromMs) continue;
    count++;
    addTokens(tokens, s.tokens);
    const key = s.provider + "\u0000" + s.model;
    const cur = models.get(key) || {
      provider: s.provider,
      model: s.model,
      sessions: 0,
      tokens: emptyTokens(),
    };
    cur.sessions++;
    addTokens(cur.tokens, s.tokens);
    models.set(key, cur);
  }

  const byModel = [...models.values()].sort((a, b) => b.tokens.total - a.tokens.total);
  // 每个模型单独的缓存命中率（读=缓存读 / (缓存读+未缓存输入)）
  for (const m of byModel) {
    const den = m.tokens.cacheRead + m.tokens.uncached;
    m.cacheHitRate = den > 0 ? m.tokens.cacheRead / den : null;
  }
  const denom = tokens.cacheRead + tokens.uncached;
  return {
    tokens,
    sessions: count,
    byModel,
    cacheHitRate: denom > 0 ? tokens.cacheRead / denom : null,
  };
}

/**
 * 某模型在某区间内的会话明细（看板"下钻"用）。
 * 返回按最后活动时间倒序的会话列表，不带任何敏感信息。
 */
export function sessionsFor({ model, range = "d7", now = Date.now(), limit = 50 } = {}) {
  const { sessions } = collect();
  const today = startOfLocalDay(now);
  const fromMs = { d1: today, d7: today - 6 * 86_400_000, d30: today - 29 * 86_400_000, all: 0 }[range] ?? today - 6 * 86_400_000;
  const picked = sessions
    .filter((s) => s.at >= fromMs && (!model || s.model === model))
    .sort((a, b) => b.at - a.at);
  const items = picked.slice(0, limit).map((s) => {
    const den = s.tokens.cacheRead + s.tokens.uncached;
    return {
      id: s.id,                       // 完整会话 id（可复制，用于在 DSH 侧边栏按标题定位）
      shortId: s.id.slice(0, 8),
      provider: s.provider,
      model: s.model,
      title: cleanTitle(s.title),
      at: s.at,
      tokens: s.tokens,
      total: s.tokens.uncached + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite,
      cacheHitRate: den > 0 ? s.tokens.cacheRead / den : null,
      cwd: s.cwd,
    };
  });
  const agg = emptyTokens();
  for (const s of picked) addTokens(agg, s.tokens);
  return { model: model || null, range, count: picked.length, truncated: picked.length > items.length, tokens: agg, sessions: items };
}

/**
 * 聚合入口（纯函数，便于单测）：传入可选的 now 与 cache 毫秒数。
 */
export function buildStats({ now = Date.now(), cacheMs = DEFAULT_CACHE_MS, range = "d7" } = {}) {
  const { sessions, skipped, dir } = collect();
  const today = startOfLocalDay(now);

  const windows = {
    d1: today,
    d7: today - 6 * 86_400_000,
    d30: today - 29 * 86_400_000,
    all: 0,
  };

  const ranges = {};
  for (const [k, from] of Object.entries(windows)) {
    const r = rangeStats(sessions, from);
    ranges[k] = { tokens: r.tokens, sessions: r.sessions, cacheHitRate: r.cacheHitRate };
  }

  const picked = ranges[range] ? range : "d7";
  const detail = rangeStats(sessions, windows[picked]);
  const byModel = detail.byModel;

  // 近 14 天趋势
  const trend = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const dayStart = today - i * 86_400_000;
    const dayEnd = dayStart + 86_400_000;
    const tokens = emptyTokens();
    let count = 0;
    for (const s of sessions) {
      if (s.at >= dayStart && s.at < dayEnd) {
        count++;
        addTokens(tokens, s.tokens);
      }
    }
    trend.push({ date: dayKey(dayStart), sessions: count, tokens });
  }

  const providers = {};
  for (const s of sessions) providers[s.provider] = (providers[s.provider] || 0) + 1;

  return {
    ok: true,
    generatedAt: now,
    source: dir,
    cacheMs,
    range: picked,
    sessionCount: sessions.length,
    skipped,
    providers,
    ranges,
    byModel,
    trend,
  };
}

/** 4 秒缓存，避免看板轮询时反复解析上百个 JSON。 */
let cache = { at: 0, key: "", data: null };

function cachedStats(range, cacheMs) {
  const key = range + "|" + cacheMs;
  const now = Date.now();
  if (cache.data && cache.key === key && now - cache.at < cacheMs) return cache.data;
  const data = buildStats({ now, cacheMs, range });
  cache = { at: now, key, data };
  return data;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** 读取 JSON 请求体（限制大小，防止误吞大包）。 */
function readJsonBody(req, limitBytes = 8192) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        finish(null);
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        finish(null);
      }
    });
    req.on("error", () => finish(null));
  });
}

export function apply(ctx, config) {
  const cacheMs = num(config && config.cacheMs) || DEFAULT_CACHE_MS;
  // 余额告警阈值（美元）；面板金额低于它时看板胶囊变黄
  const balanceThreshold = num(config && config.balanceThreshold) || 5;
  mark(`apply enter cacheMs=${cacheMs} balanceThreshold=${balanceThreshold}`);

  const register = (webCtx) => {
    const webServer = webCtx && webCtx.webServer;
    if (!webServer || typeof webServer.register !== "function") {
      mark("webServer.register 不可用");
      return;
    }

    webServer.register({
      path: "/api/usage-board/usage",
      handler: (req, res) => {
        try {
          const url = new URL(req.url || "/", "http://localhost");
          const range = url.searchParams.get("range") || "d7";
          sendJson(res, 200, cachedStats(range, cacheMs));
        } catch (err) {
          mark("usage handler 失败: " + (err && err.message));
          sendJson(res, 200, { ok: false, error: String((err && err.message) || err) });
        }
      },
    });

    webServer.register({
      path: "/api/usage-board/diag",
      handler: (req, res) => {
        let text = "";
        try {
          text = existsSync(MARKER) ? readFileSync(MARKER, "utf8") : "(no marker)";
        } catch (e) {
          text = "(marker read failed)";
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(text);
      },
    });

    // 下钻：某模型的会话明细
    webServer.register({
      path: "/api/usage-board/sessions",
      handler: (req, res) => {
        try {
          const url = new URL(req.url || "/", "http://localhost");
          const model = url.searchParams.get("model") || "";
          const range = url.searchParams.get("range") || "d7";
          sendJson(res, 200, { ok: true, ...sessionsFor({ model, range }) });
        } catch (err) {
          mark("sessions handler 失败: " + (err && err.message));
          sendJson(res, 200, { ok: false, error: String((err && err.message) || err) });
        }
      },
    });

    // P2 金额对账：读面板（只读、需 refresh_token；未配置时 configured:false）
    webServer.register({
      path: "/api/usage-board/panel",
      handler: async (req, res) => {
        try {
          const snap = await panelSnapshot({ balanceThreshold });
          sendJson(res, 200, snap);
        } catch (err) {
          mark("panel handler 失败: " + (err && err.message));
          sendJson(res, 200, { ok: false, error: String((err && err.message) || err) });
        }
      },
    });

    webServer.register({
      path: "/api/usage-board/panel/auth",
      handler: (req, res) => {
        try {
          sendJson(res, 200, panelAuthState());
        } catch (err) {
          sendJson(res, 200, { ok: false, error: String((err && err.message) || err) });
        }
      },
    });

    // 一键登录：面板邮箱+密码 → 换 token 并保存（密码不落盘、不回显）
    webServer.register({
      path: "/api/usage-board/panel/login",
      handler: async (req, res) => {
        if ((req.method || "GET").toUpperCase() !== "POST") {
          sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          if (!body) {
            sendJson(res, 200, { ok: false, error: "INVALID_BODY" });
            return;
          }
          const r = await panelLogin({ email: body.email, password: body.password });
          mark("panel-login " + JSON.stringify({ ok: r.ok, email: r.email || null, error: r.error || null }));
          sendJson(res, 200, r.ok ? { ok: true, balance: r.balance, email: r.email } : { ok: false, error: r.error, hint: r.hint });
        } catch (err) {
          sendJson(res, 200, { ok: false, error: String((err && err.message) || err) });
        }
      },
    });

    // 退出：只清本地保存的 refresh_token
    webServer.register({
      path: "/api/usage-board/panel/logout",
      handler: (req, res) => {
        if ((req.method || "GET").toUpperCase() !== "POST") {
          sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
          return;
        }
        try {
          sendJson(res, 200, panelLogout());
        } catch (err) {
          sendJson(res, 200, { ok: false, error: String((err && err.message) || err) });
        }
      },
    });

    // 失败请求看板（面板 usage/errors）
    webServer.register({
      path: "/api/usage-board/errors",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || "/", "http://localhost");
          const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days")) || 7));
          sendJson(res, 200, await panelErrors({ days }));
        } catch (err) {
          mark("errors handler 失败: " + (err && err.message));
          sendJson(res, 200, { ok: false, error: String((err && err.message) || err) });
        }
      },
    });

    mark("routes registered");
  };

  ctx.inject(["webServer"], (webCtx) => {
    mark("webServer available");
    // 客户端的 React 组件在浏览器侧；服务端只负责数据。
    try {
      register(webCtx);
    } catch (err) {
      mark("register 抛错: " + (err && err.message));
    }
  });

  // ── 余额告警（可选，纯兜底）：启动 60s 后查一次，之后每 30 分钟一次 ──
  const notifyEnabled = !(config && config.notifyEnabled === false);
  const notifyMinHours = num(config && config.notifyMinHours) || 12;
  let notifyTimer = null;
  let notifyKick = null;
  async function runBalanceCheck() {
    if (!notifyEnabled) return;
    try {
      const r = await checkBalanceAlert({
        threshold: balanceThreshold,
        minIntervalHours: notifyMinHours,
        enabled: true,
      });
      mark("balance-check " + JSON.stringify(r));
    } catch (err) {
      mark("balance-check 失败: " + (err && err.message ? err.message : String(err)));
    }
  }
  try {
    notifyKick = setTimeout(runBalanceCheck, 60_000);
    notifyTimer = setInterval(runBalanceCheck, 30 * 60_000);
    // 不阻止进程退出（DSH 宿主长期运行，这里只是保守处理）
    if (typeof notifyKick.unref === "function") notifyKick.unref();
    if (typeof notifyTimer.unref === "function") notifyTimer.unref();
    mark(`notify scheduled enabled=${notifyEnabled} threshold=${balanceThreshold} minHours=${notifyMinHours}`);
  } catch (err) {
    mark("notify 调度失败: " + (err && err.message));
  }

  // 卸载时清掉定时器
  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      try { if (notifyKick) clearTimeout(notifyKick); } catch { /* ignore */ }
      try { if (notifyTimer) clearInterval(notifyTimer); } catch { /* ignore */ }
    });
  }
}

export { MARKER };
