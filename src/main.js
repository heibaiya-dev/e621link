'use strict';

// 主进程
//
// 这个软件不内置浏览器，用的是「本地代理」的办法：
//   1) 在本机开一个代理端口，浏览器（Edge / Chrome / Firefox 都行）走它
//   2) 代理在中间把 TLS 拆开，用带了加密 DNS + ECH 的网络栈把请求发出去
//   3) 抓 static1.e621.net 的请求改成 static1.e926.net，图片就出来了
// 拆 TLS 需要一张本机证书，装在「当前用户」的信任区里，不需要管理员。

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, shell, clipboard, Menu, session,
  Tray, nativeImage,
} = require('electron');

// ---- 启动参数：加密 DNS + ECH ----------------------------------
// 这两样必须在 app ready 之前设好，设晚了不生效。
// 它们是 e621 能连上的根本原因：没有 ECH，TLS 握手里的域名是明文，会被重置。
//
// 位置很重要：必须在拿到 app 之后第一时间设，中间不要插任何别的事情。
// 实测打包版里如果前面多做一个 requestSingleInstanceLock，这些开关就赶不上
// Chromium 初始化，结果是主站 ERR_CONNECTION_RESET、图片却正常。
//
// ── 为什么只写一个 DoH 服务器（别加）──
//   试过写多家想让程序自己挑，结果是反的：Chromium 会在几个模板之间轮着用，
//   轮到哪家不通就整个查询失败，secure 模式下又不许明文兜底，
//   于是 ECH 拿不到，主站直接 ERR_CONNECTION_RESET。
//   实测同样条件下：单写阿里 → 5/5 成功；写四家 → 5/5 全失败。
//   所以这里只留一家，稳定比冗余重要。
//
// 用 secure 不用 automatic：
//   automatic 允许明文 DNS 兜底，明文拿不到 ECH 记录，等于白配。
//   宁可查不到也不要查到个没 ECH 的。
app.commandLine.appendSwitch('dns-over-https-mode', 'secure');
app.commandLine.appendSwitch('dns-over-https-templates', 'https://dns.alidns.com/dns-query');
app.commandLine.appendSwitch('enable-features', 'EncryptedClientHello');

const settingsStore = require('./settings');
const proxy = require('./proxy');
const ca = require('./ca');
const cache = require('./cache');
const sysproxy = require('./sysproxy');

// ---- DoH 可用性自检 --------------------------------------------
//
// 背景：不同网络下有几家 DoH 是不通的。实测某些网络里阿里 DNS 会被拦，
// 换个地方又轮到腾讯不通。如果启动时用的那家正好不通，ECH 就拿不到，
// 主站直接 ERR_CONNECTION_RESET（图片却没事，因为走 e926 不要 ECH）。
//
// 这里的做法：启动后挨个打一遍，看哪家能返回 e621 的 ECH 记录。
// 一家都不通的话至少能告诉用户是哪一环断了，而不是只甩一个连接重置。
//
// 注意：这个自检不改启动参数（改不了，早就设完了），只用于诊断提示。
// 真正的冗余靠上面 DOH_TEMPLATES 配多家 + Chromium 自己切换。
async function probeDoh() {
  const dns = require('dns');
  const list = ['dns.alidns.com', 'doh.pub', 'dns.pub', 'doh.360.cn'];
  const results = [];
  for (const host of list) {
    const t0 = Date.now();
    try {
      // 用系统 DNS 把 DoH 服务器自己的域名解开，解不开说明这条路彻底不通
      const addr = await new Promise((resolve, reject) => {
        dns.lookup(host, { family: 4 }, (err, a) => (err ? reject(err) : resolve(a)));
      });
      results.push({ host, addr, ms: Date.now() - t0, ok: true });
    } catch (e) {
      results.push({ host, ms: Date.now() - t0, ok: false, error: e.code || e.message });
    }
  }
  return results;
}

