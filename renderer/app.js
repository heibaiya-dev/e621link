'use strict';

// 外壳界面：运行时间、一键启动、设置面板、窗口按钮。

const api = window.e621;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const el = {
  titlebar: $('#titlebar'),
  uptimeBig: $('#uptimeBig'),
  btnLaunch: $('#btnLaunch'),
  launchText: $('#launchText'),
  statusLine: $('#statusLine'),

  layer: $('#settingsLayer'),
  nav: $('#settingsNav'),
  btnSettings: $('#btnSettings'),
  btnSettingsClose: $('#btnSettingsClose'),

  stProxy: $('#stProxy'),
  stPort: $('#stPort'),
  stCa: $('#stCa'),
  stStats: $('#stStats'),
  btnCheck: $('#btnCheck'),
  btnStopProxy: $('#btnStopProxy'),
  checkOut: $('#checkOut'),

  swRewrite: $('#swRewrite'),
  swTrustCa: $('#swTrustCa'),
  swAutoStop: $('#swAutoStop'),
  btnShowCa: $('#btnShowCa'),
  btnUntrustCa: $('#btnUntrustCa'),

  swCache: $('#swCache'),
  cacheUsed: $('#cacheUsed'),
  cacheHits: $('#cacheHits'),
  cacheStores: $('#cacheStores'),
  inpCacheMB: $('#inpCacheMB'),
  btnCacheFolder: $('#btnCacheFolder'),
  btnCacheClear: $('#btnCacheClear'),
  swBlockAds: $('#swBlockAds'),
  blockCount: $('#blockCount'),
  blockTop: $('#blockTop'),
  swTrimJunk: $('#swTrimJunk'),
  trimCount: $('#trimCount'),

  swTray: $('#swTray'),

  useProxyRule: $('#useProxyRule'),
  btnCopyProxy: $('#btnCopyProxy'),

  logOut: $('#logOut'),
  btnClearLog: $('#btnClearLog'),

  themeSeg: $('#themeSeg'),
  swRemember: $('#swRemember'),
  swMax: $('#swMax'),
  inpW: $('#inpW'),
  inpH: $('#inpH'),
};

let settings = {};
let startedAt = 0;
let timerId = 0;
let busy = false;
let running = false;
let proxyRule = '';
let logLines = [];

// ───────────────────────── 运行时间 ─────────────────────────

const pad = (n) => String(n).padStart(2, '0');

function fmt(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function renderTime() {
  const text = startedAt ? fmt(Date.now() - startedAt) : '00:00:00';
  if (el.uptimeBig.textContent !== text) el.uptimeBig.textContent = text;
  el.uptimeBig.classList.toggle('running', !!startedAt);
}

function startTimer() {
  if (timerId) return;
  timerId = setInterval(renderTime, 500);
  renderTime();
}

function stopTimer() {
  if (!timerId) return;
  clearInterval(timerId);
  timerId = 0;
  renderTime();
}

// ───────────────────────── 主题 ─────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || 'system');
}

// ───────────────────────── 提示 ─────────────────────────

function setStatus(text, kind) {
  const t = (text || '').trim();
  el.statusLine.textContent = t;
  el.statusLine.hidden = !t;
  el.statusLine.classList.toggle('err', kind === 'err');
}

// ───────────────────────── 设置面板 ─────────────────────────

function openSettings(pane) {
  el.layer.hidden = false;
  if (pane) selectPane(pane);
  syncSettingsUI();
  refreshState();
  window.setTimeout(() => el.btnSettingsClose.focus(), 60);
}

function closeSettings() {
  if (el.layer.hidden) return;
  el.layer.hidden = true;
  el.btnSettings.focus();
}

function isSettingsOpen() {
  return !el.layer.hidden;
}

