'use strict';

// 本地代理。
//
// 浏览器把 e621 的流量交给它，它在中间拆开 TLS，处理完再用自己的网络栈
// （开着加密 DNS + ECH）发出去。这样能做三件事：
//   1) 请求 static1.e621.net 的，实际去 static1.e926.net 取——图片就出来了
//   2) 顺手把页面里的 e621 图床地址改掉，省得再发一次注定失败的请求
//   3) 往页面里塞汉化脚本，并且做缓存和广告拦截
//
// 上游不用 Node 自己的 https，用 Electron 的 session.fetch，因为只有它带着
// DoH + ECH 的配置。这是整套方案能成立的根本。

const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const ca = require('./ca');
const cache = require('./cache');
const blocker = require('./blocker');

// ── 要处理的域名 ──────────────────────────────────────────────
const SITE_HOSTS = new Set(['e621.net', 'www.e621.net']);
const IMAGE_HOST = 'static1.e621.net';
const IMAGE_HOST_ALT = ['static2.e621.net', 'static3.e621.net'];
const IMAGE_TARGET = 'static1.e926.net';

// 广告域名不走中间人，直接拦掉。所以这里要把它们也算作「我们管的域名」，
// 否则会被当成普通域名原样隧道穿过去，就拦不住了。
function isTargetHost(host) {
  const h = String(host || '').toLowerCase();
  if (blocker.BLOCK_HOSTS.has(h)) return true;
  return SITE_HOSTS.has(h) || h === IMAGE_HOST || IMAGE_HOST_ALT.includes(h);
}

// 上游该去哪个域名
function upstreamHost(host) {
  const h = String(host || '').toLowerCase();
  if (h === IMAGE_HOST || IMAGE_HOST_ALT.includes(h)) return IMAGE_TARGET;
  return host;
}

// ── HTTP 报文解析 ─────────────────────────────────────────────

function parseRequest(buf) {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const head = buf.slice(0, end).toString('latin1');
  const lines = head.split('\r\n');
  const [method, url, version] = lines[0].split(' ');
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const len = Number(headers['content-length'] || 0);
  const total = end + 4 + len;
  if (buf.length < total) return null;
  return { method, url, version, headers, body: buf.slice(end + 4, total), consumed: total };
}

const SKIP_REQ_HEADERS = new Set([
  'host', 'connection', 'proxy-connection', 'accept-encoding', 'content-length',
  'keep-alive', 'upgrade', 'te', 'trailer',
]);

const SKIP_RES_HEADERS = new Set([
  'content-encoding', 'transfer-encoding', 'connection', 'content-length',
  'keep-alive', 'alt-svc',
]);

// 标准上只能有一个值的头。上游偶尔发两份，fetch 会拼成「a, b」，
// 浏览器就当坏值读，只能取第一个。
//
// 注意 content-security-policy 不在这里：它本身就可能含逗号，
// 按逗号切会把策略截断，整站脚本就全停了。
const SINGLE_VALUED = new Set([
  'x-frame-options',
  'x-content-type-options',
  'x-xss-protection',
  'referrer-policy',
  'content-disposition',
]);

const TEXTUAL = /^(text\/|application\/(json|javascript|xml|xhtml)|image\/svg)/i;

// 把页面里写死的图床地址换掉。只动文本类响应，二进制一律不碰。
function rewriteBody(host, contentType, body) {
  if (!SITE_HOSTS.has(String(host || '').toLowerCase())) return body;
  if (!TEXTUAL.test(contentType || '')) return body;

  const text = body.toString('utf8');
  if (!text.includes('static1.e621.net') && !text.includes('static2.e621.net') && !text.includes('static3.e621.net')) {
    return body;
  }
  const fixed = text
    .replace(/static1\.e621\.net/gi, IMAGE_TARGET)
    .replace(/static2\.e621\.net/gi, IMAGE_TARGET)
    .replace(/static3\.e621\.net/gi, IMAGE_TARGET);
  return Buffer.from(fixed, 'utf8');
}

