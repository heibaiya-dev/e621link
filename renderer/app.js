'use strict';

// 外壳界面：运行时间、一键启动、设置面板、窗口按钮。
//
// 渲染进程的全部逻辑就是这一个文件。
//
// 它跟 src/ 下面那堆不是一路货：跑在页面里，碰不到 require、fs、net，
// 手里只有 window.e621 这一套（preload.js 通过 contextBridge 塞进来的）。
// 所以这里一行网络代码都没有，正事全在主进程；这边只干两件事 ——
// 把状态画到 DOM 上，把用户点的东西转成 IPC 发出去。
//
// 从上到下的顺序：
//   1) DOM 引用（el 那个对象）：启动时抓一次，之后不再 querySelector
//   2) 全局状态：都是主进程状态的镜像，权威永远在主进程，这边只是缓存一份拿来画
//   3) 渲染：renderTime / syncSettingsUI / refreshState / renderLog
//   4) 用户动作：launch / stopProxy / persist / runCheck
//   5) 事件接线：wireWindowButtons / wireSettings / wireKeys
//   6) boot()：把上面这些串起来跑一遍，文件最后一行调它
//
// 一条贯穿全文件的约定：IPC 的返回值里自己带 ok / error，错误不走异常。
// 主进程每个 handler 都返回 { ok, ... } 或者 { ok:false, error }，
// 所以这里一路 await 下来几乎不用 try / catch。

const api = window.e621;

// window.e621 太长，全文件到处在用，缩成 api。
// 它是 preload 在页面加载时挂上去的，当常量用，别重新赋值。

// querySelector 的简写。
// $$ 用展开语法转成真数组：后面到处 forEach / map，
// NodeList 虽然能 forEach 但没有 map / filter，统一成数组省得中途再转一次。
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// 页面上会用到的节点，启动时一次抓完。
//
// 为什么不每次用的时候再 querySelector：
//   一是 refreshState 每回都要刷十几个节点，每刷新一次查十几个 DOM 不划算；
//   二是这里全部用 id 取，页面一动就能立刻发现是「没抓到手」还是「画错了」。
//
// 下面这个对象必须跟 app.html 里的 id 一一对上。改 HTML 记得回来同步。
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

// ── 全局状态 ──────────────────────────────────────────────
//
// 这里所有东西主进程都有正本，这几个只是缓存。判断「代理在不在跑」永远
// 以主进程推过来的为准，不要拿这边的 running 去推断主进程的状态。

// 设置项的快照。boot 时从 app:info 拿一份，之后每次 persist 用主进程的
// 回包整体覆盖 —— 主进程会把值卡进合法范围，覆盖回来才知道真实值。
let settings = {};

// 代理启动时刻（毫秒时间戳）。0 表示没在跑。
// 存时间戳而不是存「已经跑了多久」，因为窗口可能挂起、定时器可能被节流，
// 每秒加一的写法累积误差会越来越离谱；每次拿 Date.now() 减一下就永远准。
let startedAt = 0;

// 秒表定时器的 id。0 表示没开。
// 用它当「定时器在不在」的标志位，所以 stopTimer 里必须清回 0。
let timerId = 0;

// 正在启动 / 停止的中间态。
// 这段时间按钮是禁用的，靠它挡住重复点击 —— 一次启动要改系统代理、装证书，
// 点两下会并发跑两遍该流程，后面那个基本必挂。
let busy = false;

// 代理当前是否在跑。跟 startedAt 是同步维护的，含义上有个区别：
// running 决定按钮显示「一键启动」还是「停止代理」，startedAt 决定秒表走不走。
let running = false;

// 给系统代理用的规则串，形如 http=127.0.0.1:1234;https=127.0.0.1:1234。
// 没启动时是空串 —— 主进程那边也一样，不会拼出 :0 这种假地址。
// 设置页要显示它，点「复制」复制的也是它，所以留在这个作用域里。
let proxyRule = '';