function selectPane(pane) {
  $$('#settingsNav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === pane));
}

function setSeg(container, value) {
  $$(`#${container.id} .seg-btn`).forEach((b) => {
    b.setAttribute('aria-checked', b.dataset.value === value ? 'true' : 'false');
  });
}

function setSwitch(node, on) {
  node.setAttribute('aria-checked', on ? 'true' : 'false');
}

function isOn(node) {
  return node.getAttribute('aria-checked') === 'true';
}

function syncSettingsUI() {
  setSeg(el.themeSeg, settings.theme);
  setSwitch(el.swRemember, settings.rememberWindow);
  setSwitch(el.swMax, settings.startMaximized);
  setSwitch(el.swRewrite, settings.rewriteImages !== false);
  setSwitch(el.swTrustCa, settings.trustCa !== false);
  setSwitch(el.swAutoStop, settings.autoStopOnQuit !== false);
  setSwitch(el.swCache, settings.useCache !== false);
  setSwitch(el.swBlockAds, settings.blockAds !== false);
  setSwitch(el.swTrimJunk, settings.trimJunk === true);
  setSwitch(el.swTray, settings.minimizeToTray !== false);

  el.inpW.value = settings.windowWidth;
  el.inpH.value = settings.windowHeight;
  el.inpCacheMB.value = settings.cacheMB;
  el.useProxyRule.textContent = proxyRule || '未启动。点一键启动之后这里会显示地址。';
}

async function persist(patch) {
  const r = await api.saveSettings(patch);
  if (!r.ok) {
    setStatus(r.error || '没存上', 'err');
    return false;
  }
  settings = { ...settings, ...r.settings };
  syncSettingsUI();
  return true;
}

// ───────────────────────── 一键启动 ─────────────────────────

function setBusy(on, text) {
  busy = on;
  el.btnLaunch.disabled = on;
  el.btnLaunch.classList.toggle('busy', on);
  el.btnLaunch.classList.toggle('stop', !on && running);
  el.launchText.textContent = on ? (text || '正在启动') : (running ? '停止代理' : '一键启动');
  el.btnLaunch.setAttribute('aria-label', running && !on ? '停止代理' : '一键启动');
}

async function launch() {
  if (busy) return;
  if (running) {
    await stopProxy();
    return;
  }

  setBusy(true, '正在启动');
  setStatus('');

  const r = await api.launch();

  if (r.ok) {
    startedAt = r.startedAt || Date.now();
    running = true;
    proxyRule = r.proxyRule || '';
    startTimer();
    setBusy(false);
    setStatus('代理启动成功UwU');

    if (r.previousEnabled && r.previousProxy) {
      setStatus(`启动成功！但是还有一个代理（${r.previousProxy}）已经被临时替换，关闭后自动复原ヾ(•ω•\`)o`);
      pushLogLine('原来的系统代理是 ' + r.previousProxy + '，已经临时换成本机代理qwq');
    }
    if (!r.trusted) {
      setStatus('启动成功，但是证书安装失败了qwq，请去设置尝试重装', 'err');
    }
    await refreshState();
    return;
  }

  setBusy(false);
  setStatus('错误，代理启动失败qwq：' + (r.error || '不知道什么原因'), 'err');
}

async function stopProxy() {
  setBusy(true, '正在停');
  const r = await api.stop();
  running = false;
  startedAt = 0;
  stopTimer();
  proxyRule = '';
  setBusy(false);
  if (r.restored) {
    setStatus(r.restoredTo ? `代理服务已停止awa。已恢复旧代理 ${r.restoredTo}。` : '代理服务已停止awa');
  } else {
    setStatus('代理服务已停止，但是旧代理还原失败', 'err');
  }
  await refreshState();
}

// ───────────────────────── 状态刷新 ─────────────────────────

async function refreshState() {
  const [s, c] = await Promise.all([api.proxy.state(), api.ca.state()]);

  // 只有真的在跑的时候才显示地址，没跑就显示提示语
  proxyRule = s.running && s.port ? `http=127.0.0.1:${s.port};https=127.0.0.1:${s.port}` : '';
  el.stProxy.textContent = s.running ? '已启动' : '未启动';
  el.stPort.textContent = s.running ? String(s.port) : '—';
  el.stCa.textContent = c.trusted ? '已经装进信任区' : '未安装';
  el.stStats.textContent = s.running
    ? `请求 ${s.stats.requests} 次，图片 ${s.stats.images} 次，改写页面 ${s.stats.rewritten} 次，出错 ${s.stats.errors} 次`
    : '—';

  el.useProxyRule.textContent = proxyRule || '未启动。点一键启动之后这里会显示地址。';

  // 缓存和拦截的数字
  const ex = s.extras || {};
  const cs = ex.cache || {};
  const bl = ex.blocker || {};

  const mb = (n) => (n < 1024 * 1024 ? Math.round(n / 1024) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB');

  el.cacheUsed.textContent = cs.maxBytes
    ? `${mb(cs.used || 0)} / ${mb(cs.maxBytes)}（${cs.percent || 0}%）`
    : '—';
  el.cacheHits.textContent = cs.hits ? `${cs.hits} 次，省了 ${mb(cs.bytesServed || 0)}` : '—';
  el.cacheStores.textContent = cs.stores ? `${cs.stores} 个文件` : '—';

  el.blockCount.textContent = bl.blocked ? `${bl.blocked} 次` : '—';
  el.blockTop.textContent = bl.top && bl.top.length
    ? bl.top.map((x) => `${x.host}（${x.n}）`).join('，')
    : '—';
  el.trimCount.textContent = bl.trimmed ? `${bl.trimmed} 次` : '—';
}

async function runCheck() {
  el.checkOut.hidden = false;
  el.checkOut.textContent = '正在连接…';
  el.checkOut.classList.remove('err');

  const r = await api.check();
  const lines = [];

  lines.push(r.main.ok
    ? `主站：通（${r.main.status}，${r.main.ms} 毫秒，握手 ${r.sni || '未知'}）`
    : `主站：不通qwq（${r.main.error || '状态码 ' + r.main.status}，${r.main.ms} 毫秒）`);

  lines.push(r.image.ok
    ? `图片服务器：通（${r.image.status}，${r.image.ms} 毫秒，${r.image.size} 字节）`
    : `图片服务器：不通qwq（${r.image.error || '状态码 ' + r.image.status}，${r.image.ms} 毫秒）`);

  lines.push('');
  lines.push(r.summary);

  el.checkOut.textContent = lines.join('\n');
  el.checkOut.classList.toggle('err', !r.main.ok);
}

// ───────────────────────── 日志 ─────────────────────────

function renderLog() {
  if (!logLines.length) {
    el.logOut.textContent = '还没有记录━━(￣ー￣*|||━━';
    return;
  }
  el.logOut.textContent = logLines.slice(-200).join('\n');
  el.logOut.scrollTop = el.logOut.scrollHeight;
}

function pushLogLine(text) {
  logLines.push(text);
  if (logLines.length > 400) logLines = logLines.slice(-400);
  if (!el.layer.hidden && $('.pane[data-pane="log"]').classList.contains('active')) renderLog();
}

// ───────────────────────── 事件接线 ─────────────────────────

function wireWindowButtons() {
  $('#btnMin').addEventListener('click', () => api.win.minimize());
  $('#btnMax').addEventListener('click', () => api.win.toggleMaximize());
  $('#btnClose').addEventListener('click', () => api.win.close());

  api.win.onState((s) => {
    const g = $('#maxGlyph');
    if (!g) return;
    g.innerHTML = s.maximized
      ? '<rect x=".5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5h5v-1h-5z" fill="currentColor"/>'
      : '<rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/>';
  });

  el.titlebar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    api.win.toggleMaximize();
  });
}