function decompress(body, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc === 'gzip') return zlib.gunzipSync(body);
    if (enc === 'deflate') return zlib.inflateSync(body);
    if (enc === 'br') return zlib.brotliDecompressSync(body);
    if (enc === 'zstd') return zlib.zstdDecompressSync(body);
  } catch {
    return null;
  }
  return body;
}

// ── 代理本体 ─────────────────────────────────────────────────

let upstreamSession = null;
let server = null;
let actualPort = 0;
let stats = { requests: 0, images: 0, rewritten: 0, errors: 0, cacheHits: 0, retries: 0 };
let onLog = () => {};
let rewriteEnabled = true;

function log(line) {
  onLog(line);
}

function setRewrite(on) {
  rewriteEnabled = on !== false;
}

function getRewrite() {
  return rewriteEnabled;
}

// e621 的连接会间歇性被重置，同一份代码多跑几次，失败的分区在变。
// 实测下来这不是配置问题，是网络层面时不时掐一下。所以必须重试。
const RETRY_ERRORS = /ECONNRESET|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ECONNREFUSED|ETIMEDOUT|aborted|ERR_SSL|ERR_TIMED_OUT|net::ERR/i;

// Electron 的 fetch 失败时抛的是「fetch failed」这种笼统的话，
// 真正的错误码藏在 cause 里面。这里把整条链拼起来判断。
function errText(e) {
  if (!e) return '';
  const parts = [];
  let cur = e;
  let guard = 0;
  while (cur && guard++ < 6) {
    parts.push(String(cur.message || cur));
    cur = cur.cause;
  }
  parts.push(String(e.code || ''));
  return parts.join(' | ');
}

// 这个 session 绝对不能自己存 cookie。
//
// 实测（本地回显服务器）：session 的 cookie jar 里只要已经有 cookie，
// 我们手动设的 Cookie 头就会被整个忽略，V8 那边直接换成 jar 里的旧值。
// 结果就是浏览器每发一次请求，上游都用代理自己的旧 session 顶掉浏览器的新 session，
// 页面一律当成新访客 —— 表现就是每进一个页面都要重新同意协议、登录态丢失。
//
// 真正管用的是 upstream 那边装的 onHeadersReceived：上游回来的 set-cookie
// 全丢掉，jar 里永远不会进东西。getSetCookie() 读的是响应本身，
// 不受影响，所以转给浏览器的 cookie 还是完整的。
//
// 这里只在开代理时清一次，清掉老版本可能留下的残留。
// 别每次请求都清 —— cookies.get({}) 要跨进程问一遍全部 cookie，
// 实测每次要花好几百毫秒，搜索框补全那种小请求根本扛不住。
async function clearJarOnce() {
  if (!upstreamSession) return;
  try {
    const list = await upstreamSession.cookies.get({});
    if (list && list.length) {
      await upstreamSession.clearStorageData({ storages: ['cookies'] });
    }
  } catch {
    /* 清不掉就靠 onHeadersReceived 兜着 */
  }
}

// 把 DNS 缓存清掉，逼 Chromium 重新走一遍 DoH。
//
// 为什么要这个：某些网络里 e621 是按域名（明文 SNI）掐的，一掐就是一阵。
// 而 ECH 能不能生效取决于 HTTPS 记录拿得准不准。缓存里要是存了个坏的、
// 或者过期时刚好撞上封锁，一直用缓存就会一直失败。清一次让它重查，
// 运气好就换到一条能通的路上。
//
// 这个只清 e621 相关的解析结果，不影响别的站。
let lastResolverClear = 0;
async function clearResolverFor(host) {
  if (!upstreamSession) return;
  const now = Date.now();
  // 至少隔 3 秒清一次，别把重试全耗在清缓存上
  if (now - lastResolverClear < 3000) return;
  lastResolverClear = now;
  try {
    if (typeof upstreamSession.clearHostResolverCache === 'function') {
      await upstreamSession.clearHostResolverCache();
    }
  } catch {
    /* 清不掉就算了，重试本身也有机会 */
  }
}