// 日志行。主进程只在启动之后才推日志，这边的历史来自 proxy:log 那一次拉取。
// 上限 400 行，跟主进程的 recentLog 保持一致。
let logLines = [];

// ───────────────────────── 运行时间 ─────────────────────────

// 补零成两位数。07 比 7 在跳秒的时候不抖 —— 宽度不变，字不会左右蹦。
const pad = (n) => String(n).padStart(2, '0');

// 毫秒转 HH:MM:SS。
//
// 注意小时没有上限，跑一整天会显示 24:xx:xx，不是 00:xx:xx —— 故意的，
// 秒表就该一直往上走，翻零会让人以为代理重启了。
// Math.max(0, …) 是给时钟回拨那种情况兜底的，负数会被格式化成乱码。
function fmt(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// 把当前时间画到主页那个大数字上。定时器和手动调用都会进这里。
//
// 两个小动作都是有原因的：
//   textContent 先比一次再写 —— 每秒重写一次同样的文本会让浏览器多做一次
//   布局，跑一整天就是几万次没必要的重排。
//   running 那个 class 控制数字变成主题色，靠 startedAt 判断，
//   不能用 running 变量：boot 时 running 是先于 startedAt 恢复的。
function renderTime() {
  const text = startedAt ? fmt(Date.now() - startedAt) : '00:00:00';
  if (el.uptimeBig.textContent !== text) el.uptimeBig.textContent = text;
  el.uptimeBig.classList.toggle('running', !!startedAt);
}

// 开秒表。重复调用是安全的（已经开着就直接返回），
// 因为「启动成功」和主进程推的 running 事件都可能开到同一个定时器。
function startTimer() {
  if (timerId) return;
  // 500ms 而不是 1000ms：只刷秒的话，误差能攒到接近一秒，
  // 肉眼会看到某个数字停了两拍再跳。半秒刷一次，最多差半拍，看起来是匀速的。
  // 真正的成本也就每 500ms 一次字符串比较，可以忽略。
  timerId = setInterval(renderTime, 500);
  renderTime();
}

// 停秒表。
// 停下之后还要再调一次 renderTime：它负责把数字重新画成 00:00:00
// 并把主题色撤掉，不然会停在「上一秒 + 主题色」的样子。
function stopTimer() {
  if (!timerId) return;
  clearInterval(timerId);
  timerId = 0;
  renderTime();
}

// ───────────────────────── 主题 ─────────────────────────

// 切主题。只改 <html> 上的 data-theme，具体颜色全交给 styles.css 里的变量。
//
// 传 'system' 之后是 CSS 自己用 @media (prefers-color-scheme) 判断跟不跟系统，
// 这边不用管。空值兜底成 system，免得属性被写成空串导致两套变量都不生效。
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || 'system');
}

// ───────────────────────── 提示 ─────────────────────────

// 主页按钮下面那行提示。
//
// 传空串等于把这一行藏掉（hidden），不是留一条空白 ——
// 它上面是 56px 的大数字，留个空行会让按钮底下多出一块空隙。
// kind 传 'err' 就变红，其余情况一律当作普通提示。
function setStatus(text, kind) {
  const t = (text || '').trim();
  el.statusLine.textContent = t;
  el.statusLine.hidden = !t;
  el.statusLine.classList.toggle('err', kind === 'err');
}

// ───────────────────────── 设置面板 ─────────────────────────

// 打开设置面板。传 pane 就直接落到那个页签（快捷键 Ctrl+, 走的不传参，落回上次那个）。
//
// 三件事的顺序有讲究：
//   syncSettingsUI 先把开关画成 settings 里的值。面板是 hidden 的，
//     隐藏期间也照样能改属性，所以先画再显示，不会看见开关闪一下。
//   refreshState 是异步的（要问主进程），故意不 await ——
//     等它回来再显示的话，点齿轮要卡一下才出面板，很难受。
//   focus 那 60ms 是为了等动画起完。面板入场是 220ms 的 transform 动画，
//     动画还没开始就 focus，浏览器会把焦点滚到元素上，偶尔会带出一次滚动。
function openSettings(pane) {
  el.layer.hidden = false;
  if (pane) selectPane(pane);
  syncSettingsUI();
  refreshState();
  window.setTimeout(() => el.btnSettingsClose.focus(), 60);
}