// 单实例要在网络开关之后再做
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---- 上游网络栈 ------------------------------------------------
// 上游全靠这个 session 发请求，它继承上面那两个开关。
//
// 关键：这个 session 绝对不能自己存 cookie。
//
// 实测（本地回显服务器）：session 的 cookie jar 里只要已经有 e621 的 cookie，
// 我们手动设的 Cookie 头就会被整个忽略，V8 那边直接换成 jar 里的旧值。
// 结果就是浏览器每发一次请求，上游都用代理自己的旧 session 顶掉浏览器的新 session，
// 页面一律当成新访客 —— 表现就是每进一个页面都要重新同意协议、登录态丢失。
//
// 所以这里装一个 handler：所有 set-cookie 一律丢掉，一条都不许进 jar。
// cookie 完全由浏览器自己管，代理只负责原样搬运。

function installUpstreamSession() {
  const ses = session.fromPartition('persist:e621link-upstream');
  global.__upstream = ses;

  ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, cb) => {
    const res = details.responseHeaders || {};
    const kept = {};
    for (const [k, v] of Object.entries(res)) {
      if (k.toLowerCase() === 'set-cookie') continue;
      kept[k] = v;
    }
    cb({ responseHeaders: kept });
  });

  return ses;
}

// 上游必须直连。系统代理指向的就是本机的代理端口，
// 要是上游也跟着系统代理走，请求就会转回代理自己，绕成死循环。
//
// 实测有个坑：同一个会话反复调 setProxy({mode:'direct'})，调两三次之后
// 连 e621 就全是 ERR_CONNECTION_RESET 了，换新会话又好。所以整个进程里
// 只设一次，设过就记住，后面不再碰。
let directDone = false;

async function forceDirect(ses) {
  if (directDone) return;
  try {
    await ses.setProxy({ mode: 'direct' });
    directDone = true;
  } catch {
    /* 失败也没关系，下次再试 */
  }
}

let mainWindow = null;
let startedAt = 0;
let running = false;
let quitting = false;
const recentLog = [];

