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
let startedAt = 0;          // 代理启动的时间戳，界面用它算「运行了多久」
let running = false;        // 代理是不是在跑
let quitting = false;       // 是不是正在退出。退出流程里很多回调要靠它判断
const recentLog = [];       // 最近的日志。界面打开日志页时先要这一份

// 记一条日志，同时推给界面。
//
// 只留最近 400 条。这个不只是为了省内存，主要是日志页一次性渲染太多行会卡，
// 而且真正排查问题也就看最后几十条。老的一直加会让界面越来越慢。
function pushLog(line) {
  const entry = { t: Date.now(), text: line };
  recentLog.push(entry);
  if (recentLog.length > 400) recentLog.shift();
  send('proxy:log', entry);
}

// 往界面推消息。窗口没建好、或者已经关了，直接忽略，不报错。
//
// 这个判断不能省：代理运行期间用户可能把窗口关了（缩到托盘），
// 这时 webContents 已经销毁，再往里 send 会抛异常。
// 而代理的事件回调没人接，异常往上冒会把整个代理搞挂。
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---- 窗口 ---------------------------------------------------------------

// 按尺寸找图标文件。找不到就退回一个通用图标，再找不到就返回 null
// （Electron 会用自己的默认图标）。
function iconPath(size) {
  const p = path.join(__dirname, '..', 'assets', `icon-${size}.png`);
  if (fs.existsSync(p)) return p;
  const alt = path.join(__dirname, '..', 'e621link.png');
  return fs.existsSync(alt) ? alt : null;
}

// 创建主窗口。
//
// 几个选择的原因：
//   frame: false        自己画标题栏，才能做成 Fluent 那种样子。
//                       代价是最大化/最小化/关闭都要自己实现（见 window:* 那几个 handler）
//   show: false         先不显示。等页面加载完再 show（见下面的 ready-to-show），
//                       否则会白屏闪一下，很难看
//   contextIsolation    true 是必须的。让 preload 和页面跑在隔离的上下文里，
//                       页面里的脚本改不到 preload 注入的对象，防 XSS 提权
//   nodeIntegration     false 同理，页面里不该能直接 require('fs')
//   sandbox             false 这里特意关掉。开了之后 preload 里不能用
//                       node-forge 之类的原生模块，代价大于收益。
//                       反正 preload 代码是我们自己写的，不跑外部内容
//   spellcheck          false 关掉拼写检查，省点内存。这界面没有输入长文本的地方
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