// 关设置面板，焦点还给齿轮按钮。
// 焦点必须还回去：这个窗口没有原生标题栏，焦点要是丢在隐藏元素上，
// 键盘 Tab 会从头开始找，用户会觉得「键盘失灵了」。
function closeSettings() {
  if (el.layer.hidden) return;
  el.layer.hidden = true;
  el.btnSettings.focus();
}

function isSettingsOpen() {
  return !el.layer.hidden;
}

// 切页签。把匹配的那个导航项和面板打上 active，其余摘掉。
//
// 用 data-pane 对字符串匹配，不按下标 —— HTML 里页签顺序改了这里不用动。
// 页签内容是常驻 DOM 的（只是 display:none），切回来不用重建，
// 缓存用量那些数字还留着，不用重新拉一遍。
function selectPane(pane) {
  $$('#settingsNav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === pane));
}

// 分段控件（主题那个）选中某一项。
//
// 选中状态写在 aria-checked 上而不是加一个 .active 类：
// CSS 那边直接用 [aria-checked="true"] 选，屏幕阅读器也认这个属性，
// 一份状态两处用，省得类和语义各写一套、改的时候漏一个。
function setSeg(container, value) {
  $$(`#${container.id} .seg-btn`).forEach((b) => {
    b.setAttribute('aria-checked', b.dataset.value === value ? 'true' : 'false');
  });
}

// 开关同理，只有开 / 关两态，写 aria-checked。
// 注意这里只画状态，不触发任何副作用；真正调主进程的是各个 click 处理器。
function setSwitch(node, on) {
  node.setAttribute('aria-checked', on ? 'true' : 'false');
}

// 「这个词不就是 aria-checked === 'true' 吗」，是的，但读的地方有八九处，
// 抽出来是为了所有地方对「什么算开」的判断永远一致。
function isOn(node) {
  return node.getAttribute('aria-checked') === 'true';
}

// 把 settings 里的值铺到整个设置面板上。打开面板时调一次，每次存完设置再调一次。
//
// 一堆 `!== false` 和 `=== true` 看着别扭，原因在 src/settings.js：
// 那边的布尔字段归一化规则是「只要不是明确的 false 就算 true」，
// 所以默认开的项得写 `!== false`（undefined 也要当开），
// 默认关的项写 `=== true`（undefined 要当关）。
// 这里如果一律写 !!，第一次装完 trimJunk 这类默认关的会被画成开。
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

// 存设置。只传要改的那几项，主进程会跟已有的合并。
//
// 回包里的 settings 是**归一化之后**的完整设置，整份覆盖过来 ——
// 比如往输入框里填了个 99999，主进程会卡到上限，覆盖回来输入框才会显示真实值。
// 不这么做的话界面上显示 99999、实际生效 8192，用户永远搞不清到底存进去了什么。
//
// 存不上只提示一句、返回 false，不抛异常：设置存不下不该让面板其他操作一起停。
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

// 把主按钮切到「忙 / 空闲」两种样子。启动和停止的整个过程都靠它管按钮。
//
// 三个 class 管三件事，别混着加：
//   busy  转圈。图标会转，让人知道在等
//   stop  已经在跑，按钮降级成次要样式（见 styles.css 里 .launch.stop）
//   文字  启动中 / 停止代理 / 一键启动，三选一
//
// stop 的判据是 `!on && running`：忙的时候不显示 stop 样式，
// 否则会在「正在停」的时候把按钮画成「停止代理」，等于骗人再点一次。
function setBusy(on, text) {
  busy = on;
  el.btnLaunch.disabled = on;
  el.btnLaunch.classList.toggle('busy', on);
  el.btnLaunch.classList.toggle('stop', !on && running);
  el.launchText.textContent = on ? (text || '正在启动') : (running ? '停止代理' : '一键启动');
  el.btnLaunch.setAttribute('aria-label', running && !on ? '停止代理' : '一键启动');
}

// 主按钮的动作：没在跑就启动，在跑就停。同一个按钮两种含义，看 running。
//
// 整体流程：主进程做所有正事（起代理、改系统代理、装证书），
// 这边只是等回包，然后把 startedAt / running / proxyRule 这三个镜像状态补上。
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
    // 用主进程给的 startedAt，不用本地 Date.now()。
    // 主进程是它自己记的时间，本地这个晚了几十上百毫秒（要跨进程来回），
    // 而且窗口关了再开（缩托盘）时，只有主进程那份是一直连着算的。
    startedAt = r.startedAt || Date.now();
    running = true;
    proxyRule = r.proxyRule || '';
    startTimer();
    setBusy(false);
    setStatus('代理启动成功UwU');

    // 启动前浏览器已经在用别的代理（Clash、VPN 之类）。
    // 主进程把原来那条覆盖掉了，退出时会还原，但这事得告诉用户一声，
    // 不然他打开别的网站发现走了代理会以为软件干坏了。
    if (r.previousEnabled && r.previousProxy) {
      setStatus(`启动成功！但是还有一个代理（${r.previousProxy}）已经被临时替换，关闭后自动复原ヾ(•ω•\`)o`);
      pushLogLine('原来的系统代理是 ' + r.previousProxy + '，已经临时换成本机代理qwq');
    }
    // 证书没装上不算启动失败：代理在跑、系统代理也改了，只是浏览器会弹证书警告。
    // 所以这条覆盖掉上面那句成功提示，让用户去设置里重装。
    if (!r.trusted) {
      setStatus('启动成功，但是证书安装失败了qwq，请去设置尝试重装', 'err');
    }
    await refreshState();
    return;
  }

  // 失败就把本地状态原样清掉。
  // 这里不能留 running=true —— 主进程那边启动是原子的，失败了代理肯定没起来，
  // 本地多存一个 true 会让按钮变成「停止代理」，点了只是空转。
  setBusy(false);
  setStatus('错误，代理启动失败qwq：' + (r.error || '不知道什么原因'), 'err');
}

