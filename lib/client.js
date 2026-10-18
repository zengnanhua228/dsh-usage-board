/**
 * dsh-usage-board — 浏览器端
 *
 * 两处入口，分工明确：
 *   1. 会话头部胶囊（极简）：今日 token + 状态点；点开只有"快览"（今日四桶 + 金额 + 失败数）
 *   2. 设置页 section（完整看板）：卡片式仪表盘，区间/按模型/下钻/趋势/失败请求/金额明细
 *
 * 数据全部来自服务端同源接口：
 *   GET /api/usage-board/usage?range=d1|d7|d30|all
 *   GET /api/usage-board/panel
 *   GET /api/usage-board/sessions?model=&range=
 *   GET /api/usage-board/errors?days=7
 * 客户端不直接读 DSH 内部数据、不碰任何凭据。
 *
 * 写法对齐本机已验证可用的插件：factory 内取 require；不在 apply 里包 ctx.effect；
 * slot 注册用 ctx.slots.inject + slots.register。
 */

window.__ModuleLoader__.load({
  id: "dsh-usage-board",
  factory: function (require) {
    "use strict";

    var React = require("react");
    var useEffect = React.useEffect;
    var useState = React.useState;
    var useRef = React.useRef;
    var h = React.createElement;

    var API = "/api/usage-board/usage";
    var API_PANEL = "/api/usage-board/panel";
    var API_SESSIONS = "/api/usage-board/sessions";
    var API_ERRORS = "/api/usage-board/errors";
    var API_AUTH = "/api/usage-board/panel/auth";
    var CAPSULE_SLOT = "conversation.session.header.utilities";
    var SETTINGS_SLOT = "settings.section";
    var POLL_MS = 15000;

    var RANGES = [
      { key: "d1", label: "今日" },
      { key: "d7", label: "近 7 天" },
      { key: "d30", label: "近 30 天" },
      { key: "all", label: "全部" },
    ];

    // 只在设置页需要的那套样式（用 class 才有 hover，纯 inline style 做不到）
    var CSS = [
      ".ub-wrap{color:var(--dsh-text-primary,#e6e6e6);font-size:13px;line-height:1.5}",
      ".ub-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:18px}",
      ".ub-title{font-size:17px;font-weight:650;letter-spacing:.2px}",
      ".ub-sub{font-size:12px;color:var(--dsh-text-tertiary,#6b7280);margin-top:3px}",
      ".ub-live{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsh-text-tertiary,#6b7280)}",
      ".ub-dot{width:7px;height:7px;border-radius:50%;display:inline-block}",
      ".ub-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin-bottom:16px}",
      ".ub-card{background:var(--dsh-bg-elevated,#1f2328);border:1px solid var(--dsh-border,rgba(255,255,255,.09));border-radius:12px;padding:12px 14px;transition:border-color .15s,box-shadow .15s}",
      ".ub-card:hover{border-color:rgba(255,255,255,.2);box-shadow:0 6px 18px rgba(0,0,0,.22)}",
      ".ub-k{font-size:11px;color:var(--dsh-text-tertiary,#6b7280);margin-bottom:6px;display:flex;align-items:center;gap:5px}",
      ".ub-v{font-size:21px;font-weight:650;letter-spacing:.2px;line-height:1.15}",
      ".ub-v small{font-size:11px;font-weight:400;color:var(--dsh-text-secondary,#9aa0a6);margin-left:5px;letter-spacing:0}",
      ".ub-note{font-size:10px;color:var(--dsh-text-tertiary,#6b7280);margin-top:5px}",
      ".ub-seg{display:inline-flex;gap:2px;padding:2px;background:rgba(255,255,255,.05);border-radius:9px;margin-bottom:16px}",
      ".ub-seg button{border:none;background:transparent;color:var(--dsh-text-secondary,#9aa0a6);font-size:12px;padding:5px 13px;border-radius:7px;cursor:pointer;font-family:inherit}",
      ".ub-seg button.on{background:rgba(110,168,254,.16);color:#8fb8ff;font-weight:600}",
      ".ub-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px;align-items:start}",
      ".ub-panel{background:var(--dsh-bg-elevated,#1f2328);border:1px solid var(--dsh-border,rgba(255,255,255,.09));border-radius:12px;padding:14px 16px;margin-bottom:12px}",
      ".ub-panel-h{display:flex;align-items:center;gap:8px;margin-bottom:10px}",
      ".ub-panel-t{font-size:13px;font-weight:600}",
      ".ub-panel-x{margin-left:auto;font-size:11px;color:var(--dsh-text-tertiary,#6b7280)}",
      ".ub-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;font-size:12px;cursor:pointer;transition:background .12s}",
      ".ub-row:hover{background:rgba(255,255,255,.045)}",
      ".ub-badge{flex-shrink:0;font-size:9px;padding:1px 6px;border-radius:5px;color:var(--dsh-text-tertiary,#6b7280);border:1px solid var(--dsh-border,rgba(255,255,255,.1));letter-spacing:.4px}",
      ".ub-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsh-text-secondary,#9aa0a6)}",
      ".ub-num{flex-shrink:0;text-align:right;font-variant-numeric:tabular-nums}",
      ".ub-chip{display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid var(--dsh-border,rgba(255,255,255,.1));color:var(--dsh-text-secondary,#9aa0a6);margin:0 4px 4px 0}",
      ".ub-chip.warn{color:#fbbf24;border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.08)}",
      ".ub-chip.ok{color:#4ade80;border-color:rgba(74,222,128,.3);background:rgba(74,222,128,.08)}",
      ".ub-bars{display:flex;align-items:flex-end;gap:3px;height:52px;margin-top:4px}",
      ".ub-bar{flex:1;border-radius:3px 3px 0 0;min-height:2px;background:rgba(110,168,254,.55);transition:background .12s}",
      ".ub-bar:hover{background:rgba(110,168,254,.9)}",
      ".ub-bar.money{background:rgba(74,222,128,.5)}",
      ".ub-bar.money:hover{background:rgba(74,222,128,.85)}",
      ".ub-legend{display:flex;justify-content:space-between;font-size:10px;color:var(--dsh-text-tertiary,#6b7280);margin-top:4px}",
      ".ub-session{margin:2px 0 6px 10px;padding-left:10px;border-left:1px solid var(--dsh-border,rgba(255,255,255,.1))}",
      ".ub-session-row{display:flex;align-items:center;gap:8px;font-size:11px;padding:3px 0;color:var(--dsh-text-secondary,#9aa0a6)}",
      ".ub-copy{flex-shrink:0;font-size:9px;padding:1px 6px;border-radius:5px;cursor:pointer;background:transparent;color:var(--dsh-text-tertiary,#6b7280);border:1px solid var(--dsh-border,rgba(255,255,255,.12));font-family:inherit}",
      ".ub-copy:hover{color:var(--dsh-text-primary,#e6e6e6)}",
      ".ub-copy.ok{color:#4ade80;border-color:rgba(74,222,128,.4)}",
      ".ub-foot{font-size:10px;color:var(--dsh-text-tertiary,#6b7280);line-height:1.6;margin-top:6px}",
      ".ub-pop{padding:12px 14px;width:270px}",
      ".ub-pop-h{display:flex;align-items:baseline;gap:8px;margin-bottom:10px}",
      ".ub-pop-v{font-size:24px;font-weight:650;letter-spacing:.2px}",
      ".ub-pop-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px}",
      ".ub-pop-cell{background:rgba(255,255,255,.04);border-radius:8px;padding:6px 8px}",
      ".ub-pop-k{font-size:9px;color:var(--dsh-text-tertiary,#6b7280)}",
      ".ub-pop-v2{font-size:12px;margin-top:2px;font-variant-numeric:tabular-nums}",
      ".ub-pop-foot{font-size:10px;color:var(--dsh-text-tertiary,#6b7280);border-top:1px solid var(--dsh-border,rgba(255,255,255,.09));padding-top:8px}",
      // 一键登录表单
      ".ub-form{display:flex;flex-direction:column;gap:8px;margin-top:6px}",
      ".ub-row2{display:flex;gap:8px;flex-wrap:wrap}",
      ".ub-input{flex:1;min-width:150px;background:rgba(255,255,255,.04);border:1px solid var(--dsh-border,rgba(255,255,255,.12));border-radius:8px;padding:8px 10px;font-size:12px;color:var(--dsh-text-primary,#e6e6e6);font-family:inherit;outline:none;transition:border-color .15s}",
      ".ub-input:focus{border-color:rgba(110,168,254,.6)}",
      ".ub-btn{border:1px solid var(--dsh-border,rgba(255,255,255,.14));background:transparent;color:var(--dsh-text-secondary,#9aa0a6);border-radius:8px;padding:7px 14px;font-size:12px;cursor:pointer;font-family:inherit;transition:all .15s}",
      ".ub-btn:hover{color:var(--dsh-text-primary,#e6e6e6);border-color:rgba(255,255,255,.3)}",
      ".ub-btn.primary{background:rgba(110,168,254,.16);border-color:rgba(110,168,254,.45);color:#8fb8ff;font-weight:600}",
      ".ub-btn.primary:hover{background:rgba(110,168,254,.26)}",
      ".ub-btn:disabled{opacity:.55;cursor:default}",
      ".ub-msg{font-size:11px;line-height:1.5;padding:6px 8px;border-radius:7px}",
      ".ub-msg.ok{color:#4ade80;background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.25)}",
      ".ub-msg.bad{color:#f87171;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.25)}",
    ].join("\n");

    // ─────────────────────────── 工具 ───────────────────────────

    function fmt(n) {
      var v = Number(n) || 0;
      if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
      if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
      if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
      return String(v);
    }
    function pct(v) {
      if (v === null || v === undefined || !isFinite(v)) return "—";
      return (v * 100).toFixed(1) + "%";
    }
    function usd(v, digits) {
      if (typeof v !== "number" || !isFinite(v)) return "—";
      if (v === 0) return "$0";
      var d = typeof digits === "number" ? digits : Math.abs(v) < 0.01 ? 6 : 2;
      return "$" + v.toFixed(d);
    }
    function shortDate(iso) {
      var s = String(iso || "");
      return s.length >= 10 ? s.slice(5, 10) : s;
    }
    function providerShort(p) {
      var map = { workbuddy: "WB", "deepseek-account": "DSH", "deepseek-official": "DS", hotdog: "HD", hotdogapi1: "HD" };
      return map[p] || String(p || "?").slice(0, 4).toUpperCase();
    }
    function getJSON(url) {
      return fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); });
    }
    function usePollData(url, intervalMs) {
      var s = useState({ data: null, err: null });
      var data = s[0], setData = s[1];
      var e = useState(null), err = e[0], setErr = e[1];
      var alive = useRef(true);
      var loadRef = useRef(null);
      useEffect(function () {
        alive.current = true;
        function load() {
          getJSON(url)
            .then(function (j) {
              if (!alive.current) return;
              if (j && (j.ok || j.configured === false)) { setData(j); setErr(null); }
              else setErr((j && j.error) || "返回 ok=false");
            })
            .catch(function (x) {
              if (!alive.current) return;
              setErr(x && x.message ? x.message : String(x));
            });
        }
        loadRef.current = load;
        load();
        var t = setInterval(load, intervalMs);
        return function () { alive.current = false; clearInterval(t); };
      }, [url]);
      return {
        data: data,
        err: err,
        refresh: function () { if (loadRef.current) loadRef.current(); },
      };
    }

    // ─────────────────────────── 通用小组件 ───────────────────────────

    function StatCard(props) {
      return h("div", { className: "ub-card" },
        h("div", { className: "ub-k" }, props.label, props.hint ? h("span", { title: props.hint, style: { cursor: "help" } }, "ⓘ") : null),
        h("div", { className: "ub-v", style: props.color ? { color: props.color } : null },
          props.value, props.unit ? h("small", null, props.unit) : null),
        props.note ? h("div", { className: "ub-note" }, props.note) : null);
    }

    function Segment(props) {
      return h("div", { className: "ub-seg" },
        RANGES.map(function (r) {
          return h("button", {
            key: r.key,
            className: props.value === r.key ? "on" : "",
            onClick: function () { props.onChange(r.key); },
          }, r.label);
        }));
    }

    function Bars(props) {
      var items = props.items || [];
      var max = 1;
      for (var i = 0; i < items.length; i++) {
        var v = props.valueOf(items[i]) || 0;
        if (v > max) max = v;
      }
      if (!items.length) return h("div", { className: "ub-note" }, "暂无数据");
      return h("div", null,
        h("div", { className: "ub-bars" },
          items.map(function (d) {
            var v = props.valueOf(d) || 0;
            return h("div", {
              key: d.date,
              className: "ub-bar" + (props.money ? " money" : ""),
              title: d.date + " · " + props.tip(d),
              style: { height: Math.max(2, Math.round((v / max) * 50)) + "px" },
            });
          })),
        h("div", { className: "ub-legend" },
          h("span", null, items.length ? shortDate(items[0].date) : ""),
          h("span", null, props.maxLabel ? props.maxLabel(max) : ""),
          h("span", null, items.length ? shortDate(items[items.length - 1].date) : "")));
    }

    // ─────────────────────────── 下钻会话 ───────────────────────────

    function SessionRows(props) {
      var url = API_SESSIONS + "?model=" + encodeURIComponent(props.model) + "&range=" + encodeURIComponent(props.range);
      var poll = usePollData(url, 60000);
      var st = useState(null), copied = st[0], setCopied = st[1];
      var data = poll.data, err = poll.err;

      if (err) return h("div", { className: "ub-session", style: { color: "#f87171" } }, "会话读取失败：" + err);
      if (!data) return h("div", { className: "ub-session" }, "加载会话…");

      function copyId(s) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(s.id).then(function () {
              setCopied(s.id);
              setTimeout(function () { setCopied(null); }, 1500);
            }).catch(function () {});
          }
        } catch (e) { /* ignore */ }
      }

      return h("div", { className: "ub-session" },
        h("div", { className: "ub-note", style: { marginBottom: 4 } },
          "该模型 " + data.count + " 个会话 · 合计 " + fmt((data.tokens || {}).total) + " tokens"),
        (data.sessions || []).slice(0, 10).map(function (s) {
          return h("div", { key: s.id + s.at, className: "ub-session-row" },
            h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsh-text-primary,#e6e6e6)" }, title: s.title || s.id },
              s.title || ("会话 " + (s.shortId || s.id))),
            h("span", { style: { flexShrink: 0 } }, shortDate(new Date(s.at).toISOString())),
            h("span", { style: { flexShrink: 0 } }, pct(s.cacheHitRate)),
            h("span", { className: "ub-num", style: { color: "var(--dsh-text-primary,#e6e6e6)", minWidth: 52 } }, fmt(s.total)),
            h("button", {
              className: "ub-copy" + (copied === s.id ? " ok" : ""),
              onClick: function () { copyId(s); },
              title: "复制完整会话 ID",
            }, copied === s.id ? "已复制" : "复制ID"));
        }));
    }

    // ─────────────────────────── 面板一键登录 ───────────────────────────

    function PanelLogin(props) {
      var es = useState(props.initialEmail || ""), email = es[0], setEmail = es[1];
      var ps = useState(""), pwd = ps[0], setPwd = ps[1];
      var bs = useState(false), busy = bs[0], setBusy = bs[1];
      var er = useState(null), err = er[0], setErr = er[1];
      var hints = useState(null), errHint = hints[0], setErrHint = hints[1];
      var oks = useState(null), okMsg = oks[0], setOkMsg = oks[1];
      var rms = useState(true), remember = rms[0], setRemember = rms[1];

      // 记住的邮箱异步到达时回填（用户已经手动输入过就不覆盖）
      useEffect(function () {
        if (props.initialEmail && !email) setEmail(props.initialEmail);
      }, [props.initialEmail]);

      function submit(ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        if (busy) return;
        setBusy(true); setErr(null); setErrHint(null); setOkMsg(null);
        fetch("/api/usage-board/panel/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: email, password: pwd, remember: remember }),
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.ok) {
              setOkMsg("登录成功" + (typeof j.balance === "number" ? "，余额 " + usd(j.balance) : "") + (j.remembered ? "（已记住邮箱）" : ""));
              setPwd("");
              if (props.onSuccess) props.onSuccess(j);
            } else {
              setErr((j && j.error) || "登录失败");
              setErrHint(j && j.hint ? j.hint : null);
            }
          })
          .catch(function (x) { setErr("请求失败：" + String((x && x.message) || x)); })
          .then(function () { setBusy(false); });
      }

      return h("div", null,
        h("div", { className: "ub-note", style: { marginTop: 0, marginBottom: 8 } },
          "面板没有 OAuth 授权，这里直接用面板账号密码换 token —— 密码只在本机内存里用一次，不保存、不写日志。"),
        h("form", { className: "ub-form", onSubmit: submit },
          h("div", { className: "ub-row2" },
            h("input", {
              className: "ub-input", type: "email", placeholder: "面板邮箱", value: email,
              autoComplete: "username", onChange: function (e) { setEmail(e.target.value); },
            }),
            h("input", {
              className: "ub-input", type: "password", placeholder: "面板密码", value: pwd,
              autoComplete: "current-password", onChange: function (e) { setPwd(e.target.value); },
            })),
          h("div", { className: "ub-row2", style: { alignItems: "center" } },
            h("label", { style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--dsh-text-tertiary,#6b7280)", cursor: "pointer" } },
              h("input", { type: "checkbox", checked: remember, onChange: function (e) { setRemember(e.target.checked); } }),
              "记住邮箱（只存邮箱，不存密码）"),
            h("button", { className: "ub-btn primary", type: "submit", disabled: busy || !email || !pwd, style: { marginLeft: "auto" } },
              busy ? "登录中…" : "一键登录并启用金额"),
            props.onCancel ? h("button", { className: "ub-btn", type: "button", onClick: props.onCancel }, "取消") : null),
          err ? h("div", null,
            h("div", { className: "ub-msg bad" }, err),
            errHint ? h("div", { className: "ub-note", style: { padding: "4px 2px 0" } }, "建议：" + errHint) : null) : null,
          okMsg ? h("div", { className: "ub-msg ok" }, okMsg) : null));
    }

    // ─────────────────────────── 设置页看板 ───────────────────────────

    function SettingsBoard() {
      var rs = useState("d7"), range = rs[0], setRange = rs[1];
      var es = useState(null), expanded = es[0], setExpanded = es[1];
      var ls = useState(false), loginOpen = ls[0], setLoginOpen = ls[1];
      var ms = useState(null), msg = ms[0], setMsg = ms[1];

      var usage = usePollData(API + "?range=" + encodeURIComponent(range), POLL_MS);
      var panel = usePollData(API_PANEL, 60000);
      var errors = usePollData(API_ERRORS + "?days=7", 300000);
      var auth = usePollData(API_AUTH, 300000);
      var knownEmail = (auth.data && auth.data.lastEmail) || "";

      function afterLogin() {
        panel.refresh();
        auth.refresh();
      }

      var data = usage.data, uerr = usage.err;
      var pdata = panel.data, perr = panel.err;
      var edata = errors.data;
      var rangeData = data && data.ranges ? data.ranges[range] : null;
      var byModel = (data && data.byModel) || [];
      var tokenTrend = ((data && data.trend) || []).slice(-14);
      var moneyTrend = (pdata && pdata.moneyTrend) || [];
      var acc = (pdata && pdata.account) || {};
      var today = (pdata && pdata.today) || {};
      var total = (pdata && pdata.total) || {};
      var keyStats = (pdata && pdata.keyStats) || {};
      var lowBalance = Boolean(acc.lowBalance);

      var spendWarn = Boolean(pdata && pdata.ok && pdata.guard && pdata.guard.exceeded);
      var spendBanner = spendWarn
        ? h("div", { className: "ub-msg bad", style: { marginBottom: 12 } },
            "⚠ 今日已实付 " + usd(pdata.guard.today) + "，超过日消耗护栏 " + usd(pdata.guard.threshold) +
            "。如果不是预期消耗，检查模型选择与上下文长度（护栏可在插件配置里调 spendGuardThreshold）。")
        : null;
      var dot = uerr || spendWarn ? "#f87171" : lowBalance ? "#fbbf24" : "#4ade80";

      // 顶部指标卡
      var cards = h("div", { className: "ub-cards" },
        h(StatCard, {
          label: "今日 Token",
          value: today && data && data.ranges ? fmt(data.ranges.d1.tokens.total) : "—",
          note: data && data.ranges ? data.ranges.d1.sessions + " 个会话" : "",
        }),
        h(StatCard, {
          label: "今日实付",
          value: usd(today.actualCost),
          note: usd(today.cost) + " 原价",
        }),
        h(StatCard, {
          label: "面板余额",
          value: usd(acc.balance),
          color: lowBalance ? "#fbbf24" : null,
          note: lowBalance ? "低于阈值 " + usd(acc.balanceThreshold) + " ⚠" : "阈值 " + usd(acc.balanceThreshold),
        }),
        h(StatCard, {
          label: "近 7 天失败",
          value: edata && edata.ok ? String(edata.total) : "—",
          color: edata && edata.ok && edata.total > 0 ? "#fbbf24" : null,
          unit: "次",
        }));

      // 按模型
      var modelRows = [];
      byModel.slice(0, 10).forEach(function (m) {
        var k = m.provider + "/" + m.model;
        var open = expanded === k;
        modelRows.push(h("div", {
          key: k,
          className: "ub-row",
          onClick: function () { setExpanded(open ? null : k); },
        },
          h("span", { className: "ub-badge" }, providerShort(m.provider)),
          h("span", { className: "ub-name", style: open ? { color: "var(--dsh-text-primary,#e6e6e6)" } : null },
            (open ? "▾ " : "▸ ") + m.model),
          h("span", { className: "ub-num", style: { color: "var(--dsh-text-tertiary,#6b7280)", minWidth: 34 } }, m.sessions + "场"),
          h("span", { className: "ub-num", style: { color: "var(--dsh-text-tertiary,#6b7280)", minWidth: 46 } }, pct(m.cacheHitRate)),
          h("span", { className: "ub-num", style: { minWidth: 58 } }, fmt(m.tokens.total))));
        if (open) modelRows.push(h(SessionRows, { key: k + "-s", model: m.model, range: range }));
      });

      var modelCard = h("div", { className: "ub-panel" },
        h("div", { className: "ub-panel-h" },
          h("div", { className: "ub-panel-t" }, "按模型"),
          h("div", { className: "ub-panel-x" }, "点行展开会话")),
        modelRows.length ? modelRows : h("div", { className: "ub-note" }, "该区间没有数据"));

      // token 总量 + 四桶
      var t = rangeData ? rangeData.tokens : null;
      var summaryCard = h("div", { className: "ub-panel" },
        h("div", { className: "ub-panel-h" },
          h("div", { className: "ub-panel-t" }, "区间汇总"),
          h("div", { className: "ub-panel-x" }, rangeData ? rangeData.sessions + " 会话" : "")),
        h("div", { style: { display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 } },
          h("div", { style: { fontSize: 26, fontWeight: 650, letterSpacing: ".2px" } }, rangeData ? fmt(t.total) : "—"),
          h("div", { style: { fontSize: 11, color: "var(--dsh-text-tertiary,#6b7280)" } }, "tokens")),
        h("div", { className: "ub-cards", style: { gridTemplateColumns: "repeat(auto-fit,minmax(96px,1fr))", marginBottom: 0 } },
          h(StatCard, { label: "未缓存输入", value: rangeData ? fmt(t.uncached) : "—" }),
          h(StatCard, { label: "输出", value: rangeData ? fmt(t.output) : "—" }),
          h(StatCard, { label: "缓存读", value: rangeData ? fmt(t.cacheRead) : "—" }),
          h(StatCard, { label: "缓存命中率", value: rangeData ? pct(rangeData.cacheHitRate) : "—" })));

      // 趋势
      var trendCard = h("div", { className: "ub-panel" },
        h("div", { className: "ub-panel-h" }, h("div", { className: "ub-panel-t" }, "近 14 天 Token")),
        h(Bars, {
          items: tokenTrend,
          valueOf: function (d) { return (d.tokens && d.tokens.total) || 0; },
          tip: function (d) { return fmt((d.tokens && d.tokens.total) || 0) + " · " + d.sessions + " 会话"; },
          maxLabel: fmt,
        }),
        h("div", { className: "ub-panel-h", style: { marginTop: 14 } }, h("div", { className: "ub-panel-t" }, "近 14 天花费（实付）")),
        h(Bars, {
          items: moneyTrend,
          money: true,
          valueOf: function (d) { return d.actualCost || 0; },
          tip: function (d) { return usd(d.actualCost) + " · " + (d.requests || 0) + " 请求"; },
          maxLabel: usd,
        }));

      // 金额明细
      // 关键：只要有上次成功的数据就继续显示，刷新失败只在右上角标注"更新中"，
      // 不再整块变成"取数失败"（面板接口偶尔慢是常态）。
      var stale = Boolean(pdata && pdata.stale);
      var moneyStatus = pdata
        ? (stale ? "更新中…" : "HotDogAPI")
        : perr
          ? "取数失败"
          : "加载中";
      var moneyCard = h("div", { className: "ub-panel" },
        h("div", { className: "ub-panel-h" },
          h("div", { className: "ub-panel-t" }, "面板金额"),
          h("div", { className: "ub-panel-x", style: stale ? { color: "#fbbf24" } : null }, moneyStatus)),
        !pdata
          ? (perr
              ? h("div", null,
                  h("div", { className: "ub-note", style: { color: "#f87171", marginBottom: 8 } }, perr),
                  h(PanelLogin, { initialEmail: knownEmail, onSuccess: afterLogin }))
              : h("div", { className: "ub-note" }, "加载中…"))
          : pdata.configured === false
            ? h(PanelLogin, { initialEmail: knownEmail, onSuccess: afterLogin })
            : !pdata.ok
              ? h("div", null,
                  h("div", { className: "ub-note", style: { color: "#f87171", marginBottom: 8 } },
                    (pdata.error || "取数失败") + (pdata.hint ? "（" + pdata.hint + "）" : "")),
                  loginOpen
                    ? h(PanelLogin, { initialEmail: knownEmail, onSuccess: function () { setLoginOpen(false); setMsg("已重新登录"); afterLogin(); }, onCancel: function () { setLoginOpen(false); } })
                    : h("div", { className: "ub-row2" },
                        h("button", { className: "ub-btn primary", onClick: function () { setLoginOpen(true); } }, "一键登录面板"),
                        h("button", {
                          className: "ub-btn",
                          onClick: function () { panel.refresh(); },
                        }, "重试取数")))
              : h("div", null,
                  h("div", { className: "ub-cards", style: { gridTemplateColumns: "repeat(auto-fit,minmax(96px,1fr))", marginBottom: 10 } },
                    h(StatCard, { label: "余额", value: usd(acc.balance), color: lowBalance ? "#fbbf24" : null }),
                    h(StatCard, { label: "今日实付", value: usd(today.actualCost) }),
                    h(StatCard, { label: "累计实付", value: usd(total.actualCost) }),
                    h(StatCard, { label: "dsh-hotdog 今日", value: usd(keyStats.todayActualCost) })),
                  h("div", { className: "ub-note" },
                    "今日原价 " + usd(today.cost) +
                    " · 倍率 " + (keyStats.multiplier == null ? "—" : "×" + keyStats.multiplier) +
                    " · 累计充值 " + usd(acc.totalRecharged) +
                    " · key 口径为最近明细近似" +
                    (stale ? " · 当前显示上次成功的数据，正在重试" : "")),
                  msg ? h("div", { className: "ub-msg ok", style: { marginTop: 8 } }, msg) : null,
                  loginOpen
                    ? h("div", { style: { marginTop: 10 } }, h(PanelLogin, {
                        initialEmail: knownEmail,
                        onSuccess: function () { setLoginOpen(false); setMsg("已重新登录"); afterLogin(); },
                        onCancel: function () { setLoginOpen(false); },
                      }))
                    : h("div", { className: "ub-row2", style: { marginTop: 10 } },
                        h("button", { className: "ub-btn", onClick: function () { setMsg(null); setLoginOpen(true); } }, "重新登录"),
                        h("button", {
                          className: "ub-btn",
                          onClick: function () {
                            fetch("/api/usage-board/panel/logout", { method: "POST" })
                              .then(function () { setMsg("已清除本地登录态"); panel.refresh(); })
                              .catch(function () {});
                          },
                        }, "退出登录"))));

      // 失败请求
      var errCard = null;
      if (edata && edata.ok) {
        var chips = (edata.byStatus || []).map(function (s) {
          var warn = Number(s.key) >= 500;
          return h("span", { key: s.key, className: "ub-chip" + (warn ? " warn" : "") }, s.key + " × " + s.count);
        });
        var rows = (edata.items || []).slice(0, 6).map(function (it, i) {
          return h("div", { key: i, className: "ub-session-row" },
            h("span", { style: { flexShrink: 0 } }, shortDate(it.at)),
            h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              it.model + " · " + (it.message || it.category || "")),
            h("span", { className: "ub-num", style: { color: Number(it.status) >= 500 ? "#fbbf24" : "var(--dsh-text-tertiary,#6b7280)" } }, String(it.status)));
        });
        errCard = h("div", { className: "ub-panel" },
          h("div", { className: "ub-panel-h" },
            h("div", { className: "ub-panel-t" }, "失败请求（近 7 天）"),
            h("div", { className: "ub-panel-x", style: { color: edata.total > 0 ? "#fbbf24" : "#4ade80" } }, edata.total + " 次")),
          h("div", { style: { marginBottom: 6 } }, chips),
          rows.length ? rows : h("div", { className: "ub-note" }, "近期没有失败请求"));
      }

      var foot = h("div", { className: "ub-foot" },
        "Token 数据来自 DSH 会话投影缓存（provider 上报值，模型归因为会话级）；金额与失败数据来自 HotDogAPI 面板（账号级，含所有 key）。",
        h("br", null),
        "余额低于阈值会同时变色并在后台发送系统通知（每 12 小时最多一次）。");

      return h("div", { className: "ub-wrap" },
        h("style", null, CSS),
        h("div", { className: "ub-head" },
          h("div", null,
            h("div", { className: "ub-title" }, "用量与额度"),
            h("div", { className: "ub-sub" }, "Token 统计 · 面板金额 · 失败请求"),
            ),
          h("div", { className: "ub-live" },
            h("span", { className: "ub-dot", style: { background: dot } }),
            uerr ? "取数异常" : "实时",
            data ? h("span", null, "· " + data.sessionCount + " 会话") : null)),
        cards,
        spendBanner,
        h(Segment, { value: range, onChange: function (r) { setRange(r); setExpanded(null); } }),
        h("div", { className: "ub-cols" },
          h("div", null, summaryCard, modelCard, errCard),
          h("div", null, moneyCard, trendCard)),
        foot);
    }

    // ─────────────────────────── 胶囊（极简快览） ───────────────────────────

    function QuickPopover() {
      var usage = usePollData(API + "?range=d1", POLL_MS);
      var panel = usePollData(API_PANEL, 60000);
      var errors = usePollData(API_ERRORS + "?days=7", 300000);

      var data = usage.data, uerr = usage.err;
      var pdata = panel.data;
      var edata = errors.data;
      var today = data && data.ranges ? data.ranges.d1 : null;
      var acc = (pdata && pdata.account) || {};
      var todayMoney = (pdata && pdata.today) || {};

      return h("div", { className: "ub-wrap ub-pop" },
        h("style", null, CSS),
        h("div", { className: "ub-pop-h" },
          h("div", { className: "ub-pop-v" }, today ? fmt(today.tokens.total) : "—"),
          h("div", { style: { fontSize: 11, color: "var(--dsh-text-tertiary,#6b7280)" } },
            "tokens · 今日 " + (today ? today.sessions : 0) + " 会话")),
        today ? h("div", { className: "ub-pop-grid" },
          h("div", { className: "ub-pop-cell" }, h("div", { className: "ub-pop-k" }, "未缓存输入"), h("div", { className: "ub-pop-v2" }, fmt(today.tokens.uncached))),
          h("div", { className: "ub-pop-cell" }, h("div", { className: "ub-pop-k" }, "输出"), h("div", { className: "ub-pop-v2" }, fmt(today.tokens.output))),
          h("div", { className: "ub-pop-cell" }, h("div", { className: "ub-pop-k" }, "缓存读"), h("div", { className: "ub-pop-v2" }, fmt(today.tokens.cacheRead))),
          h("div", { className: "ub-pop-cell" }, h("div", { className: "ub-pop-k" }, "命中率"), h("div", { className: "ub-pop-v2" }, pct(today.cacheHitRate)))
        ) : h("div", { className: "ub-note" }, uerr ? "取数异常：" + uerr : "加载中…"),
        pdata && pdata.ok ? h("div", { style: { fontSize: 11, color: "var(--dsh-text-secondary,#9aa0a6)", marginBottom: 8 } },
          "余额 " + usd(acc.balance) + " · 今日实付 " + usd(todayMoney.actualCost) +
          (acc.lowBalance ? " ⚠" : "")) : null,
        pdata && pdata.ok && pdata.guard && pdata.guard.exceeded
          ? h("div", { style: { fontSize: 11, color: "#f87171", marginBottom: 8 } },
              "⚠ 今日已实付 " + usd(pdata.guard.today) + "，超过护栏 " + usd(pdata.guard.threshold))
          : null,
        pdata && pdata.configured === false
          ? h("div", { style: { fontSize: 11, color: "#fbbf24", marginBottom: 8 } },
              "金额未启用 —— 到 设置 → 用量与额度 一键登录面板")
          : null,
        edata && edata.ok && edata.total > 0
          ? h("div", { style: { fontSize: 11, color: "#fbbf24", marginBottom: 8 } }, "近 7 天失败 " + edata.total + " 次")
          : null,
        h("div", { className: "ub-pop-foot" }, "完整看板在 设置 → 用量与额度"));
    }

    function UsageBoardCapsule() {
      var os = useState(false), open = os[0], setOpen = os[1];
      var ps = useState(null), pos = ps[0], setPos = ps[1];
      var btnRef = useRef(null);
      var wrapRef = useRef(null);

      var usage = usePollData(API + "?range=d1", POLL_MS);
      var panel = usePollData(API_PANEL, 60000);
      var data = usage.data;
      var pdata = panel.data;
      var today = data && data.ranges ? data.ranges.d1 : null;
      var low = Boolean(pdata && pdata.ok && pdata.account && pdata.account.lowBalance);
      var spendWarn = Boolean(pdata && pdata.ok && pdata.guard && pdata.guard.exceeded);

      useEffect(function () {
        if (!open) return;
        function onDown(ev) {
          if (wrapRef.current && wrapRef.current.contains(ev.target)) return;
          setOpen(false);
        }
        function onKey(ev) { if (ev.key === "Escape") setOpen(false); }
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return function () {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      function toggle() {
        if (!open && btnRef.current) {
          var r = btnRef.current.getBoundingClientRect();
          setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
        }
        setOpen(!open);
      }

      var dot = usage.err || spendWarn ? "#f87171" : low ? "#fbbf24" : "#4ade80";
      var label = (spendWarn ? "⚠ " : low ? "⚠ " : "") + (today ? fmt(today.tokens.total) : "—");

      return h("div", { ref: wrapRef, style: { position: "relative", display: "inline-flex", alignItems: "center" } },
        h("button", {
          ref: btnRef,
          onClick: toggle,
          title: spendWarn
            ? "今日花费超护栏：" + usd(pdata.guard.today) + "（阈值 " + usd(pdata.guard.threshold) + "）"
            : low
              ? "余额偏低：" + usd(pdata.account.balance)
              : "今日 Token 用量（完整看板在 设置 → 用量与额度）",
          style: {
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "2px 9px", height: 24, borderRadius: 12, cursor: "pointer",
            fontSize: 11, lineHeight: 1, whiteSpace: "nowrap", fontFamily: "inherit",
            color: open ? "#8fb8ff" : low ? "#fbbf24" : "var(--dsh-text-secondary,#9aa0a6)",
            background: open ? "rgba(110,168,254,.12)" : "transparent",
            border: "1px solid " + (open ? "rgba(110,168,254,.6)" : low ? "rgba(251,191,36,.5)" : "var(--dsh-border,rgba(255,255,255,.1))"),
          },
        },
          h("span", { style: { width: 6, height: 6, borderRadius: 3, background: dot, display: "inline-block" } }),
          h("span", null, label + " tok")),
        open ? h("div", {
          style: {
            position: "fixed", top: pos ? pos.top : 8, right: pos ? pos.right : 8, zIndex: 2147483000,
            background: "var(--dsh-bg-elevated,#1f2328)",
            border: "1px solid var(--dsh-border,rgba(255,255,255,.1))",
            borderRadius: 12, boxShadow: "0 14px 38px rgba(0,0,0,.5)",
            color: "var(--dsh-text-primary,#e6e6e6)",
          },
        }, h(QuickPopover, null)) : null);
    }

    // ─────────────────────────── 注册 ───────────────────────────

    function registerAll(ctx) {
      var slots = ctx && ctx.slots;
      if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return function () {};
      var disposers = [];

      disposers.push(slots.inject(CAPSULE_SLOT, function () {
        return slots.register({ name: CAPSULE_SLOT, id: "usage-board", order: 61 }, UsageBoardCapsule);
      }));

      try {
        disposers.push(slots.inject(SETTINGS_SLOT, function () {
          return slots.register(
            { name: SETTINGS_SLOT, id: "usage-board", order: 60, label: function () { return "用量与额度"; } },
            SettingsBoard,
          );
        }));
      } catch (e) {
        // 老版本 DSH 没有 settings.section，胶囊仍可用
      }

      return function () {
        disposers.forEach(function (d) { try { if (typeof d === "function") d(); } catch (e) { /* ignore */ } });
      };
    }

    return {
      name: "usage-board",
      inject: ["slots"],
      apply: function (ctx) {
        registerAll(ctx);
      },
    };
  },
});