async function fetchOnce(host, rawReq) {
  const target = upstreamHost(host);
  const url = 'https://' + target + rawReq.url;
  const headers = {};
  for (const [k, v] of Object.entries(rawReq.headers)) {
    if (SKIP_REQ_HEADERS.has(k)) continue;
    headers[k] = v;
  }
  // 要原文，方便我们改内容
  headers['accept-encoding'] = 'gzip';

  const init = { method: rawReq.method, headers, cache: 'no-store', redirect: 'manual' };
  if (rawReq.body && rawReq.body.length) init.body = rawReq.body;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  init.signal = ctl.signal;

    const t0 = Date.now();
  try {
    const r = await upstreamSession.fetch(url, init);

    let body = Buffer.from(await r.arrayBuffer());
    const contentType = r.headers.get('content-type') || '';

    const outHeaders = {};
    r.headers.forEach((v, k) => {
      const name = k.toLowerCase();
      if (SKIP_RES_HEADERS.has(name)) return;
      if (name === 'set-cookie') return; // 单独处理，见下

      // 有些头部标准上只能有一个值。上游发了两份，fetch 会拼成「a, b」，
      // 浏览器读到的就是坏值。实测 e621 首页带着这三条：
      //   x-frame-options: SAMEORIGIN, deny
      //   x-content-type-options: nosniff, nosniff
      //   x-xss-protection: 0, 1; mode=block
      // 这种取第一个，别原样带过去。
      if (SINGLE_VALUED.has(name) && v.includes(', ')) {
        outHeaders[name] = v.split(', ')[0];
        return;
      }
      outHeaders[name] = v;
    });

    // set-cookie 单独取。fetch 把多条拼成一条「a=1, b=2」，浏览器解析不了，
    // 整条都丢掉——表现就是每进一个新页面登录态和「同意用户协议」都没了。
    if (typeof r.headers.getSetCookie === 'function') {
      const cookies = r.headers.getSetCookie();
      if (cookies && cookies.length) outHeaders['set-cookie'] = cookies;
    }

    if (target === host) {
      // 同域名，把图床地址换掉，并把压缩解开
      const plain = decompress(body, r.headers.get('content-encoding'));
      if (plain) {
        const out = rewriteEnabled ? rewriteBody(host, contentType, plain) : plain;
        if (out !== plain) stats.rewritten += 1;
        body = out;
        delete outHeaders['content-encoding'];
      }
    } else {
      // 图片域名换过了，内容原样返回
      stats.images += 1;
    }

    return {
      status: r.status,
      statusText: r.statusText || '',
      headers: outHeaders,
      contentType,
      body,
      ms: Date.now() - t0,
      target,
    };
  } finally {
    clearTimeout(timer);
  }
}

// 搜索框补全的结果临时放内存里。
//
// 为什么单独搞一套：补全接口返回的是 JSON，磁盘缓存那套只管图片和静态文件，
// 不管 JSON（怕把登录态的响应存下来）。补全这里给的只是词条列表，
// 跟登录状态无关，而且过期时间前端本来就传了 expiry=7，
// 但那个参数只是给 e621 提示，不拦着我们自己存。
//
// 存多久：词条列表基本不变，留 10 分钟。
// 边打边删很常见（打了又退格再打一遍），命中就不用再等一次网络。
const autoCache = new Map();
const AUTO_TTL = 10 * 60 * 1000;
const AUTO_MAX = 500;

// 正在拉取的请求。同一个词同时来好几次就只发一次，其余的等结果。
const autoInflight = new Map();

function autoKey(host, urlPath) {
  return String(host).toLowerCase() + '|' + urlPath;
}

function autoGet(host, urlPath) {
  const k = autoKey(host, urlPath);
  const hit = autoCache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > AUTO_TTL) {
    autoCache.delete(k);
    return null;
  }
  return hit;
}

function autoPut(host, urlPath, body) {
  const k = autoKey(host, urlPath);
  autoCache.set(k, { at: Date.now(), body });
  // 别让它无限长
  if (autoCache.size > AUTO_MAX) {
    const first = autoCache.keys().next().value;
    autoCache.delete(first);
  }
}

// 「清空缓存」按钮和 stop() 时调用
function clearMemoryCache() {
  autoCache.clear();
}