// 停代理。主进程负责还原系统代理、关端口，这边跟着清状态。
//
// 注意 startedAt 归零和 stopTimer 的顺序：先清 startedAt 再停表，
// 这样 stopTimer 里最后那次 renderTime 画出来的是 00:00:00 而不是停下那一刻的时间。
async function stopProxy() {
  setBusy(true, '正在停');
  const r = await api.stop();
  running = false;
  startedAt = 0;
  stopTimer();
  proxyRule = '';
  setBusy(false);
  // r.restored 说的是「系统代理还原成功没有」，不是「代理停了没有」。
  // 没还原成功也不影响代理已停，但用户系统代理还指着已经关掉的端口，
  // 表现就是上不了网，所以这句必须报错。
  if (r.restored) {
    setStatus(r.restoredTo ? `代理服务已停止awa。已恢复旧代理 ${r.restoredTo}。` : '代理服务已停止awa');
  } else {
    setStatus('代理服务已停止，但是旧代理还原失败', 'err');
  }
  await refreshState();
}

// ───────────────────────── 状态刷新 ─────────────────────────

// 拉一次主进程状态，把设置页上所有数字重画一遍。
// 打开面板时、启停之后、装/卸证书之后、清缓存之后都会调它。
//
// proxy.state 和 ca.state 并发问，别写成两个 await 串起来 ——
// 每个都是一次 IPC 往返，串起来等于把延迟加起来。
//
// 这里画的全是「已处理多少」的统计，没有必要定时轮询：
// 数字只在开关面板的那一刻有用，真要实时刷就是每秒几百次 IPC，
// 而用户真正会盯着看的秒表在主页，那个有独立的定时器。
async function refreshState() {
  const [s, c] = await Promise.all([api.proxy.state(), api.ca.state()]);

  // 只有真的在跑的时候才显示地址，没跑就显示提示语
  // 判断里带 s.port 是因为「起了但端口还没分配好」的瞬间 running 已经是 true，
  // 这时拼出来会是 http=127.0.0.1:0，比空着更容易误导人。
  proxyRule = s.running && s.port ? `http=127.0.0.1:${s.port};https=127.0.0.1:${s.port}` : '';
  el.stProxy.textContent = s.running ? '已启动' : '未启动';
  el.stPort.textContent = s.running ? String(s.port) : '—';
  el.stCa.textContent = c.trusted ? '已经装进信任区' : '未安装';
  el.stStats.textContent = s.running
    ? `请求 ${s.stats.requests} 次，图片 ${s.stats.images} 次，改写页面 ${s.stats.rewritten} 次，出错 ${s.stats.errors} 次`
    : '—';

  el.useProxyRule.textContent = proxyRule || '未启动。点一键启动之后这里会显示地址。';

  // 缓存和拦截的数字
  // extras 是主进程顺手塞进来的，取不到就退回空对象 ——
  // 老版本主进程没有这个字段，别让整个面板因为读 undefined 崩掉。
  const ex = s.extras || {};
  const cs = ex.cache || {};
  const bl = ex.blocker || {};

  // 字节转人看的单位。1MB 以下用 KB，以上用 MB 保留一位小数。
  // 阈值写成 1024*1024 而不是 1000*1000，跟 Windows 资源管理器一致，
  // 不然 1000000 字节会显示成「977 KB」，用户对不上号。
  const mb = (n) => (n < 1024 * 1024 ? Math.round(n / 1024) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB');

  // 没配上限就显示 —。maxBytes 为 0 表示缓存没开
  el.cacheUsed.textContent = cs.maxBytes
    ? `${mb(cs.used || 0)} / ${mb(cs.maxBytes)}（${cs.percent || 0}%）`
    : '—';
  el.cacheHits.textContent = cs.hits ? `${cs.hits} 次，省了 ${mb(cs.bytesServed || 0)}` : '—';
  el.cacheStores.textContent = cs.stores ? `${cs.stores} 个文件` : '—';

  el.blockCount.textContent = bl.blocked ? `${bl.blocked} 次` : '—';
  // 挡得最多的那几个域名，主进程已经排好序，这边只负责拼成一行。
  // 用「，」而不是逗号：混在中文里看着才齐。
  el.blockTop.textContent = bl.top && bl.top.length
    ? bl.top.map((x) => `${x.host}（${x.n}）`).join('，')
    : '—';
  el.trimCount.textContent = bl.trimmed ? `${bl.trimmed} 次` : '—';
}

// 「联通性检查」：让主进程真的连一次 e621 主站和图片服务器，把结果贴在面板里。
//
// 实测要等好几秒（两个请求各自超时上限 15 秒），所以先把输出框打开写「正在连接…」，
// 不然点完按钮两秒内毫无反应，用户会以为按钮坏了。
// 这条占位文字必须在 await 之前写上，写在后面就白写了。
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

  // 空行把上面两行原始结果和下面那段结论分开。
  // summary 是主进程写的，会顺着 DoH 的情况说到该换网络还是该关别的代理。
  lines.push('');
  lines.push(r.summary);

  el.checkOut.textContent = lines.join('\n');
  // 只看主站通不通来决定红不红。
  // 图片服务器挂了是「图片不显示」，主站挂了是「网页打不开」，后者才值得标红。
  el.checkOut.classList.toggle('err', !r.main.ok);
}

