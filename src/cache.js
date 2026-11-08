'use strict';

// 本地缓存。
//
// 目标是把图片和静态文件存到硬盘上，第二次打开同一个页面直接从本地读，
// 不用再去网上拉。对 e621 这种图片多的站点效果最明显。
//
// 做法很朴素：URL 算个哈希当文件名，旁边一个 .meta.json 记状态码、类型、时间。
// 超过设定的总量就按「最久没用的先删」清掉。
//
// 文件长这样：
//   cache/3f/3f8a1b...c2.bin     ← 真正的文件内容
//   cache/3f/3f8a1b...c2.json    ← 元信息（原 URL、类型、大小、存的时间）
//
// 为什么分两级目录：一个目录里放几十万个文件，Windows 上读目录会明显变慢。
// 用哈希前两位分桶，均匀散到 256 个目录里，每个目录就没那么挤了。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// 程序的数据目录：%APPDATA%\E621Link
// 跟设置、证书、脚本放一起，卸载时好一起清。
function appDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'E621Link');
}

function cacheDir() {
  return path.join(appDir(), 'cache');
}

// 运行时状态。
// used 是内存里记的「现在占了多少」，启动时由 measure() 扫一遍算出来，
// 之后每存一个加、每删一个减。不每次都扫目录是因为那样太慢。
let enabled = true;
let maxBytes = 512 * 1024 * 1024; // 默认 512MB
let used = 0;
let stats = { hits: 0, misses: 0, stores: 0, bytesServed: 0 };

// 这些类型值得缓存。HTML 和 JSON 不缓存——e621 的页面带登录态和一次性 token，
// 缓存了会串号，得不偿失。
//
// 具体排掉了什么：
//   text/html       页面本身带 CSRF token 和用户信息
//   application/json 各种接口的返回，可能有登录态相关的东西
// 只留图片、字体、样式、脚本这四类真正静态、跟用户无关的资源。
const CACHEABLE = /^(image\/|font\/|application\/font|text\/css|application\/javascript|text\/javascript)/i;

// 只有在这些域名下的资源才缓存。
// 别的地方（比如搜索引擎、别的网站）走代理时不该往里塞东西。
const CACHE_HOSTS = new Set([
  'static1.e621.net', 'static2.e621.net', 'static3.e621.net',
  'static1.e926.net',
]);

// 把「域名 + 路径」算成一个 40 位十六进制字符串当文件名。
//
// 用域名 + 路径而不是完整 URL：协议固定是 https，查询串对静态资源没意义
// （图片地址里没有查询串），带上反而会让同一个文件算成两个 key。
// 统一 toLowerCase 是因为域名大小写不敏感。
function keyFor(host, urlPath) {
  return crypto.createHash('sha1').update(String(host).toLowerCase() + urlPath).digest('hex');
}

// 由哈希算出两个文件该放哪儿。
// key.slice(0, 2) 就是分桶用的目录名，取前两位十六进制。
function paths(key) {
  const dir = cacheDir();
  // 分两级，避免单目录文件太多
  const sub = path.join(dir, key.slice(0, 2));
  return {
    sub,
    body: path.join(sub, key + '.bin'),
    meta: path.join(sub, key + '.json'),
  };
}

// 初始化。启动时调一次。
// 建不出目录就把 enabled 关掉 —— 磁盘满了、没权限、路径被占用都可能，
// 这不该让整个程序起不来，缓存用不了就不用，功能照常。
function init(options = {}) {
  enabled = options.enabled !== false;
  if (Number.isFinite(options.maxBytes) && options.maxBytes > 0) maxBytes = options.maxBytes;
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
  } catch {
    /* 建不出来就当作不能用 */
    enabled = false;
  }
  measure();
  return { enabled, maxBytes, used };
}

function setEnabled(on) {
  enabled = on !== false;
}

function getEnabled() {
  return enabled;
}

// 设上限。最少给 16MB，再小基本存不住东西。
function setMaxBytes(n) {
  maxBytes = Math.max(16 * 1024 * 1024, Math.round(Number(n) || maxBytes));
}

// 扫一遍目录，算出现在占了多少。
//
// 只在启动时调，运行时靠加减维护 used。
// 只统计 .bin 的大小，.json 那点元信息忽略不计 —— 它只有一两百字节，
// 加起来占比不到千分之一，算进去反而让数字看着奇怪。
//
// 各种 try/catch 是为了容忍并发：扫描过程中可能有文件刚好被删掉，
// statSync 就会抛错。这种直接跳过就行，不该让整个扫描失败。
function measure() {
  used = 0;
  try {
    const dir = cacheDir();
    if (!fs.existsSync(dir)) return used;
    for (const sub of fs.readdirSync(dir)) {
      const p = path.join(dir, sub);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      let names = [];
      try {
        names = fs.readdirSync(p);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith('.bin')) continue;
        try {
          used += fs.statSync(path.join(p, n)).size;
        } catch {
          /* 文件刚好没了，跳过 */
        }
      }
    }
  } catch {
    /* 算不出来就保持原值 */
  }
  return used;
}

// 判断这个请求值不值得缓存。四个条件全过才缓存。
//
// 注意 method 必须是 GET：POST 之类的请求有副作用，缓存了会出问题
// （比如点赞一次被存下来，下次直接「命中」跳过实际请求）。
function isCacheable(host, method, contentType) {
  if (!enabled) return false;
  if (String(method).toUpperCase() !== 'GET') return false;
  if (!CACHE_HOSTS.has(String(host || '').toLowerCase())) return false;
  return CACHEABLE.test(contentType || '');
}