async function fetchUpstream(host, rawReq) {
  const urlPath = rawReq.url;
  const method = String(rawReq.method || 'GET').toUpperCase();
  const isAutocompleteReq = method === 'GET' && /\/autocomplete(\.json)?/i.test(urlPath);

  // 补全只看刚请求过没有（同一个词短时间内重复要）。
  // 一律去 e621 拿真实结果，本地不攒词表 —— 本地攒的会漏词，
  // 拼出来的结果也跟 e621 自己的排序对不上。
  if (isAutocompleteReq) {
    const hit = autoGet(host, urlPath);
    if (hit) {
      stats.cacheHits += 1;
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        contentType: 'application/json',
        body: hit.body,
        ms: 0,
        target: host,
        fromCache: true,
      };
    }

    // 同一个词正在拉了就别再发一遍，等那次的结果。
    // 边打边删很容易对同一个词发好几次，这样能省掉重复的网络往返。
    const inflight = autoInflight.get(autoKey(host, urlPath));
    if (inflight) {
      const body = await inflight.catch(() => null);
      if (body) return body;
    }
  }

  // 1) 先看缓存。图片和静态文件命中就直接返回，一次网都不发。
  if (method === 'GET') {
    const hit = cache.read(host, urlPath);
    if (hit) {
      stats.cacheHits += 1;
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': hit.contentType || 'application/octet-stream' },
        contentType: hit.contentType || '',
        body: hit.body,
        ms: 0,
        target: host,
        fromCache: true,
      };
    }
    cache.noteMiss();
  }

  // 2) 没有就发请求。链接被掐就重试。
  //
  // e621 这边第一次请求失败是常态（Cloudflare 那边随机掐），
  // 同一个分区立刻再试基本上就通了。所以重试次数给足。
  //
  // 补全请求：把整段拉取包起来，同一个词同时只跑一次。
  // 后来的人直接拿这一次的结果，不重复发网络请求。
  if (isAutocompleteReq) {
    const key = autoKey(host, urlPath);
    const existing = autoInflight.get(key);
    if (existing) return existing;

    const task = (async () => {
      try {
        const res = await fetchWithRetry(host, rawReq, true);
        if (res.status === 200 && res.body && res.body.length) {
          autoPut(host, urlPath, res.body);
        }
        return res;
      } finally {
        autoInflight.delete(key);
      }
    })();

    autoInflight.set(key, task);
    return task;
  }

  return fetchWithRetry(host, rawReq, false);
}

// 一个请求最多折腾多久
//
// 页面和接口给 25 秒：有些网络里 e621 是按域名掐的，一掐就是几十秒，
// 重试几次就过去了。等得久一点，总比直接把 ERR_CONNECTION_RESET 甩给用户好。
// 浏览器那边默认等 30 秒以上才报错，25 秒还在范围内。
// 搜索框补全只给 1.5 秒：前端 225ms 就去拿结果了，等久了词框不弹，
// 倒不如赶紧失败，让前端走它自己的逻辑。
const RETRY_BUDGET_MS = { autocomplete: 1500, normal: 25000 };

async function fetchWithRetry(host, rawReq, isAutocomplete) {
  const urlPath = rawReq.url;
  const method = String(rawReq.method || 'GET').toUpperCase();

  const budget = isAutocomplete ? RETRY_BUDGET_MS.autocomplete : RETRY_BUDGET_MS.normal;
  const startedAt = Date.now();

  let lastErr = null;
  let attempt = 0;

  // 一直试到时间用完，而不是固定试几次。
  // 固定次数的问题是：掐个几十秒的网络，5 次 3 秒就耗光了，然后一路报错。
  while (Date.now() - startedAt < budget) {
    attempt += 1;
    try {
      const res = await fetchOnce(host, rawReq);

      // 成功的话顺手存一份
      if (method === 'GET' && cache.isCacheable(host, 'GET', res.contentType)) {
        cache.write(host, urlPath, res.status, res.contentType, res.body);
      }
      return res;
    } catch (e) {
      lastErr = e;
      stats.retries += 1;
      const msg = errText(e);

      const left = budget - (Date.now() - startedAt);
      if (left <= 0) break;

      // 连续失败说明不是偶发，可能是 DNS 缓存里存了个坏的 ECH 配置，
      // 或者刚好处在封锁的那一阵里。清一下缓存让它重新查。
      if (attempt >= 2) await clearResolverFor(host);

      // 403/429 是被限流了，硬重试没用，等久一点
      const isRate = /403|429|rate.?limit/i.test(msg);
      // 补全：别等，赶紧重发
      // 其他：前几次快速试（多半是随机掐，立刻再试就通了），
      //       后面越失败等越久，免得一直撞在封锁的枪口上
      const wait = isAutocomplete
        ? (isRate ? 120 : 25)
        : isRate
          ? Math.min(1200 + attempt * 700, 4000)
          : Math.min(120 * Math.pow(1.6, attempt), 2500);

      await new Promise((r) => setTimeout(r, Math.min(wait, Math.max(left, 1))));
    }
  }

  // 时间用完还没通。把失败次数带上，方便诊断。
  const base = lastErr ? errText(lastErr) : '连不上';
  const err = new Error(`${base}（试了 ${attempt} 次）`);
  err.attempts = attempt;
  throw err;
}

