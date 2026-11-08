'use strict';

// 设置的读写。存在 %APPDATA%\E621Link\settings.json
//
// 这个文件只干三件事：
//   1) 定一份默认值（DEFAULTS），程序第一次跑就用它
//   2) 读的时候把用户存的值跟默认值合并，缺的补上
//   3) 存的时候把值全部卡进合法范围，防止手改配置文件把程序搞崩
//
// 为什么读的时候也要 normalize：用户可能手动改过 json，或者拷了旧版本的
// 配置过来，里面缺字段、类型不对、数字超范围都很常见。不收拾一遍，
// 后面用起来就是各种莫名其妙的行为。
//
// 有个内存缓存（cache 变量）。设置不常变，读的时候直接返回这个对象，
// 免得每次取设置都读一遍硬盘。

const fs = require('fs');
const os = require('os');
const path = require('path');

// 全部默认值。注释里写的「默认」就是第一次装完的样子。
const DEFAULTS = {
  port: 0,              // 0 = 每次自动挑一个空端口（推荐，省得跟别人抢）
  trustCa: true,        // 启动时把本机证书装进当前用户的信任区，不然浏览器会报证书错
  rewriteImages: true,  // 把 static1.e621.net 换成 static1.e926.net，这个必须开，否则图片全裂
  autoStopOnQuit: true, // 关软件时把系统代理撤掉，不然关完就上不了网了

  minimizeToTray: true, // 关窗口时缩到托盘，不退出（退出得走托盘菜单）
  trayHintShown: false, // 第一次缩托盘时的气泡提示有没有弹过，弹过就不弹了

  useCache: true,       // 本地缓存，图片和静态文件存本地，第二次打开快很多
  cacheMB: 512,         // 缓存最多占多少 MB，超了自动删最老的
  blockAds: true,       // 广告拦截
  trimJunk: false,      // 顺手挡掉装饰图之类没用资源。默认关，因为有些人就爱看这些

  theme: 'system',      // 主题：system 跟随系统 | light 浅色 | dark 深色
  rememberWindow: true, // 记住上次窗口大小
  windowWidth: 1120,    // 窗口默认宽度，只在没记住过的时候用
  windowHeight: 780,    // 窗口默认高度
  startMaximized: false,// 启动就最大化
};

// 这几个键的值只能是 true 或 false。
// 单独列出来是因为 normalize 要按类型处理，不能跟数字混在一起。
const BOOL_KEYS = [
  'trustCa', 'rewriteImages', 'autoStopOnQuit',
  'minimizeToTray', 'trayHintShown',
  'useCache', 'blockAds', 'trimJunk',
  'rememberWindow', 'startMaximized',
];

// 所有认识的键。外面传来不认识的键会被 pick 丢掉，不会写进配置文件。
const ALL_KEYS = Object.keys(DEFAULTS);

// 内存里的那份设置。null 表示还没读过。
let cache = null;

// 配置目录：%APPDATA%\E621Link
// 兜底那个 path.join 是给没设 APPDATA 环境的奇怪情况用的。
function dir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'E621Link');
}

function file() {
  return path.join(dir(), 'settings.json');
}

// 从任意对象里只挑出认识的键。
// 用途：前端可能传一堆别的东西过来，别直接往配置文件里塞。
function pick(obj) {
  const out = {};
  for (const k of ALL_KEYS) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// 把设置收拾成合法状态。每个字段在这里都要过关：
//   - 数字：转成数字、取整、卡进上下限
//   - 枚举：不在允许列表里的，退回默认
//   - 布尔：只要不是明确的 false，就当 true（手改配置写成 "false" 字符串也认）
//
// 上下限不是随便定的：
//   端口 0~65535 是协议规定；0 专门表示「自动挑」
//   窗口 720x540 是最小可用尺寸，再小设置页就挤成一团了
//   3840x2160 是 4K 上限，更大的没意义
//   缓存 64MB 起步，再小基本没效果；8192MB 上限防止有人写个天文数字把盘撑爆
function normalize(s) {
  s.port = Math.min(65535, Math.max(0, Math.round(Number(s.port) || 0)));
  s.windowWidth = Math.min(3840, Math.max(720, Math.round(Number(s.windowWidth) || DEFAULTS.windowWidth)));
  s.windowHeight = Math.min(2160, Math.max(540, Math.round(Number(s.windowHeight) || DEFAULTS.windowHeight)));
  s.cacheMB = Math.min(8192, Math.max(64, Math.round(Number(s.cacheMB) || DEFAULTS.cacheMB)));
  if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = DEFAULTS.theme;
  for (const k of BOOL_KEYS) s[k] = s[k] !== false && s[k] !== 'false';
  return s;
}

// 读设置。读不到、读坏了、文件不存在，一律当第一次跑，用默认值。
// 这里刻意不报错：配置文件坏了不该让程序起不来。
function load() {
  if (cache) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8')) || {};
  } catch {
    raw = {};
  }
  // 先铺默认值，再用文件里的覆盖。这样旧版本存的配置缺了新字段也能用。
  cache = normalize({ ...DEFAULTS, ...pick(raw) });
  return cache;
}

function get() {
  return load();
}

// 存设置。传进来的 patch 只需要带要改的字段，其余保持不变。
//
// 返回 { ok, settings } 或者 { ok:false, error }。
// 注意：就算写硬盘失败，内存里的 cache 也已经更新了 —— 这一次运行期间
// 用户改的设置是生效的，只是下次打开会丢。这个取舍是故意的：
// 设置页点了保存，界面上应该立刻反映出来，不能因为磁盘写不进去就整个不生效。
function save(patch = {}) {
  const next = normalize({ ...load(), ...pick(patch) });
  cache = next;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, settings: next, error: '设置没存上：' + e.message };
  }
  return { ok: true, settings: next };
}

// 恢复默认。会直接覆盖配置文件。
// 写不进去也不报错 —— 内存里已经重置了，这次运行是默认设置。
function reset() {
  cache = { ...DEFAULTS };
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    /* 存不上就算了 */
  }
  return { ok: true, settings: cache };
}

module.exports = { DEFAULTS, load, get, save, reset, file, dir };
