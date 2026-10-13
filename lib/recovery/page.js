/**
 * The offline recovery page.
 *
 * A single self-contained HTML document: no bundler, no CDN, no framework. It
 * has to render in a browser opened by a plain Node process while DSH itself is
 * broken, so its only dependencies are the browser and the local JSON API.
 *
 * `__VG_TOKEN__` is replaced with the per-process request token when the page
 * is served; every mutating call echoes it back.
 */

export const RECOVERY_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 版本守卫 · 离线恢复</title>
<style>
  :root{
    --bg:#0e1116; --panel:#161b22; --panel2:#1c2230; --line:#2a3140;
    --fg:#e6edf3; --muted:#8b95a5; --accent:#4c8dff; --ok:#3fb950;
    --warn:#d29922; --bad:#f85149; --radius:10px;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:14px/1.55 "Segoe UI",-apple-system,"Microsoft YaHei",sans-serif}
  a{color:var(--accent)}
  code,kbd{font-family:"Cascadia Mono",Consolas,monospace;font-size:12px}
  header{position:sticky;top:0;z-index:20;background:rgba(14,17,22,.94);
    backdrop-filter:blur(8px);border-bottom:1px solid var(--line);
    padding:12px 18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
  header h1{font-size:16px;margin:0;font-weight:650;letter-spacing:.2px}
  .badge{font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);
    color:var(--muted);white-space:nowrap}
  .badge.offline{color:var(--warn);border-color:#5c4415;background:#2a2110}
  .badge.indsh{color:var(--ok);border-color:#1f4d2b;background:#12261a}
  .spacer{flex:1}
  main{padding:18px;max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
  section > h2{margin:0;padding:11px 14px;font-size:13px;font-weight:650;
    border-bottom:1px solid var(--line);background:var(--panel2);
    display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  section > h2 .count{color:var(--muted);font-weight:400}
  .body{padding:14px}
  button{font:inherit;color:var(--fg);background:#232b39;border:1px solid var(--line);
    border-radius:7px;padding:6px 11px;cursor:pointer}
  button:hover:not(:disabled){background:#2b3546;border-color:#3a465c}
  button:disabled{opacity:.45;cursor:not-allowed}
  button.primary{background:#1d4ed8;border-color:#2563eb}
  button.primary:hover:not(:disabled){background:#2563eb}
  button.danger{background:#3d1a1a;border-color:#6b2626;color:#ffb4ad}
  button.danger:hover:not(:disabled){background:#4d2020}
  button.ghost{background:transparent}
  button.small{padding:3px 8px;font-size:12px}
  select,input[type=text]{font:inherit;color:var(--fg);background:#0f1319;
    border:1px solid var(--line);border-radius:7px;padding:6px 9px}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .muted{color:var(--muted)}
  .banner{padding:11px 14px;border-radius:var(--radius);border:1px solid var(--line);
    background:var(--panel);display:flex;gap:12px;align-items:flex-start}
  .banner.bad{border-color:#6b2626;background:#241314}
  .banner.warn{border-color:#5c4415;background:#241d0e}
  .banner.ok{border-color:#1f4d2b;background:#0f2016}
  .banner .ic{font-size:17px;line-height:1.2}
  .banner strong{display:block;margin-bottom:2px}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
  tr:last-child td{border-bottom:none}
  tr.disabled-row{opacity:.62}
  .tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;
    border:1px solid var(--line);color:var(--muted);white-space:nowrap}
  .tag.enabled{color:var(--ok);border-color:#1f4d2b}
  .tag.disabled{color:var(--muted)}
  .tag.unknown{color:var(--warn);border-color:#5c4415}
  .tag.official{color:#7aa2f7}
  .tag.community{color:#c0a3ff}
  .ver{font-family:"Cascadia Mono",Consolas,monospace;font-size:12px}
  .ver b{color:var(--fg)}
  .ver s{color:var(--bad);text-decoration:line-through;opacity:.8}
  .log{white-space:pre-wrap;font-family:"Cascadia Mono",Consolas,monospace;font-size:12px;
    background:#0b0e13;border:1px solid var(--line);border-radius:8px;padding:10px;
    max-height:260px;overflow:auto;color:#c6d0dc}
  .empty{color:var(--muted);padding:10px 2px}
  dialog{background:var(--panel);color:var(--fg);border:1px solid var(--line);
    border-radius:12px;max-width:760px;width:calc(100vw - 40px);padding:0}
  dialog::backdrop{background:rgba(0,0,0,.6)}
  dialog .body{padding:14px;max-height:70vh;overflow:auto}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin-bottom:10px}
  .kv dt{color:var(--muted)}
  .kv dd{margin:0}
  .toast{position:fixed;right:16px;bottom:16px;z-index:50;display:flex;flex-direction:column;gap:8px}
  .toast div{background:var(--panel2);border:1px solid var(--line);border-left:3px solid var(--accent);
    border-radius:8px;padding:9px 13px;max-width:420px;box-shadow:0 8px 24px rgba(0,0,0,.45)}
  .toast div.err{border-left-color:var(--bad)}
  .toast div.ok{border-left-color:var(--ok)}
  .hint{font-size:12px;color:var(--muted)}
  .spin{display:inline-block;width:12px;height:12px;border:2px solid var(--muted);
    border-top-color:transparent;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px}
  @keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<header>
  <h1>🛡️ DSH 版本守卫</h1>
  <span class="badge" id="mode-badge">离线恢复页</span>
  <span class="badge" id="host-badge">—</span>
  <span class="spacer"></span>
  <label class="row muted" style="gap:6px" id="profile-picker">配置
    <select id="profile-select"></select>
  </label>
  <button id="btn-refresh" class="ghost">刷新</button>
</header>

<main>
  <div id="boot-banner"></div>

  <section>
    <h2>一键救援 <span class="hint">把配置退回最近一次成功启动的版本</span></h2>
    <div class="body">
      <p class="hint" style="margin-top:0">
        适用场景：装了新插件后 DSH 打不开、白屏或反复退出。救援只改配置文件（package.json、
        cordis.patch.yml、pnpm-lock.yaml），不动你的会话和密钥。
      </p>
      <div class="row">
        <button id="btn-rescue" class="primary">一键救援（退回到最近可用版本）</button>
        <button id="btn-rescue-dry">先看看会退回哪一版</button>
        <span id="rescue-status" class="hint"></span>
      </div>
      <div id="rescue-result" style="margin-top:12px"></div>
    </div>
  </section>

  <section>
    <h2>当前插件版本 <span class="count" id="plugin-count"></span></h2>
    <div class="body" style="padding:0">
      <table>
        <thead><tr>
          <th style="width:34%">插件</th><th style="width:22%">版本</th>
          <th style="width:12%">状态</th><th>说明</th><th style="width:150px">操作</th>
        </tr></thead>
        <tbody id="plugin-rows"></tbody>
      </table>
      <div id="plugin-empty" class="empty" hidden>没有读到插件。</div>
    </div>
  </section>

  <section>
    <h2>版本回退点 <span class="count" id="snapshot-count"></span>
      <span class="spacer"></span>
      <button id="btn-snapshot" class="small">立即记录当前版本</button>
    </h2>
    <div class="body" style="padding:0">
      <table>
        <thead><tr>
          <th style="width:20%">时间</th><th style="width:12%">类型</th>
          <th style="width:22%">当时版本</th><th>内容</th><th style="width:210px">操作</th>
        </tr></thead>
        <tbody id="snapshot-rows"></tbody>
      </table>
      <div id="snapshot-empty" class="empty" hidden>还没有任何回退点。成功启动一次 DSH 后会自动记录。</div>
    </div>
  </section>

  <section>
    <h2>运行日志</h2>
    <div class="body"><div id="log" class="log">等待操作…</div></div>
  </section>
</main>

<dialog id="confirm-dialog">
  <h2 style="margin:0;padding:11px 14px;font-size:13px;border-bottom:1px solid var(--line);background:var(--panel2)" id="confirm-title">确认</h2>
  <div class="body">
    <div id="confirm-text"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button id="confirm-cancel" class="ghost">取消</button>
      <button id="confirm-ok" class="danger">确认执行</button>
    </div>
  </div>
</dialog>

<div class="toast" id="toast"></div>

<script>
(function(){
  "use strict";
  var TOKEN = "__VG_TOKEN__";
  // Absolute mount prefix of the API: "" when this page is served by its own
  // process, "/dsh-version-guard" when served by the DSH host plugin. Absolute
  // so it cannot be re-based by the page's own URL.
  var API_BASE = "__VG_BASE__";
  var state = { profile: null, status: null, busy: false };
  // Embedded in the DSH settings pane (an iframe) rather than opened directly.
  var embedded = false;
  try { embedded = window.self !== window.top; } catch (e) { embedded = true; }

  function $(id){ return document.getElementById(id); }
  function esc(text){
    return String(text === null || text === undefined ? "" : text)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function logLine(text){
    var el = $("log");
    var stamp = new Date().toLocaleTimeString();
    el.textContent = "[" + stamp + "] " + text + "\\n" + el.textContent;
  }
  function toast(message, kind){
    var el = document.createElement("div");
    el.className = kind || "";
    el.textContent = message;
    $("toast").appendChild(el);
    setTimeout(function(){ el.remove(); }, 6000);
  }
  function setBusy(busy, label){
    state.busy = busy;
    ["btn-refresh","btn-rescue","btn-rescue-dry","btn-snapshot"].forEach(function(id){
      $(id).disabled = busy;
    });
    $("rescue-status").innerHTML = busy ? '<span class="spin"></span> ' + esc(label || "处理中…") : "";
    if (!busy) render();
  }

  function api(path, options){
    var opts = options || {};
    var init = { method: opts.method || "GET", cache: "no-store", headers: {} };
    if (init.method === "POST"){
      init.headers["content-type"] = "application/json";
      init.headers["x-version-guard-token"] = TOKEN;
      init.body = JSON.stringify(opts.body || {});
    }
    var suffix = "";
    if (state.profile && !opts.noProfile) suffix = (path.indexOf("?") >= 0 ? "&" : "?") + "profile=" + encodeURIComponent(state.profile);
    return fetch(API_BASE + path + suffix, init).then(function(res){
      return res.json().catch(function(){ return { ok:false, error:{ code:"http/bad-json", message:"响应不是 JSON" } }; });
    });
  }

  function requireOk(result, what){
    if (result && result.ok === true) return result.value;
    var error = (result && result.error) || { code:"unknown", message:"未知错误" };
    logLine("✗ " + what + " 失败：" + error.code + " — " + error.message);
    toast(what + "失败：" + error.message, "err");
    throw new Error(error.message);
  }

  function confirmDialog(title, html, onOk){
    $("confirm-title").textContent = title;
    $("confirm-text").innerHTML = html;
    var dialog = $("confirm-dialog");
    var ok = $("confirm-ok");
    var cancel = $("confirm-cancel");
    function cleanup(){ ok.removeEventListener("click", onOkClick); cancel.removeEventListener("click", onCancelClick); }
    function onOkClick(){ cleanup(); dialog.close(); onOk(); }
    function onCancelClick(){ cleanup(); dialog.close(); }
    ok.addEventListener("click", onOkClick);
    cancel.addEventListener("click", onCancelClick);
    dialog.showModal();
  }

  /* ---------- rendering ---------- */

  function renderBootBanner(status){
    var boot = status.boot || {};
    var host = $("host-badge");
    host.textContent = "profile: " + (status.paths.profileName || "?") + " · Node " + status.host.node;
    var el = $("boot-banner");
    var html = "";
    if (boot.crashLoop){
      html = '<div class="banner bad"><span class="ic">⛔</span><div>'
        + '<strong>检测到 DSH 连续启动失败 ' + boot.consecutiveFailures + ' 次</strong>'
        + '上一次启动没有走完就退出了，通常是某个插件导致的。建议先点上面的「一键救援」。'
        + (boot.lastFailedAt ? '<div class="hint">上次失败：' + esc(new Date(boot.lastFailedAt).toLocaleString()) + '</div>' : "")
        + '</div></div>';
    } else if (boot.unfinishedStart){
      html = '<div class="banner warn"><span class="ic">⚠️</span><div>'
        + '<strong>上一次启动未完成</strong>'
        + '这可能是正在运行的 DSH，也可能是它中途退出了。如果 DSH 打不开，请使用「一键救援」。'
        + '</div></div>';
    } else if (boot.lastCompletedAt){
      html = '<div class="banner ok"><span class="ic">✅</span><div>'
        + '<strong>最近一次启动正常</strong>'
        + esc(new Date(boot.lastCompletedAt).toLocaleString())
        + (boot.lastCompletedVersion ? ' · DSH ' + esc(boot.lastCompletedVersion) : "")
        + ' · 累计成功 ' + boot.totalCompleted + ' 次 / 尝试 ' + boot.totalAttempts + ' 次'
        + '</div></div>';
    } else {
      html = '<div class="banner"><span class="ic">ℹ️</span><div><strong>还没有启动记录</strong>'
        + '版本守卫会在 DSH 成功启动后自动记录一个回退点。</div></div>';
    }
    if (status.drift && status.drift.sinceNewestSnapshot){
      html += '<div class="banner warn" style="margin-top:10px"><span class="ic">🔀</span><div>'
        + '<strong>当前配置与最近的回退点不一致</strong>'
        + '说明装过或改过插件。若 DSH 现在不正常，回退到下面的任一回退点即可。'
        + '</div></div>';
    }
    el.innerHTML = html;
  }

  function versionCell(plugin){
    var installed = plugin.installed ? '<b>' + esc(plugin.installed) + '</b>' : '<span class="muted">未安装</span>';
    // A linked dependency has a location, not a version range; showing the
    // specifier would read as a version and look like a mismatch.
    var requested = plugin.requested
      ? (plugin.linked
        ? ' <span class="tag" title="' + esc(plugin.requested) + '">本地链接</span>'
        : ' <span class="muted">(' + esc(plugin.requested) + ')</span>')
      : "";
    var locked = plugin.locked && plugin.installed && plugin.locked !== plugin.installed
      ? ' <span class="tag" title="pnpm-lock.yaml 记录的版本">锁 ' + esc(plugin.locked) + '</span>' : "";
    return '<span class="ver">' + installed + requested + locked + '</span>';
  }

  function renderPlugins(status){
    var rows = ((status.profile && status.profile.plugins) || []).slice();
    var tbody = $("plugin-rows");
    $("plugin-count").textContent = rows.length ? "共 " + rows.length + " 项（" + status.profile.stats.enabled + " 启用 / " + status.profile.stats.disabled + " 停用）" : "";
    $("plugin-empty").hidden = rows.length > 0;
    // Problems first, so the likely culprit is at the top.
    rows.sort(function(a, b){
      var rank = function(row){ return row.issues.length > 0 ? 0 : row.state === "enabled" ? 1 : 2; };
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.name.localeCompare(b.name);
    });
    tbody.innerHTML = rows.map(function(plugin){
      var tags = '<span class="tag ' + esc(plugin.state) + '">'
        + (plugin.state === "enabled" ? "启用" : plugin.state === "disabled" ? "停用" : "未知") + '</span> '
        + '<span class="tag ' + esc(plugin.kind) + '">' + (plugin.kind === "official" ? "官方" : "社区") + '</span>'
        + (plugin.bundled ? ' <span class="tag" title="在 dsh.profile.bundles 中，会随启动加载">随启动</span>' : "");
      var notes = [];
      if (plugin.stateReason) notes.push(esc(plugin.stateReason));
      (plugin.issues || []).forEach(function(issue){ notes.push('<span style="color:var(--warn)">⚠ ' + esc(issue) + '</span>'); });
      if (plugin.cordisRows && plugin.cordisRows.length){
        notes.push('Cordis 行: ' + plugin.cordisRows.map(function(row){
          return esc(row.id) + (row.state === "disabled" ? "(停用)" : "");
        }).join(", "));
      }
      var actions = "";
      if (plugin.state === "enabled" || plugin.bundled){
        actions += '<button class="small danger" data-act="disable" data-name="' + esc(plugin.name) + '">停用</button> ';
      }
      if (plugin.disabledByGuard || plugin.state === "disabled"){
        var range = (plugin.disabledEntry && plugin.disabledEntry.requested) || plugin.installed || "^1.0.0";
        actions += '<button class="small" data-act="enable" data-name="' + esc(plugin.name) + '" data-range="' + esc(range) + '">恢复启用</button>';
      }
      if (plugin.installed && plugin.state !== "disabled"){
        actions += ' <button class="small ghost" data-act="pin" data-name="' + esc(plugin.name) + '" data-version="' + esc(plugin.installed) + '">锁定版本</button>';
      }
      return '<tr class="' + (plugin.state === "disabled" ? "disabled-row" : "") + '">'
        + '<td><code>' + esc(plugin.name) + '</code></td>'
        + '<td>' + versionCell(plugin) + '</td>'
        + '<td>' + tags + '</td>'
        + '<td>' + notes.join('<br>') + '</td>'
        + '<td>' + actions + '</td></tr>';
    }).join("");
  }

  var REASON_LABEL = {
    boot: "成功启动", manual: "手动记录", "pre-change": "改动前", "pre-restore": "回退前", recovery: "救援"
  };

  function renderSnapshots(status){
    var snaps = status.snapshots || [];
    $("snapshot-count").textContent = snaps.length ? "共 " + snaps.length + " 个" : "";
    $("snapshot-empty").hidden = snaps.length > 0;
    $("snapshot-rows").innerHTML = snaps.map(function(snap, index){
      var plugins = snap.pluginCount + " 个插件";
      var files = (snap.files || []).filter(function(file){ return !file.absent; }).map(function(file){ return file.path; });
      var current = index === 0 ? ' <span class="tag enabled">最新</span>' : "";
      var actions = '<button class="small primary" data-act="restore" data-id="' + esc(snap.id) + '">回退到此版本</button> '
        + '<button class="small ghost" data-act="diff" data-id="' + esc(snap.id) + '">对比</button> '
        + '<button class="small danger" data-act="delete" data-id="' + esc(snap.id) + '">删除</button>';
      return '<tr><td>' + esc(new Date(snap.createdAt).toLocaleString()) + current + '</td>'
        + '<td><span class="tag">' + esc(REASON_LABEL[snap.reason] || snap.reason) + '</span></td>'
        + '<td><span class="ver">' + plugins + (snap.dshVersion ? '<br><span class="muted">DSH ' + esc(snap.dshVersion) + '</span>' : "") + '</span></td>'
        + '<td class="hint">' + esc(files.join(", ")) + (snap.note ? '<br>' + esc(snap.note) : "") + '</td>'
        + '<td>' + actions + '</td></tr>';
    }).join("");
  }

  function render(){
    if (state.status) {
      renderBootBanner(state.status);
      renderPlugins(state.status);
      renderSnapshots(state.status);
    }
  }

  /* ---------- actions ---------- */

  function refresh(){
    setBusy(true, "读取配置…");
    return api("/api/bootstrap", { noProfile: true }).then(function(boot){
      var value = requireOk(boot, "读取");
      var select = $("profile-select");
      var profiles = value.profiles || [];
      if (select.options.length !== profiles.length){
        select.innerHTML = profiles.map(function(profile){
          return '<option value="' + esc(profile.name) + '">' + esc(profile.name)
            + (profile.snapshotCount ? " · " + profile.snapshotCount + " 个回退点" : " · 无回退点")
            + (profile.error ? " · ⚠ 读取失败" : "") + '</option>';
        }).join("");
      }
      if (!state.profile && profiles.length) state.profile = profiles[0].name;
      var badge = $("mode-badge");
      badge.textContent = value.inDsh ? "离线恢复页（由 DSH 内插件提供）" : "离线恢复页（独立进程，不依赖 DSH）";
      badge.className = "badge " + (value.inDsh ? "indsh" : "offline");
      if (embedded) {
        // Inside the settings pane the surrounding shell already names the
        // section and picks the profile, so a second header would just crowd it.
        $("profile-picker").hidden = true;
        document.querySelector("header h1").textContent = "🛡️ 版本守卫";
      }
      return api("/api/status");
    }).then(function(result){
      state.status = requireOk(result, "读取状态");
      logLine("✓ 已读取配置：" + state.status.paths.profileDir);
    }).catch(function(){ /* requireOk already reported */ })
      .then(function(){ setBusy(false); });
  }

  function doRescue(dryRun){
    setBusy(true, dryRun ? "正在计算…" : "正在救援…");
    api("/api/rescue", { method: "POST", body: { dryRun: !!dryRun } }).then(function(result){
      if (!result.ok){
        requireOk(result, "救援");
        return;
      }
      var value = result.value;
      if (dryRun){
        if (value.wouldRestore){
          var target = value.wouldRestore;
          $("rescue-result").innerHTML = '<div class="banner ok"><span class="ic">🎯</span><div>'
            + '<strong>将会回退到 ' + esc(REASON_LABEL[target.reason] || target.reason) + ' 版本</strong>'
            + esc(new Date(target.createdAt).toLocaleString()) + ' · ' + target.pluginCount + ' 个插件'
            + '</div></div>';
          logLine("· 预演：将回退到 " + target.id);
        } else {
          $("rescue-result").innerHTML = '<div class="banner ok"><span class="ic">✓</span><div>'
            + '<strong>无需救援</strong>' + esc(value.error || "当前配置与已知可用版本一致。") + '</div></div>';
        }
        return;
      }
      var result2 = value.result || {};
      var rows = ['<div class="banner ok"><span class="ic">✅</span><div><strong>救援完成</strong>'
        + '已回退到 ' + esc(value.target && value.target.id) + '</div></div>'];
      if (result2.restored && result2.restored.length){
        rows.push('<div class="hint" style="margin-top:8px">已写入：' + esc(result2.restored.join(", ")) + '</div>');
      }
      if (result2.removed && result2.removed.length){
        rows.push('<div class="hint">已移除：' + esc(result2.removed.join(", ")) + '</div>');
      }
      if (result2.installRequired){
        rows.push('<div class="banner warn" style="margin-top:10px"><span class="ic">📦</span><div>'
          + '<strong>还需要同步依赖（node_modules）</strong>'
          + '插件清单已改回旧版本，但已安装的文件需要 pnpm 同步一次。'
          + '<div class="row" style="margin-top:8px"><button id="btn-install" class="primary">立即同步依赖（pnpm install）</button></div>'
          + '</div></div>');
      }
      rows.push('<div class="hint" style="margin-top:8px">现在可以关闭本页并重新启动 DSH。</div>');
      $("rescue-result").innerHTML = rows.join("");
      var installButton = $("btn-install");
      if (installButton) installButton.addEventListener("click", doInstall);
      logLine("✓ 救援完成，回退到 " + (value.target && value.target.id));
      toast("救援完成，请重新启动 DSH", "ok");
    }).catch(function(){})
      .then(function(){ setBusy(false); });
  }

  function doInstall(){
    setBusy(true, "正在同步依赖（可能需要一分钟）…");
    logLine("· 开始 pnpm install …");
    api("/api/install", { method: "POST", body: { timeoutMs: 300000 } }).then(function(result){
      var value = requireOk(result, "同步依赖");
      logLine((value.ok ? "✓" : "✗") + " pnpm install 退出码 " + value.code + (value.timedOut ? "（超时）" : ""));
      logLine(value.log || "(无输出)");
      toast(value.ok ? "依赖同步完成" : "依赖同步失败，请查看日志", value.ok ? "ok" : "err");
    }).catch(function(){})
      .then(function(){ setBusy(false); });
  }

  function pluginAction(act, name, extra){
    if (act === "disable"){
      confirmDialog("停用插件", '<p>将从 <code>package.json</code> 的加载列表和依赖中移除 <code>' + esc(name) + '</code>。</p>'
        + '<p class="hint">下次启动 DSH 时它不会再加载。此操作前会自动记录一个回退点，可以随时「恢复启用」。</p>',
        function(){ runPlugin(act, name, extra); });
      return;
    }
    if (act === "enable"){
      runPlugin(act, name, extra);
      return;
    }
    if (act === "pin"){
      confirmDialog("锁定版本", '<p>把 <code>' + esc(name) + '</code> 的依赖锁定为精确版本 <code>' + esc(extra) + '</code>。</p>'
        + '<p class="hint">锁定后 pnpm 不会自动升到更新的版本。之后需要同步一次依赖。</p>',
        function(){ runPlugin(act, name, extra); });
    }
  }

  function runPlugin(act, name, extra){
    setBusy(true, "正在修改配置…");
    var body = { name: name };
    if (act === "enable") body.range = extra;
    if (act === "pin") body.version = extra;
    var endpoint = act === "pin" ? "/api/plugin/pin" : "/api/plugin/" + act;
    api(endpoint, { method: "POST", body: body }).then(function(result){
      var value = requireOk(result, act === "disable" ? "停用插件" : act === "enable" ? "恢复插件" : "锁定版本");
      logLine("✓ " + name + " → " + act + (value.changed ? "（已修改）" : "（无需修改）"));
      toast(name + (act === "disable" ? " 已停用" : act === "enable" ? " 已恢复启用" : " 已锁定版本"), "ok");
      return refresh();
    }).catch(function(){})
      .then(function(){ setBusy(false); });
  }

  function snapshotAction(act, id){
    if (act === "restore"){
      confirmDialog("回退到该版本", '<p>将把配置文件恢复到回退点 <code>' + esc(id) + '</code>。</p>'
        + '<p class="hint">回退前会自动记录当前状态，所以这一步本身也可以撤销。会话记录和密钥不受影响。</p>'
        + '<p class="hint">回退后如果插件版本有变化，还需要同步一次依赖。</p>',
        function(){ runSnapshot(act, id); });
      return;
    }
    if (act === "delete"){
      confirmDialog("删除回退点", '<p>删除 <code>' + esc(id) + '</code>？该版本将无法再恢复。</p>',
        function(){ runSnapshot(act, id); });
      return;
    }
    if (act === "diff") runSnapshot(act, id);
  }

  function runSnapshot(act, id){
    if (act === "diff"){
      setBusy(true, "正在对比…");
      api("/api/diff?id=" + encodeURIComponent(id)).then(function(result){
        var value = requireOk(result, "对比");
        var parts = [];
        if (value.identical){
          parts.push('<p>当前配置与该回退点<b>完全一致</b>。</p>');
        }
        if (value.pluginChanges && value.pluginChanges.length){
          parts.push('<h4 style="margin:12px 0 6px">插件变化</h4><table><thead><tr><th>插件</th><th>回退点</th><th>当前</th></tr></thead><tbody>'
            + value.pluginChanges.map(function(change){
              var fmt = function(row, extra){
                if (!row) return '<span class="muted">不存在</span>';
                return '<code>' + esc(row.name) + '</code><br><span class="ver">' + esc(row.installed || "未安装")
                  + ' <span class="muted">' + esc(row.requested || "") + '</span></span><br><span class="tag ' + esc(row.state) + '">'
                  + (row.state === "enabled" ? "启用" : row.state === "disabled" ? "停用" : "未知") + '</span>' + (extra || "");
              };
              return '<tr><td><span class="muted">' + esc(change.change) + '</span></td><td>' + fmt(change.snapshot)
                + '</td><td>' + fmt(change.live) + '</td></tr>';
            }).join("") + '</tbody></table>');
        }
        if (value.fileChanges && value.fileChanges.some(function(file){ return file.changed; })){
          parts.push('<h4 style="margin:12px 0 6px">文件变化</h4><ul class="hint">'
            + value.fileChanges.map(function(file){
              return '<li><code>' + esc(file.path) + '</code> — ' + (file.changed ? '<span style="color:var(--warn)">不同</span>' : "相同") + '</li>';
            }).join("") + '</ul>');
        }
        $("confirm-title").textContent = "对比 " + id;
        $("confirm-text").innerHTML = parts.join("");
        $("confirm-ok").style.display = "none";
        $("confirm-cancel").textContent = "关闭";
        $("confirm-dialog").showModal();
        $("confirm-cancel").addEventListener("click", function once(){
          $("confirm-cancel").removeEventListener("click", once);
          $("confirm-ok").style.display = "";
          $("confirm-cancel").textContent = "取消";
          $("confirm-dialog").close();
        });
      }).catch(function(){}).then(function(){ setBusy(false); });
      return;
    }
    setBusy(true, act === "restore" ? "正在回退…" : "正在删除…");
    var endpoint = act === "restore" ? "/api/restore" : "/api/delete";
    api(endpoint, { method: "POST", body: { id: id } }).then(function(result){
      var value = requireOk(result, act === "restore" ? "回退" : "删除");
      if (act === "restore"){
        logLine("✓ 已回退到 " + id + (value.restored ? "，写入 " + value.restored.join(", ") : ""));
        if (value.installRequired){
          toast("已回退，但还需要同步依赖（pnpm install）", "ok");
        } else {
          toast("已回退到该版本", "ok");
        }
      } else {
        logLine((value.deleted ? "✓ 已删除 " : "· 未找到 ") + id);
      }
      return refresh();
    }).catch(function(){})
      .then(function(){ setBusy(false); });
  }

  /* ---------- wiring ---------- */

  document.addEventListener("click", function(event){
    var button = event.target.closest("button[data-act]");
    if (!button) return;
    var act = button.getAttribute("data-act");
    if (act === "disable" || act === "enable" || act === "pin"){
      pluginAction(act, button.getAttribute("data-name"),
        act === "enable" ? button.getAttribute("data-range") : button.getAttribute("data-version"));
    } else {
      snapshotAction(act, button.getAttribute("data-id"));
    }
  });

  $("btn-refresh").addEventListener("click", refresh);
  $("btn-rescue").addEventListener("click", function(){
    confirmDialog("一键救援", '<p>将把配置回退到最近一次<b>成功启动</b>的版本。</p>'
      + '<p class="hint">只改 package.json / cordis.patch.yml / pnpm-lock.yaml。回退前会自动记录当前状态。'
      + '如果插件版本有变化，之后还需要同步一次依赖。</p>',
      function(){ doRescue(false); });
  });
  $("btn-rescue-dry").addEventListener("click", function(){ doRescue(true); });
  $("btn-snapshot").addEventListener("click", function(){
    setBusy(true, "正在记录…");
    api("/api/snapshot", { method: "POST", body: { note: "手动记录" } }).then(function(result){
      var value = requireOk(result, "记录快照");
      logLine("✓ 已记录回退点 " + value.id);
      toast("已记录当前版本", "ok");
      return refresh();
    }).catch(function(){}).then(function(){ setBusy(false); });
  });
  $("profile-select").addEventListener("change", function(event){
    state.profile = event.target.value;
    refresh();
  });

  refresh();
})();
</script>
</body>
</html>
`