// ───────────────────────── 日志 ─────────────────────────

// 把 logLines 画到日志页那个 <pre> 里。
//
// 只取最后 200 行：主进程存的也就是 200 行（recentLog.slice(-200)），
// 但这边内存里可能攒到 400，画的时候切一刀，DOM 里别放太多文本 ——
// 一个 <pre> 塞几千行不会崩，但选中复制和滚动都会变卡。
//
// 每次整体重写 textContent 而不是往下 append：行数有上限，
// 整写比维护「该删哪几行」简单，也不会因为删除导致滚动位置乱跳。
function renderLog() {
  if (!logLines.length) {
    el.logOut.textContent = '还没有记录━━(￣ー￣*|||━━';
    return;
  }
  el.logOut.textContent = logLines.slice(-200).join('\n');
  // 滚到最底下。新日志都在末尾，不滚的话用户看到的永远是最老的那几行。
  // 得在写完 textContent 之后再设，先设会被新内容顶回去。
  el.logOut.scrollTop = el.logOut.scrollHeight;
}

// 插一行日志。启动流程里的几句话会走这里，主进程推的实时日志也走这里。
//
// 攒到 400 行截一次、而不是每行都 shift 一下：
// 代理忙的时候一秒能来几十行，每行都做数组头部删除是没必要的开销。
// 这里只改数组不动 DOM —— 除非日志页正开着，否则不画。
// 不然每次请求都重写一遍 <pre>，主线程会被这个吃满。
function pushLogLine(text) {
  logLines.push(text);
  if (logLines.length > 400) logLines = logLines.slice(-400);
  if (!el.layer.hidden && $('.pane[data-pane="log"]').classList.contains('active')) renderLog();
}