// 读缓存。命中返回 { body, contentType }, 没命中返回 null。
//
// 校验得很细，任何一项不对就当没命中：
//   - 元信息读不出来（文件被删了、写坏了）
//   - 状态码不是 200（当时存的就是个错误页）
//   - 内容文件读不出来
//   - 文件大小跟元信息里记的对不上（存的时候被打断了，内容不完整）
//
// 大小校验这条很重要：写到一半断电或者程序被杀，会留下半截文件。
// 不检查的话浏览器会拿到一张残缺的图片，而且因为缓存命中了，
// 怎么刷新都是坏的，只能手动清缓存，用户根本不知道该怎么办。
function read(host, urlPath) {
  if (!enabled) return null;
  const key = keyFor(host, urlPath);
  const p = paths(key);

  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
  } catch {
    return null;
  }
  if (!meta || meta.status !== 200) return null;

  let body;
  try {
    body = fs.readFileSync(p.body);
  } catch {
    return null;
  }
  if (!body || body.length !== meta.size) return null;

  // 碰一下文件时间，作为「最近用过」的标记
  //
  // 为什么不自己记一个「最后访问时间」字段写进 json：那样每次命中都要
  // 重写一遍元信息文件，写操作比改时间戳慢得多，而且并发时容易写坏。
  // 文件系统的 atime 天然就是干这个的，evict 的时候读它就行。
  // 有些系统会关掉 atime 更新，所以 evict 里还兜了一层用 mtime。
  const now = new Date();
  try {
    fs.utimesSync(p.body, now, now);
  } catch {
    /* 改不了就算了，不影响命中 */
  }

  stats.hits += 1;
  stats.bytesServed += body.length;
  return { body, contentType: meta.contentType || 'application/octet-stream', size: body.length };
}

// 往缓存里存一份。
//
// 先写内容文件再写元信息文件，顺序不能反。
// 反过来的话，万一在两步之间程序被杀，会留下一个「有元信息但没有内容」
// 的状态 —— 下次读的时候虽然在 read 里会被大小校验挡掉，但更麻烦的是
// evict 扫目录时只认 .bin，这个孤立的 .json 永远删不掉，越积越多。
// 按现在这个顺序，最坏情况是有个 .bin 没元信息，read 读元信息失败直接
// 当没命中，下次写入会把它覆盖掉。
function write(host, urlPath, status, contentType, body) {
  if (!isCacheable(host, 'GET', contentType)) return false;
  if (status !== 200) return false;
  if (!body || body.length === 0) return false;

  const key = keyFor(host, urlPath);
  const p = paths(key);
  try {
    fs.mkdirSync(p.sub, { recursive: true });
    fs.writeFileSync(p.body, body);
    fs.writeFileSync(
      p.meta,
      JSON.stringify({
        url: 'https://' + host + urlPath,
        status,
        contentType,
        size: body.length,
        savedAt: new Date().toISOString(),
      }),
      'utf8'
    );
  } catch {
    return false;
  }

  used += body.length;
  stats.stores += 1;
  // 存完立刻判断要不要清理，不等下次启动。
  // 不然用户下了一堆图，用量一路涨到超过上限也不清，硬盘就满了。
  if (used > maxBytes) evict();
  return true;
}

// 超了就删最久没用过的，一直到降到八成。
//
// 为什么清到八成而不是刚好卡在上限：留点余量，免得刚清完又满了、
// 每次写一个文件都要触发一次全目录扫描。全目录扫描挺贵的，
// 几百上千个文件时要花几十毫秒。
//
// 排序用的是 atime（访问时间），读缓存时会用 utimesSync 更新它。
// atime 不可用的时候退回 mtime。
function evict() {
  const entries = [];
  try {
    const dir = cacheDir();
    for (const sub of fs.readdirSync(dir)) {
      const p = path.join(dir, sub);
      let names = [];
      try {
        if (!fs.statSync(p).isDirectory()) continue;
        names = fs.readdirSync(p);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith('.bin')) continue;
        const f = path.join(p, n);
        try {
          const st = fs.statSync(f);
          entries.push({ file: f, size: st.size, at: st.atimeMs || st.mtimeMs });
        } catch {
          /* 跳过 */
        }
      }
    }
  } catch {
    return 0;
  }

  entries.sort((a, b) => a.at - b.at);

  const target = Math.floor(maxBytes * 0.8);
  let freed = 0;
  for (const e of entries) {
    if (used - freed <= target) break;
    try {
      fs.unlinkSync(e.file);
      fs.unlinkSync(e.file.replace(/\.bin$/, '.json'));
      freed += e.size;
    } catch {
      /* 删不掉就算了 */
    }
  }
  used = Math.max(0, used - freed);
  return freed;
}

function clearAll() {
  let removed = 0;
  try {
    const dir = cacheDir();
    if (fs.existsSync(dir)) {
      for (const sub of fs.readdirSync(dir)) {
        const p = path.join(dir, sub);
        try {
          removed += fs.rmSync(p, { recursive: true, force: true }) ? 1 : 0;
        } catch {
          /* 跳过 */
        }
      }
    }
  } catch {
    /* 忽略 */
  }
  used = 0;
  stats = { hits: 0, misses: 0, stores: 0, bytesServed: 0 };
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
  } catch {
    /* 忽略 */
  }
  return { ok: true, removed };
}

function noteMiss() {
  stats.misses += 1;
}

function getStats() {
  return {
    ...stats,
    used,
    maxBytes,
    enabled,
    dir: cacheDir(),
    percent: maxBytes ? Math.round((used / maxBytes) * 100) : 0,
  };
}

module.exports = {
  init,
  setEnabled,
  getEnabled,
  setMaxBytes,
  isCacheable,
  read,
  write,
  noteMiss,
  evict,
  clearAll,
  measure,
  getStats,
  cacheDir,
};