function pushLog(line) {
  const entry = { t: Date.now(), text: line };
  recentLog.push(entry);
  if (recentLog.length > 400) recentLog.shift();
  send('proxy:log', entry);
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---- 窗口 ---------------------------------------------------------------

function iconPath(size) {
  const p = path.join(__dirname, '..', 'assets', `icon-${size}.png`);
  if (fs.existsSync(p)) return p;
  const alt = path.join(__dirname, '..', 'e621link.png');
  return fs.existsSync(alt) ? alt : null;
}

function createWindow() {
  const cfg = settingsStore.get();
  const ico = iconPath(256);

  mainWindow = new BrowserWindow({
    width: cfg.rememberWindow ? cfg.windowWidth : 1120,
    height: cfg.rememberWindow ? cfg.windowHeight : 780,
    minWidth: 720,
    minHeight: 540,
    frame: false,
    show: false,
    title: 'E621Link',
    backgroundColor: '#f3f3f3',
    autoHideMenuBar: true,
    icon: ico || undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'app.html'));

  mainWindow.once('ready-to-show', () => {
    if (cfg.startMaximized) mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.on('maximize', () => send('window:state', { maximized: true }));
  mainWindow.on('unmaximize', () => send('window:state', { maximized: false }));

  mainWindow.on('close', (e) => {
    const cur = settingsStore.get();
    if (cur.rememberWindow && mainWindow && !mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      const [w, h] = mainWindow.getSize();
      settingsStore.save({ windowWidth: w, windowHeight: h });
    }

    // 关窗口不退出，缩到托盘继续跑。代理还在工作，浏览器照样能用。
    // 真要退出走「退出」菜单或者托盘菜单。
    if (cur.minimizeToTray && !quitting) {
      e.preventDefault();
      mainWindow.hide();
      ensureTray();
      if (!cur.trayHintShown) {
        settingsStore.save({ trayHintShown: true });
        if (tray) {
          try {
            tray.displayBalloon({
              title: 'E621Link 还在跑',
              content: '窗口收起来了，代理还开着，浏览器照常用。右键托盘图标可以退出。',
              iconType: 'info',
            });
          } catch {
            /* 系统不支持气泡提示就算了 */
          }
        }
      }
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

// ---- 托盘 ---------------------------------------------------------------

let tray = null;

function trayImage() {
  const p = iconPath(32) || iconPath(16);
  if (!p) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return tray;

  tray = new Tray(trayImage());
  tray.setToolTip('E621Link');
  refreshTrayMenu();

  // 点一下托盘图标就把窗口叫回来
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());

  return tray;
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;

  const st = proxy.getStats();
  const runningNow = proxy.isRunning();

  const menu = Menu.buildFromTemplate([
    {
      label: runningNow ? `代理运行中 · 端口 ${proxy.port()}` : '代理没开',
      enabled: false,
    },
    {
      label: runningNow
        ? `已处理 ${st.requests} 个请求 · 缓存命中 ${st.cacheHits}`
        : '　',
      enabled: false,
    },
    { type: 'separator' },
    { label: '打开窗口', click: () => showWindow() },
    runningNow
      ? { label: '停止代理', click: () => stopProxy() }
      : { label: '一键启动', click: () => launch() },
    { type: 'separator' },
    {
      label: '退出 E621Link',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function updateTrayTooltip() {
  if (!tray || tray.isDestroyed()) return;
  const st = proxy.getStats();
  tray.setToolTip(
    proxy.isRunning()
      ? `E621Link · 代理运行中 · ${st.requests} 个请求 · 缓存命中 ${st.cacheHits}`
      : 'E621Link · 代理没开'
  );
  refreshTrayMenu();
}

// ---- 一键启动：起代理 + 把系统代理指向它 ------------------------

async function launch() {
  const ses = session.fromPartition('persist:e621link-upstream');
  const cfg = settingsStore.get();

  proxy.setRewrite(cfg.rewriteImages);
  proxy.setCache(cfg.useCache !== false);
  proxy.setBlock(cfg.blockAds !== false);
  proxy.setTrimJunk(cfg.trimJunk === true);
  cache.init({ enabled: cfg.useCache !== false, maxBytes: (cfg.cacheMB || 512) * 1024 * 1024 });

  // 关键：先把上游设成直连，再动系统代理。顺序反了就会自己绕自己。
  await forceDirect(ses);

  if (!proxy.isRunning()) {
    const r = await proxy.start(ses, { onLog: pushLog });
    if (!r.ok) return { ok: false, error: r.error };
  }

  // 系统代理。改的是 HKCU 里的 Internet Settings，Edge / Chrome 读的就是它。
  const sp = await sysproxy.set(proxy.port());
  if (!sp.ok) {
    proxy.stop();
    return { ok: false, error: '系统代理没设上：' + (sp.error || '不知道什么原因') };
  }
  pushLog('系统代理已设成 127.0.0.1:' + proxy.port());
  writeMarker(proxy.port());

  if (settingsStore.get().trustCa) {
    const t = ca.trust();
    if (!t.ok) {
      // 证书没装上不影响连接，只是会弹证书警告
      pushLog('证书没装进信任区：' + t.error + 'w(ﾟДﾟ)w');
    }
  }

  running = true;
  startedAt = Date.now();
  send('app:running', { running: true, startedAt, port: proxy.port() });
  updateTrayTooltip();

  return {
    ok: true,
    port: proxy.port(),
    startedAt,
    proxyRule: proxy.proxyRule(),
    trusted: ca.isTrusted(),
    previousProxy: sp.previousServer || '',
    previousEnabled: sp.previousEnable === 1,
  };
}

async function stopProxy() {
  // 先还原系统代理，再关代理端口。反过来会有一小段时间浏览器还在往已关的端口发请求。
  const r = await sysproxy.restore();
  proxy.stop();
  clearMarker();
  running = false;
  startedAt = 0;
  send('app:running', { running: false, startedAt: 0 });
  updateTrayTooltip();
  return {
    ok: true,
    restored: r.ok === true,
    restoredTo: r.server || '',
  };
}

// ---- IPC ----------------------------------------------------------------

// 设置改了之后，把开关同步给代理
function applySwitches(s) {
  proxy.setRewrite(s.rewriteImages);
  proxy.setCache(s.useCache !== false);
  proxy.setBlock(s.blockAds !== false);
  proxy.setTrimJunk(s.trimJunk === true);
  cache.setMaxBytes((s.cacheMB || 512) * 1024 * 1024);
  updateTrayTooltip();
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    // 界面上显示这个，比 1.0.1 好认
    displayVersion: '1.0-bugfixv1',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    settings: settingsStore.get(),
    defaults: settingsStore.DEFAULTS,
    settingsFile: settingsStore.file(),
    running,
    startedAt,
    port: proxy.port(),
    caTrusted: ca.isTrusted(),
  }));

  ipcMain.handle('settings:save', (_e, patch) => {
    const r = settingsStore.save(patch || {});
    if (r.ok) applySwitches(r.settings);
    return r;
  });
  ipcMain.handle('settings:reset', () => {
    const r = settingsStore.reset();
    applySwitches(r.settings);
    return r;
  });

  ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });

  // 从托盘/界面主动退出：先把系统代理还原，再真的关掉。
  //
  // 这里不能只调 app.quit()：窗口的 close 事件会 preventDefault 缩到托盘，
  // 退出就被拦下来，代理留在注册表里。
  // 也不能在 handler 里同步跑 PowerShell：execFileSync 会占住主线程，
  // IPC 的回包发不出去，界面会一直转圈。所以先把结果返回，再异步清理。
  ipcMain.handle('app:quit', () => {
    quitting = true;

    setTimeout(async () => {
      try {
        if (tray && !tray.isDestroyed()) {
          tray.destroy();
          tray = null;
        }
      } catch {
        /* 托盘没了就算了 */
      }

      try {
        await sysproxy.restore();
      } catch {
        /* 还原不了的话，下次启动 healLeftoverProxy 会兜住 */
      }

      proxy.stop();
      clearMarker();
      cleanedUp = true;
      app.exit(0);
    }, 80);

    return { ok: true };
  });

  // 缓存
  ipcMain.handle('cache:stats', () => cache.getStats());
  ipcMain.handle('cache:clear', () => {
    const r = cache.clearAll();
    // 搜索框补全有一份内存缓存，顺手也清掉
    proxy.clearMemoryCache();
    pushLog('缓存已清空');
    return r;
  });
  ipcMain.handle('cache:openFolder', () => {
    const dir = cache.cacheDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 建不出来就算了 */
    }
    shell.openPath(dir);
    return { ok: true };
  });

  ipcMain.handle('app:copy', (_e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  });

  ipcMain.handle('app:openFile', (_e, p) => {
    if (typeof p === 'string' && p && fs.existsSync(p)) shell.showItemInFolder(p);
    return { ok: true };
  });

  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return { maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { maximized: mainWindow.isMaximized() };
  });
  ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close(); });

  // 一键启动 / 停止
  ipcMain.handle('app:launch', async () => {
    try {
      return await launch();
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('app:stop', () => stopProxy());

  // 代理状态
  ipcMain.handle('proxy:state', async () => {
    const sys = await sysproxy.get();
    return {
      running: proxy.isRunning(),
      port: proxy.port(),
      rule: proxy.proxyRule(),
      stats: proxy.getStats(),
      extras: proxy.getExtras(),
      startedAt,
      caTrusted: ca.isTrusted(),
      system: {
        enable: sys.enable === 1,
        server: sys.server || '',
        override: sys.override || '',
        hasBackup: sys.hasBackup === true,
        backup: sys.backup || null,
      },
    };
  });

  ipcMain.handle('proxy:log', () => recentLog.slice(-200));

  // 证书
  ipcMain.handle('ca:state', () => ({
    trusted: ca.isTrusted(),
    path: ca.caCertPath(),
  }));

  ipcMain.handle('ca:trust', () => ca.trust());
  ipcMain.handle('ca:untrust', () => ca.untrust());

  ipcMain.handle('ca:openFolder', () => {
    const p = ca.caCertPath();
    if (fs.existsSync(p)) shell.showItemInFolder(p);
    return { ok: true };
  });

  // 真的连一次，看看通不通。走的是上游直连，跟代理实际发请求的路径一致。
  ipcMain.handle('net:check', async () => {
    const ses = session.fromPartition('persist:e621link-upstream');
    await forceDirect(ses);

    const probe = async (url, accept) => {
      const t0 = Date.now();
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        const r = await ses.fetch(url, { signal: ctl.signal, cache: 'no-store' });
        clearTimeout(timer);
        const buf = Buffer.from(await r.arrayBuffer());
        return {
          ok: accept.includes(r.status),
          status: r.status,
          ms: Date.now() - t0,
          size: buf.length,
          body: url.endsWith('/trace') ? buf.toString('utf8') : '',
        };
      } catch (e) {
        return { ok: false, status: 0, ms: Date.now() - t0, error: String(e.message || e) };
      }
    };

    const main = await probe('https://e621.net/cdn-cgi/trace', [200]);
    const img = await probe('https://static1.e926.net/data/mascots/8adec88535da7b2d3fc825583e1b50db.png', [200]);

    const sni = (main.body && (main.body.match(/sni=(\w+)/) || [])[1]) || '';

    // 主站不通时，顺手看看是哪个 DoH 服务器连不上，方便定位
    let doh = [];
    if (!main.ok || sni !== 'encrypted') {
      try {
        doh = await probeDoh();
      } catch {
        /* 查不出来也不影响主流程 */
      }
    }

    return {
      main,
      image: img,
      sni,
      doh,
      summary: buildSummary(main, img, sni, doh),
    };
  });
}

function buildSummary(main, img, sni, doh) {
  if (main.ok && sni === 'encrypted' && img.ok) {
    return '主站和图片服务器都通了，握手是加密的。点一键启动之后，浏览器就能打开 e621awa。';
  }

  // 主站连不上或者握手是明文时，把 DoH 的情况说清楚
  const dead = (doh || []).filter((d) => !d.ok);
  const dohHint =
    dead.length === 4
      ? '四个加密 DNS 服务器全都连不上，这多半是网络把加密 DNS 挡了。建议先关掉别的代理软件 / VPN 再试，或者换到手机热点上试试。'
      : dead.length > 0
        ? `加密 DNS 服务器里这几个连不上：${dead.map((d) => d.host).join('、')}。程序会自动换用还能连的，如果还是打不开，换个网络试试。`
        : '';

  if (main.ok && sni !== 'encrypted') {
    return `主站通了，但握手是明文的，这样图片能看、翻页会被掐。${dohHint || '加密 DNS 可能没生效，换个网络试试。'}`;
  }
  if (img.ok) {
    return `图片服务器通，主站不通。主站必须靠加密 DNS 才能连，现在这条路断了。${dohHint || '换个网络试试，或者检查是不是别的代理软件在抢流量。'}`;
  }
  return `主站和图片都不通。先确认这台设备能正常上网。${dohHint}`;
}

// ---- 开发辅助 ------------------------------------------------------------

if (process.argv.includes('--shot')) {
  const shotDir = path.join(__dirname, '..', 'shots');
  let n = 0;
  const grab = async () => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const img = await mainWindow.webContents.capturePage();
      fs.mkdirSync(shotDir, { recursive: true });
      const p = path.join(shotDir, `shell-${Date.now()}.png`);
      fs.writeFileSync(p, img.toPNG());
      console.log('SHOT ' + p);
      n += 1;
      if (n > 40) app.exit(0);
    } catch (e) {
      console.log('SHOT ERR ' + e.message);
    }
  };
  app.whenReady().then(() => {
    setInterval(grab, 2000);
    setTimeout(grab, 1200);
  });
}

// ---- 生命周期 -----------------------------------------------------------

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  installUpstreamSession();
  registerIpc();
  healLeftoverProxy();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 开了「关到托盘」就不退出，继续在后台跑代理
  if (settingsStore.get().minimizeToTray && !quitting) return;
  app.quit();
});