// ───────────────────────── 事件接线 ─────────────────────────
//
// 下面三个 wire* 函数只做绑定，只在 boot 里各调一次。
// 处理器全是 click / change 这种即时事件，绑定发生在用户能点之前，
// 所以不存在「事件来时还没绑上」的问题，也不需要事件委托之外的动态绑定。

// 自绘标题栏的三个按钮 + 双击最大化。
//
// 窗口是 frame:false 建的（见 src/main.js 的 createWindow），
// 系统标题栏整个没了，最小化/最大化/关闭全得自己接。
function wireWindowButtons() {
  $('#btnMin').addEventListener('click', () => api.win.minimize());
  $('#btnMax').addEventListener('click', () => api.win.toggleMaximize());
  $('#btnClose').addEventListener('click', () => api.win.close());

  // 最大化状态是主进程推过来的，不在这边自己推断 ——
  // 用户双击标题栏、按 Win+↑、拖到屏幕顶部，这些都不经过我们的按钮，
  // 本地猜必然对不上，图标就会画错。
  // 两个 SVG 直接写字符串塞 innerHTML：就这么点内容，为它做两套 <path>
  // 再切换 display 不值当。
  api.win.onState((s) => {
    const g = $('#maxGlyph');
    if (!g) return;
    g.innerHTML = s.maximized
      ? '<rect x=".5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5h5v-1h-5z" fill="currentColor"/>'
      : '<rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/>';
  });

  // 双击标题栏最大化 / 还原，这是 Windows 用户的肌肉记忆。
  // 那个 closest('button') 的判断不能省：按钮虽然自己设了 no-drag，
  // 但 dblclick 照样会冒泡到 header 上，不拦的话连点两下关闭按钮会顺带把窗口最大化一次。
  el.titlebar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    api.win.toggleMaximize();
  });
}

