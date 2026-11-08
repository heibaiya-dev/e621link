'use strict';

// 本地缓存。
//
// 目标是把图片和静态文件存到硬盘上，第二次打开同一个页面直接从本地读，
// 不用再去网上拉。对 e621 这种图片多的站点效果最明显。
//
// 做法很朴素：URL 算个哈希当文件名，旁边一个 .meta.json 记状态码、类型、时间。
// 超过设定的总量就按「最久没用的先删」清掉。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function appDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'E621Link');
}

function cacheDir() {
  return path.join(appDir(), 'cache');
}

let enabled = true;
let maxBytes = 512 * 1024 * 1024; // 默认 512MB
let used = 0;
let stats = { hits: 0, misses: 0, stores: 0, bytesServed: 0 };

// 这些类型值得缓存。HTML 和 JSON 不缓存——e621 的页面带登录态和一次性 token，
// 缓存了会串号，得不偿失。
const CACHEABLE = /^(image\/|font\/|application\/font|text\/css|application\/javascript|text\/javascript)/i;

// 只有在这些域名下的资源才缓存
const CACHE_HOSTS = new Set([
  'static1.e621.net', 'static2.e621.net', 'static3.e621.net',
  'static1.e926.net',
]);

function keyFor(host, urlPath) {
  return crypto.createHash('sha1').update(String(host).toLowerCase() + urlPath).digest('hex');
}

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

function setMaxBytes(n) {
  maxBytes = Math.max(16 * 1024 * 1024, Math.round(Number(n) || maxBytes));
}

// 扫一遍目录，算出现在占了多少
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

function isCacheable(host, method, contentType) {
  if (!enabled) return false;
  if (String(method).toUpperCase() !== 'GET') return false;
  if (!CACHE_HOSTS.has(String(host || '').toLowerCase())) return false;
  return CACHEABLE.test(contentType || '');
}

// 读缓存。命中返回 { body, contentType }, 没命中返回 null
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
  if (used > maxBytes) evict();
  return true;
}

// 超了就删最久没用过的，一直到降到八成
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