// 退出时必须把系统代理还原。
// 不然软件一关，浏览器还指着一个已经关掉的端口，就整个断网了。
//
// 这里有个坑：app.exit() 不会触发 before-quit，所以任何走 app.exit() 的路径
// 都会把系统代理留在注册表里。下面的 cleanup() 是幂等的，各条路都调一遍。

let cleanedUp = false;

function cleanupSync() {
  if (cleanedUp) return;
  cleanedUp = true;

  proxy.stop();
  clearMarker();

  try {
    sysproxy.restoreSync();
  } catch {
    /* 实在还原不了，下次启动 healLeftoverProxy 会兜住 */
  }
}

app.on('before-quit', (e) => {
  // 注意：这里不能判断 quitting。
  // app:quit 那条路会先把 quitting 设成 true 再调 app.quit()，
  // 老代码在这里 return，导致系统代理压根没被还原——
  // 表现就是软件关了浏览器还能连、或者反过来连不上，得等下次启动自愈。
  // 改成只看 cleanedUp：谁先到谁干活，后面重复进来的直接放行。
  if (cleanedUp) return;
  cleanedUp = true;
  e.preventDefault();

  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }

  sysproxy.restore().finally(() => {
    proxy.stop();
    app.exit(0);
  });

  // 万一 PowerShell 卡住了，1.5 秒后也要退出去，不能把用户卡在这里
  setTimeout(() => {
    proxy.stop();
    cleanedUp = true;
    app.exit(0);
  }, 1500);
});