// 设置面板里所有按钮和开关的绑定。这个函数很长，按面板顺序分段（跟 app.html 的页签一一对应）。
function wireSettings() {
  el.btnSettings.addEventListener('click', () => openSettings());
  el.btnSettingsClose.addEventListener('click', closeSettings);
  // 点遮罩（.settings-layer 本身）关面板。面板本体是它的子元素，
  // 所以要用 e.target === el.layer 判一下，不然点面板里的空白处也会关。
  el.layer.addEventListener('click', (e) => {
    if (e.target === el.layer) closeSettings();
  });

  // 导航用事件委托：四个按钮只挂一个监听，
  // 以后要加页签也不用回来改这里。
  el.nav.addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (b) selectPane(b.dataset.pane);
  });

  // 连接
  el.btnCheck.addEventListener('click', runCheck);
  el.btnStopProxy.addEventListener('click', stopProxy);

  // 开关们的套路都一样：先按当前状态取反、立刻画上去、再去存。
  // 先画是为了手感 —— 等 IPC 回来再动，开关会有肉眼可见的延迟。
  // 存失败的话 persist 内部会弹提示，开关状态也由它重新同步回来。
  el.swRewrite.addEventListener('click', () => {
    const next = !isOn(el.swRewrite);
    setSwitch(el.swRewrite, next);
    persist({ rewriteImages: next });
  });

  // 证书这个开关比别处多一步：除了存设置，还要真的去装/卸证书。
  // 装完必须 refreshState，因为状态卡片上「本机证书」那一行要变。
  // 这里的失败提示文案跟启动流程里那句一样，用户看到的是同一件事。
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
  // 「卸载证书」直接删，不问「确定吗」。
  // 删错了再点一次开关装回来就行，为这种可逆操作弹确认框不划算。
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

  // 缓存上限。用 change 不用 input：input 是每敲一个字符都触发，
  // 敲 512 会先存一个 5、再存 51、再存 512，主进程要被无意义地写三次盘。
  // change 只在失焦或者回车时触发，一次到位。
  //
  // 那个 `if (v)` 顺手挡掉了空值和 0（Number('') 是 0）。
  // 清空输入框不该把上限存成 0 —— 0 在设置里没有含义，主进程会按默认值兜底，
  // 但界面上会出现「输入框空着、实际是 512」的怪状态。
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
  // 复制代理规则。没启动就没什么可复制的，提示一句直接返回 ——
  // 复制一个空串到剪贴板，用户粘出来什么都没有，比什么都不做更让人困惑。
  el.btnCopyProxy.addEventListener('click', async () => {
    if (!proxyRule) {
      setStatus('未启动，没有地址可复制。');
      return;
    }
    await api.copy(proxyRule);
    // 按钮文字临时变成「已复制」，1.5 秒后变回来。
    // 复制本身没有任何视觉反馈，不给个提示用户不确定到底成没成。
    el.btnCopyProxy.textContent = '已复制';
    window.setTimeout(() => { el.btnCopyProxy.textContent = '复制'; }, 1500);
  });

  // 日志
  // 只清本地这份。主进程的 recentLog 不清 ——
  // 那边是给界面重开时用的历史，清掉的话日志页一关一开就空了。
  el.btnClearLog.addEventListener('click', () => {
    logLines = [];
    renderLog();
  });

  // 主题
  // 切主题要立刻 applyTheme，不能等 persist 的回包 ——
  // 存设置是一次 IPC 往返，等它回来才变色会看见明显的延迟。
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

  // 窗口宽高两个输入框共用一个处理器。
  // 只改一个的话不存 —— 主进程要的是成对的尺寸，只有宽没高没法定窗口。
  // 宽高都填了才存，所以必须两个框都改过一轮（或者其中一个本来就有值）。
  const saveSize = () => {
    const w = Number(el.inpW.value);
    const h = Number(el.inpH.value);
    if (w && h) persist({ windowWidth: w, windowHeight: h });
  };
  el.inpW.addEventListener('change', saveSize);
  el.inpH.addEventListener('change', saveSize);
}

// 全局快捷键。
//
// 用 keydown 挂在 document 上而不是给某个按钮挂：
// 这些键在页面任何位置都该管用。
function wireKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isSettingsOpen()) {
        e.preventDefault();
        closeSettings();
      }
      // Esc 处理完就返回，别继续往下走。
      // 不返回的话，紧接着的 Enter 判断虽然不会误触发，
      // 但以后往里加键位很容易忘掉这里会串。
      return;
    }
    // Ctrl+, 是 Windows 上「打开设置」的通用键位。
    // metaKey 一起判是为了 Mac 用户（虽然这程序只发 Windows）。
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      openSettings();
    }
    // 回车等于点一键启动。
    // 只在这种情况下生效：面板关着、不在忙、焦点在 body 或者就在启动按钮上。
    // 加了 activeElement 这个条件，是因为回车还有别的含义 ——
    // 焦点在开关上时回车应该切开关，焦点在输入框里时空格回车应该是输入，
    // 都让回车去启动的话，设置页里就全乱套了。
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