function wireSettings() {
  el.btnSettings.addEventListener('click', () => openSettings());
  el.btnSettingsClose.addEventListener('click', closeSettings);
  el.layer.addEventListener('click', (e) => {
    if (e.target === el.layer) closeSettings();
  });

  el.nav.addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (b) selectPane(b.dataset.pane);
  });

  // 连接
  el.btnCheck.addEventListener('click', runCheck);
  el.btnStopProxy.addEventListener('click', stopProxy);

  el.swRewrite.addEventListener('click', () => {
    const next = !isOn(el.swRewrite);
    setSwitch(el.swRewrite, next);
    persist({ rewriteImages: next });
  });

  el.swTrustCa.addEventListener('click', async () => {
    const next = !isOn(el.swTrustCa);
    setSwitch(el.swTrustCa, next);
    await persist({ trustCa: next });
    if (next) {
      const r = await api.ca.trust();
      if (!r.ok) setStatus('启动成功，但是证书安装失败了qwq，请去设置尝试重装', 'err');
    } else {
      await api.ca.untrust();
    }
    await refreshState();
  });

  el.swAutoStop.addEventListener('click', () => {
    const next = !isOn(el.swAutoStop);
    setSwitch(el.swAutoStop, next);
    persist({ autoStopOnQuit: next });
  });

  el.btnShowCa.addEventListener('click', () => api.ca.openFolder());
  el.btnUntrustCa.addEventListener('click', async () => {
    const r = await api.ca.untrust();
    setStatus(r.ok ? '证书已经删掉了。' : '没删掉，可能已经不在信任区里。');
    await refreshState();
  });

  // 加速：缓存
  el.swCache.addEventListener('click', () => {
    const next = !isOn(el.swCache);
    setSwitch(el.swCache, next);
    persist({ useCache: next });
  });

  el.inpCacheMB.addEventListener('change', () => {
    const v = Number(el.inpCacheMB.value);
    if (v) persist({ cacheMB: v });
    refreshState();
  });

  el.btnCacheFolder.addEventListener('click', () => api.cache.openFolder());
  el.btnCacheClear.addEventListener('click', async () => {
    await api.cache.clear();
    setStatus('缓存清空了。');
    await refreshState();
  });

  // 加速：广告拦截
  el.swBlockAds.addEventListener('click', () => {
    const next = !isOn(el.swBlockAds);
    setSwitch(el.swBlockAds, next);
    persist({ blockAds: next });
  });

  el.swTrimJunk.addEventListener('click', () => {
    const next = !isOn(el.swTrimJunk);
    setSwitch(el.swTrimJunk, next);
    persist({ trimJunk: next });
  });

  // 窗口：托盘
  el.swTray.addEventListener('click', () => {
    const next = !isOn(el.swTray);
    setSwitch(el.swTray, next);
    persist({ minimizeToTray: next });
  });

  // 怎么用
  el.btnCopyProxy.addEventListener('click', async () => {
    if (!proxyRule) {
      setStatus('未启动，没有地址可复制。');
      return;
    }
    await api.copy(proxyRule);
    el.btnCopyProxy.textContent = '已复制';
    window.setTimeout(() => { el.btnCopyProxy.textContent = '复制'; }, 1500);
  });

  // 日志
  el.btnClearLog.addEventListener('click', () => {
    logLines = [];
    renderLog();
  });

  // 主题
  el.themeSeg.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    setSeg(el.themeSeg, b.dataset.value);
    applyTheme(b.dataset.value);
    persist({ theme: b.dataset.value });
  });

  // 窗口
  el.swRemember.addEventListener('click', () => {
    const next = !isOn(el.swRemember);
    setSwitch(el.swRemember, next);
    persist({ rememberWindow: next });
  });

  el.swMax.addEventListener('click', () => {
    const next = !isOn(el.swMax);
    setSwitch(el.swMax, next);
    persist({ startMaximized: next });
  });

  const saveSize = () => {
    const w = Number(el.inpW.value);
    const h = Number(el.inpH.value);
    if (w && h) persist({ windowWidth: w, windowHeight: h });
  };
  el.inpW.addEventListener('change', saveSize);
  el.inpH.addEventListener('change', saveSize);
}

function wireKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isSettingsOpen()) {
        e.preventDefault();
        closeSettings();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      openSettings();
    }
    if (e.key === 'Enter' && !isSettingsOpen() && !busy) {
      const t = document.activeElement;
      if (t === document.body || t === el.btnLaunch) {
        e.preventDefault();
        launch();
      }
    }
  });
}

// ───────────────────────── 启动 ─────────────────────────

async function boot() {
  const info = await api.info();
  settings = { ...info.settings, _settingsFile: info.settingsFile };

  applyTheme(settings.theme);

  proxyRule = info.running && info.port ? `http=127.0.0.1:${info.port};https=127.0.0.1:${info.port}` : '';

  syncSettingsUI();
  renderTime();
  wireWindowButtons();
  el.btnLaunch.addEventListener('click', launch);
  wireSettings();
  wireKeys();

  if (info.running && info.startedAt) {
    startedAt = info.startedAt;
    running = true;
    startTimer();
    setBusy(false);
    setStatus('代理工作中');
  } else {
    setBusy(false);
  }

  api.onRunning((s) => {
    if (s.running && s.startedAt) {
      startedAt = s.startedAt;
      running = true;
      startTimer();
    } else if (!s.running) {
      startedAt = 0;
      running = false;
      stopTimer();
    }
    setBusy(false);
  });

  // 日志
  const old = await api.proxy.log();
  logLines = old.map((x) => x.text);
  renderLog();

  api.proxy.onLog((entry) => {
    pushLogLine(entry.text);
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'system') applyTheme('system');
  });
}

boot();