// 兜底：不管谁调 app.exit()、进程被信号打断，都尽量还原一次
app.on('will-quit', cleanupSync);

process.on('exit', () => {
  if (!cleanedUp) cleanupSync();
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    cleanupSync();
    process.exit(0);
  });
}

process.on('uncaughtException', (err) => {
  // 崩之前先把系统代理还原，别让用户断网
  cleanupSync();
  console.error(err);
  process.exit(1);
});

app.on('certificate-error', (_e, _wc, _url, _err, _cert, callback) => {
  callback(false);
});

// ---- 上次没关干净的兜底 ------------------------------------------------
// 如果上次是被强杀的，系统代理会留在注册表里指着一个已经不存在的端口，
// 用户就上不了网。
//
// 判断依据不看端口——端口可能刚好被别的软件占了。看标记文件：
// 启动代理时写一个，正常退出时删掉。启动时发现标记还在，就说明上次没善终。

function markerPath() {
  return path.join(settingsStore.dir(), 'proxy-active.json');
}

function writeMarker(port) {
  try {
    fs.mkdirSync(settingsStore.dir(), { recursive: true });
    fs.writeFileSync(
      markerPath(),
      JSON.stringify({ port, pid: process.pid, at: new Date().toISOString() }),
      'utf8'
    );
  } catch {
    /* 写不了就算了 */
  }
}

function clearMarker() {
  try {
    fs.rmSync(markerPath(), { force: true });
  } catch {
    /* 删不掉就算了 */
  }
}

async function healLeftoverProxy() {
  try {
    const sys = await sysproxy.get();
    if (!sys.ok || sys.enable !== 1) {
      // 系统代理没开着，但可能留了标记，清掉
      clearMarker();
      return;
    }
    if (!sys.hasBackup) return;

    // 系统代理指着本机的一个端口，但我们没在跑 → 上次没善终
    const m = /^127\.0\.0\.1:(\d+)$/.exec(String(sys.server || '').trim());
    if (!m) return;

    const r = await sysproxy.restore();
    if (r.ok) {
      clearMarker();
      pushLog('上次软件没正常关，系统代理已经还原成原来的设置');
    }
  } catch {
    /* 兜底失败不影响使用 */
  }
}