// 整个页面唯一的初始化入口，文件最后一行调它。
//
// 为什么第一件事是 await api.info()：页面刚加载完的时候这边什么都还不知道 ——
// 代理跑没跑、上次的主题是什么、用户改过哪些设置。全等这一次拿回来再往下画，
// 不然会先按默认值渲染一帧（浅色主题 + 00:00:00），然后才跳成真实的样子。
//
// 顺序上有依赖，别随便调：
//   settings 必须先有，applyTheme 和 syncSettingsUI 都读它
//   wireWindowButtons 必须早于下面的 api.onRunning —— 那个回调会调 setBusy，
//     而它要动按钮的 class，绑定晚了倒不至于崩，但状态会先画错一帧
//   api.onRunning 放在最后的启动状态判断之后，是为了接管「之后」的变化，
//     「之前」的那份状态由 info 补，两边不重叠也不漏
async function boot() {
  const info = await api.info();
  settings = { ...info.settings, _settingsFile: info.settingsFile };

  applyTheme(settings.theme);

  // 这里又算了一遍代理规则，跟 refreshState 里那段重复。
  // 不直接把 refreshState 拉过来是因为它在页面首次显示时不该发两次 IPC：
  // info 里已经带了 running 和 port，够拼出来了。
  proxyRule = info.running && info.port ? `http=127.0.0.1:${info.port};https=127.0.0.1:${info.port}` : '';

  syncSettingsUI();
  renderTime();
  wireWindowButtons();
  el.btnLaunch.addEventListener('click', launch);
  wireSettings();
  wireKeys();

  // 上次退出时代理还在跑（比如点了托盘退出但清理没跑完，或者程序被强杀后重开）。
  // 这种情况得把秒表接着算下去，用主进程记的 startedAt，不是从 0 开始。
  if (info.running && info.startedAt) {
    startedAt = info.startedAt;
    running = true;
    startTimer();
    setBusy(false);
    setStatus('代理工作中');
  } else {
    setBusy(false);
  }

  // 主进程推的启停事件。
  // 作用是兜底：用户可能从托盘菜单启停代理，或者主进程自己因为出错把代理停了，
  // 这些都不经过界面上的按钮，本地状态不跟着走就会显示成错的。
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
  // 先把已经攒下的历史拉过来，再挂实时推送。
  // 主进程有个 recentLog 一直攒着（上限 400 行），页面重开时靠这一次拉取补回历史；
  // 之后新日志走下面的 onLog 推送。
  // 两步的顺序不能反：先挂监听再拉历史的话，
  // 拉取期间来的那几行会同时出现在历史和推送里，日志里就会重复。
  const old = await api.proxy.log();
  logLines = old.map((x) => x.text);
  renderLog();

  api.proxy.onLog((entry) => {
    pushLogLine(entry.text);
  });

  // 跟随系统主题时，系统在浅色/深色之间切了要跟着变。
  //
  // 注意：真管颜色的是 styles.css 里那个 @media (prefers-color-scheme: dark)
  // 配 html[data-theme="system"] 的变量块，浏览器自己就会切，不需要这段。
  // 这里重新 setAttribute 一次是把属性值再写一遍（内容没变），
  // 作用是万一属性被别处动过，切主题时能顺手纠正回来。属于便宜的保险。
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'system') applyTheme('system');
  });
}

// 直接调，不挂 DOMContentLoaded。
// app.html 里这个 <script> 放在 </body> 前面，执行到这里 DOM 已经齐了。
boot();