function buildResponse(res) {
  const lines = [`HTTP/1.1 ${res.status} ${res.statusText || ''}`.trim()];
  const headers = { ...res.headers, 'content-length': String(res.body.length) };

  for (const [k, v] of Object.entries(headers)) {
    // set-cookie 是多条，每条单独一行。别的头部照常一行。
    if (k.toLowerCase() === 'set-cookie' && Array.isArray(v)) {
      for (const one of v) lines.push(`set-cookie: ${one}`);
      continue;
    }
    if (Array.isArray(v)) {
      for (const one of v) lines.push(`${k}: ${one}`);
      continue;
    }
    lines.push(`${k}: ${v}`);
  }

  lines.push('connection: keep-alive');
  return Buffer.concat([Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1'), res.body]);
}

function plainError(status, text) {
  return buildResponse({
    status,
    statusText: 'Error',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: Buffer.from(text, 'utf8'),
  });
}

// 浏览器要连一个我们不管的域名：原样把字节转发过去
function tunnel(socket, host, port) {
  const up = net.connect(port || 443, host);
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  up.pipe(socket);
  socket.pipe(up);
}

function handleConnect(socket, host, port) {
  if (!isTargetHost(host)) {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    tunnel(socket, host, port);
    return;
  }

  // 广告域名：连证书都不发，直接在隧道外面拒掉。
  // 浏览器会当成「这个请求失败了」，页面照常显示，广告位就是空的。
  const blockReason = blocker.shouldBlock(host, '/');
  if (blockReason) {
    blocker.note(blockReason, String(host || '').toLowerCase());
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    return;
  }

  // 关掉图片替换的时候，图片域名也原样穿过去（这时候图会是空的，但用户要求不换）
  const isImageHost = IMAGE_HOST === String(host || '').toLowerCase()
    || IMAGE_HOST_ALT.includes(String(host || '').toLowerCase());
  if (isImageHost && !rewriteEnabled) {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    tunnel(socket, host, port);
    return;
  }

  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  let pair;
  try {
    const localCa = ca.readCa() || ca.ensureCa();
    pair = ca.leafFor(host, localCa);
  } catch (e) {
    socket.destroy();
    log('签发证书失败 ' + host + '：' + e.message + '＞﹏＜');
    return;
  }

  const secure = new tls.TLSSocket(socket, {
    isServer: true,
    key: pair.key,
    cert: pair.cert,
    ALPNProtocols: ['http/1.1'],
    // 只让 HTTP/1.1 过，HTTP/2 要用专门的库，这里用不上
    honorCipherOrder: true,
  });

  let buf = Buffer.alloc(0);

  secure.on('data', async (data) => {
    buf = Buffer.concat([buf, data]);

    for (;;) {
      const req = parseRequest(buf);
      if (!req) break;
      buf = buf.slice(req.consumed);

      // 路径级拦截。域名级的在上面 CONNECT 那一步就挡掉了，
      // 这里管的是同一个域名下不该加载的路径（广告图、埋点脚本、装饰图）。
      const why = blocker.shouldBlock(host, req.url);
      if (why) {
        blocker.note(why, String(host || '').toLowerCase());
        const empty = /\b(image|script|style|font)\b/i.test(
          (req.headers.accept || '') + ' ' + (req.headers['sec-fetch-dest'] || '')
        );
        if (!secure.writableEnded) {
          secure.write(
            empty
              ? buildResponse({
                  status: 204,
                  statusText: 'No Content',
                  headers: { 'content-type': 'text/plain' },
                  body: Buffer.alloc(0),
                })
              : plainError(403, '已拦截：' + why)
          );
        }
        continue;
      }

      try {
        const up = await fetchUpstream(host, req);
        stats.requests += 1;
        if (!secure.writableEnded) secure.write(buildResponse(up));
        const tag = up.fromCache ? '缓存' : String(up.ms) + 'ms';
        log(`${req.method} ${host}${req.url} → ${up.target} ${up.status} ${up.body.length}B ${tag}`);
      } catch (e) {
        stats.errors += 1;
        if (!secure.writableEnded) secure.write(plainError(502, '代理没有连上：' + e.message));
        log(`${req.method} ${host}${req.url} → 失败！ ${e.message}`);
      }
    }
  });

  secure.on('error', () => socket.destroy());
  secure.on('close', () => socket.destroy());
}

function onConnection(socket) {
  socket.once('data', (chunk) => {
    const first = chunk.toString('latin1');

    const m = first.match(/^CONNECT\s+(\[[^\]]+\]|[^:\s]+):(\d+)/i);
    if (m) {
      handleConnect(socket, m[1], Number(m[2]));
      return;
    }

    // 明文 HTTP 请求（少见，但也挡一下）
    const pm = first.match(/^([A-Z]+)\s+https?:\/\/([^/\s:]+)(?::(\d+))?(\S*)\s+HTTP/i);
    if (pm) {
      socket.end(plainError(400, '这个代理只接受 HTTPS 请求。'));
      return;
    }

    socket.end(plainError(400, '看不懂这个请求。'));
  });
  socket.on('error', () => {});
}

// ── 对外接口 ─────────────────────────────────────────────────

function start(session, options = {}) {
  upstreamSession = session;
  onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  stats = { requests: 0, images: 0, rewritten: 0, errors: 0, cacheHits: 0, retries: 0 };

  // 开代理时清一次 cookie 残留。放这儿是因为只做一次，不拖慢每个请求。
  // 这个清是异步的，有点残留也不影响：onHeadersReceived 已经拦住了。
  clearJarOnce().catch(() => {});

  return new Promise((resolve) => {
    server = net.createServer(onConnection);

    server.on('error', (e) => {
      resolve({ ok: false, error: '代理没起来：' + e.message });
    });

    server.listen(options.port || 0, '127.0.0.1', () => {
      actualPort = server.address().port;
      log('代理已启动 127.0.0.1:' + actualPort);
      resolve({ ok: true, port: actualPort });
    });
  });
}

function stop() {
  if (!server) return { ok: true };
  try {
    server.close();
  } catch {
    /* 关不上就算了 */
  }
  server = null;
  actualPort = 0;
  // 停止时把补全缓存清掉，下次启动重新来
  autoCache.clear();
  return { ok: true };
}

function port() {
  return actualPort;
}

function isRunning() {
  return !!server;
}

function getStats() {
  return { ...stats };
}

function setTrimJunk(on) {
  blocker.setTrimJunk(on);
}

function setCache(on) {
  cache.setEnabled(on);
}

function setBlock(on) {
  blocker.setEnabled(on);
}

function getExtras() {
  return { cache: cache.getStats(), blocker: blocker.getStats() };
}

// 给系统代理用的那条规则。没启动就返回空串，别拼出 :0 这种假地址。
function proxyRule() {
  if (!actualPort) return '';
  return `http=127.0.0.1:${actualPort};https=127.0.0.1:${actualPort}`;
}

module.exports = {
  IMAGE_TARGET,
  IMAGE_HOST,
  start,
  stop,
  port,
  isRunning,
  getStats,
  getExtras,
  proxyRule,
  isTargetHost,
  upstreamHost,
  setRewrite,
  getRewrite,
  setCache,
  setBlock,
  setTrimJunk,
  clearMemoryCache,
};