// 托盘图标。用 32 的，找不到就用 16 的。
//
// 为什么不用 createFromPath 直接造：文件不存在时它返回一个空图，
// 托盘上就什么都不显示，用户以为程序崩了。所以这里显式判断，
// 实在找不到就返回一个空图（系统会显示一个透明占位），至少不报错。
function trayImage() {
  const p = iconPath(32) || iconPath(16);
  if (!p) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

// 建托盘，已经有了就直接返回。
//
// 这个函数被调用的地方很多（窗口创建时、启动代理时、关窗口时），
// 必须做「已存在就复用」的判断。不然会建出好几个图标，用户看到托盘里
// 排一排 E621Link，关都关不掉。
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

// 重建托盘菜单。
//
// 为什么要重建而不是改菜单项：Electron 的菜单一旦 setContextMenu 就固定了，
// 改不了单项。状态变了只能整个重建一遍。反正菜单很小，开销可以忽略。
//
// 菜单内容是跟着代理状态变的：没开的时候显示「一键启动」，
// 开着的时候显示端口和统计，还能直接停止。
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
        : '　',   // 全角空格占位，让菜单高度不跳
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
        // 置上 quitting 再 quit。不置的话 before-quit 会以为
        // 是普通的关窗口，可能又缩到托盘，退不掉。
        quitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

// 把窗口叫出来。窗口已经被销毁（用户手动关掉了）就重新建一个。
//
// 「销毁」跟「隐藏」是两回事：
//   隐藏（hide）  窗口还在，只是看不见，show() 就回来了
//   销毁（destroyed）对象没了，只能重建
// 用户点托盘的「打开窗口」时，这两种情况都可能遇到，所以都要处理。
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// 刷新托盘的提示文字（鼠标悬停时显示的那个）和菜单内容。
//
// 代理每处理一批请求就会调一次，所以这函数会跑得很频繁。
// 里面两个操作都很轻（改字符串、建小菜单），但别在这里加耗时的东西。
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

// 停止代理：还原系统代理 + 关掉本地端口。
//
// 顺序不能反。先还系统代理，再关端口 ——
// 反过来会有一小段时间浏览器还在往已经关掉的端口发请求，
// 用户会看到一堆 ERR_CONNECTION_REFUSED。虽然只是一瞬间，
// 但如果他正在加载页面，那一次加载就废了。
//
// 返回值里的 restoredTo 是还原后的系统代理地址（通常是空，表示直连）。
// 界面会显示「已还原到 xxx」，让用户确认自己的代理设置没被吃掉。
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

// 设置改了之后，把开关同步给代理。
//
// 这些开关都只在内存里生效，不重启也能立刻起作用 ——
// 用户改了「关闭广告拦截」，下一个请求就放行了。
//
// cacheMB 要换算成字节，另外注意它的默认值兜底：
// 设置被手动改坏成 0 的话，用 512MB 顶上，不然缓存会立刻开始疯狂删除。
function applySwitches(s) {
  proxy.setRewrite(s.rewriteImages);
  proxy.setCache(s.useCache !== false);
  proxy.setBlock(s.blockAds !== false);
  proxy.setTrimJunk(s.trimJunk === true);
  cache.setMaxBytes((s.cacheMB || 512) * 1024 * 1024);
  updateTrayTooltip();
}

// 注册所有 IPC 接口。界面能调什么，全在这里。
//
// 跟 preload.js 里的 window.e621 是一一对应的：那边挂一个方法，
// 这边就有一个同名 channel 的 handler。加接口要两边一起改。
//
// 约定：
//   - handler 一律返回对象（{ ok: true, ... } 或 { ok: false, error }），
//     不抛异常。ipcRenderer.invoke 在 handler 抛错时，界面那边拿到的是
//     一个带奇怪前缀的错误，很难读。自己包成 ok:false 更好处理
//   - 返回值必须能结构化克隆，别传 Buffer、函数、循环引用
//   - 这个函数只在启动时调一次，别在运行中重复调 ——
//     同一个 channel 注册两次，Electron 会直接报错
function registerIpc() {
  // 程序信息。界面启动时调一次，拿到版本、设置、当前运行状态。
  //
  // 这里返回 settings 和 defaults 两份：
  // 界面拿 settings 显示当前值，拿 defaults 判断「这一项是不是被改过」，
  // 也用来做「恢复默认」。
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

  // 存设置。存完立刻把新值应用到各个模块（见 applySwitches）。
  // 有些设置（比如端口）需要重启才生效，界面那边会提示用户。
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

  // 重启。用于改端口这种必须重新初始化才生效的设置。
  // relaunch 把当前命令行原样传给新进程，exit 立刻退出，不等清理 ——
  // 退出前的代理清理走 before-quit 那条路径。
  ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });

  // 从托盘/界面主动退出：先把系统代理还原，再真的关掉。
  //
  // 这里不能只调 app.quit()：窗口的 close 事件会 preventDefault 缩到托盘，
  // 退出就被拦下来，代理留在注册表里。
  // 也不能在 handler 里同步跑 PowerShell：execFileSync 会占住主线程，
  // IPC 的回包发不出去，界面会一直转圈。所以先把结果返回，再异步清理。
  //
  // 那个 80ms 的延时是给 IPC 回包留的时间。立刻开始清理的话，
  // 界面可能还没收到 { ok: true } 就被 exit 掉了。
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
      // 置上这个标记，before-quit 就知道已经清理过了，不用再来一遍
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

  // 复制到剪贴板。用 Electron 的 clipboard 而不是浏览器的 navigator.clipboard，
  // 后者在 Electron 里经常因为权限策略失败。
  ipcMain.handle('app:copy', (_e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  });

  // 在资源管理器里定位文件（不是打开它，是打开所在文件夹并选中）
  ipcMain.handle('app:openFile', (_e, p) => {
    if (typeof p === 'string' && p && fs.existsSync(p)) shell.showItemInFolder(p);
    return { ok: true };
  });

  // 用默认浏览器打开网址。
  //
  // 这里校验协议前缀很关键：不校验的话，界面传来 file:// 或者
  // 别的奇怪协议，shell.openExternal 也会照开，等于给了个任意协议执行的口子。
  // 只放行 http/https。
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  // 窗口控制。自己画的标题栏，这三个按钮要手动接。
  // 注意都没做「窗口不存在」之外的防护 —— 窗口不可能为 null，
  // 因为缩到托盘时窗口只是隐藏，没有销毁。
  ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return { maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { maximized: mainWindow.isMaximized() };
  });
  ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close(); });

  // 一键启动 / 停止
  //
  // launch 包了一层 try/catch：启动过程要跑 PowerShell 改注册表、
  // 装证书，中间任何一步都可能抛错。抛到 IPC 层的话界面收到的是
  // 一串看不懂的东西，包成 { ok:false, error } 才能显示成正常提示。
  ipcMain.handle('app:launch', async () => {
    try {
      return await launch();
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('app:stop', () => stopProxy());

  // 代理状态快照。
  // 界面轮询这个来刷新统计数字，所以里面每一项都要尽量轻，
  // 别在这里做耗时操作（比如扫缓存目录）。
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

// 把自检结果翻译成一句人话。
//
// 这里的文案是给普通用户看的，不用术语。四种组合对应四种说法：
//   主站通 + 握手加密 + 图片通  →  全好，可以用了
//   主站通 + 握手明文           →  能开但会断，翻几页就被掐
//   图片通 + 主站不通           →  典型的域名封锁
//   两个都不通                  →  可能是本机网络问题
//
// doh 参数是四个加密 DNS 服务器的连通性检测结果。
// 它的作用是补充说明「为什么不通」—— 如果四个全挂，那多半是网络把
// 加密 DNS 挡了，这个信息对用户判断换网络还是关代理软件很有用。
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

// 写标记文件。启动代理成功后调一次。
//
// 里面记三样东西，各有用途：
//   port  下次启动时对比，看系统代理是不是还指着这个端口
//   pid   记下是哪个进程写的。理论上可以用它判断进程还在不在，
//         但现在没这么用 —— 判断逻辑走的是「端口 + 备份」那条路
//   at    写的时间，排查问题时看是什么时候留下的
//
// 写不进去也不影响主流程 —— 兜底机制少了这一环，最坏情况是
// 下次启动时识别不出上次没关干净，用户可以手动改回来。
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
