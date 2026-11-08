'use strict';

// 广告拦截 + 无用资源剔除。
//
// 拦截名单不是拍脑袋写的，是抓了 e621 首页和帖子页的真实 HTML 之后定的：
//   rv.e621.net  —— 这是 Revive Adserver，e621 自己的广告服务器。
//                   它发 avw.php 出广告图，发 ck.php 记点击跳转。
//                   页面上统计到 138072 次引用，几乎每个页面都有几个插播位。
//
// 除了广告域名，还挡掉一批常见的统计、埋点、社交按钮域名，
// 这些域名的请求对显示 e621 没有任何用处，只会拖慢加载。

const BLOCK_HOSTS = new Set([
  // e621 自己的广告服务器
  'rv.e621.net',

  // 统计 / 埋点
  'google-analytics.com',
  'www.google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'www.googletagmanager.com',
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'adservice.google.com',
  'scorecardresearch.com',
  'quantserve.com',
  'hotjar.com',
  'static.hotjar.com',
  'segment.io',
  'api.segment.io',
  'mixpanel.com',
  'api.mixpanel.com',
  'amplitude.com',
  'api.amplitude.com',
  'sentry.io',
  'o0.ingest.sentry.io',
  'newrelic.com',
  'nr-data.net',

  // 社交按钮 / 外部小挂件
  'connect.facebook.net',
  'platform.twitter.com',
  'syndication.twitter.com',
  'cdn.syndication.twimg.com',
  'platform.linkedin.com',
  'ads.linkedin.com',
  'bat.bing.com',
  'c.amazon-adsystem.com',
  'amazon-adsystem.com',

  // 常见广告联盟
  'adnxs.com',
  'securepubads.g.doubleclick.net',
  'pagead2.googlesyndication.com',
  'taboola.com',
  'outbrain.com',
  'criteo.com',
  'static.criteo.net',
  'pubmatic.com',
  'rubiconproject.com',
  'openx.net',
  'smartadserver.com',
  'casalemedia.com',
  'adform.net',
]);

// 命中这些路径片段的，也挡掉
const BLOCK_PATTERNS = [
  /^\/www\/delivery\//i,      // Revive Adserver 的标准路径
  /\/ads?\/[^/]*\.(gif|png|jpe?g|webp)(\?|$)/i,
  /\/advert(isement|ising)?\//i,
  /\/banners?\//i,
  /\/pagead\//i,
  /\/analytics\.js$/i,
  /\/gtag\/js/i,
  /\/gtm\.js$/i,
  /\/piwik\.(js|php)/i,
  /\/matomo\.(js|php)/i,
];

// e621 上的「无用资源」：页面会拉一些对看内容没帮助的东西。
// 这个开关保守一点，只挡明确没用的。
const JUNK_PATTERNS = [
  // 随机吉祥物，每次进首页都会换一张，纯装饰
  /^\/images\/mascots\//i,
  // 计数器数字图，页脚的访问次数
  /^\/images\/counter\//i,
];

let enabled = true;
let trimJunk = false;
let stats = { blocked: 0, blockedHosts: {}, trimmed: 0 };

function setEnabled(on) {
  enabled = on !== false;
}

function getEnabled() {
  return enabled;
}

function setTrimJunk(on) {
  trimJunk = on === true;
}

function getTrimJunk() {
  return trimJunk;
}

// 判断一个请求要不要挡。返回 null 表示放行，返回字符串表示原因。
function shouldBlock(host, urlPath) {
  if (!enabled) return null;

  const h = String(host || '').toLowerCase();
  const p = String(urlPath || '');

  if (BLOCK_HOSTS.has(h)) return '广告域名';

  for (const re of BLOCK_PATTERNS) {
    if (re.test(p)) return '广告路径';
  }

  if (trimJunk) {
    for (const re of JUNK_PATTERNS) {
      if (re.test(p)) return '无用资源';
    }
  }

  return null;
}

function note(reason, host) {
  if (reason === '无用资源') {
    stats.trimmed += 1;
  } else {
    stats.blocked += 1;
    stats.blockedHosts[host] = (stats.blockedHosts[host] || 0) + 1;
  }
}

function getStats() {
  const top = Object.entries(stats.blockedHosts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([host, n]) => ({ host, n }));
  return {
    enabled,
    trimJunk,
    blocked: stats.blocked,
    trimmed: stats.trimmed,
    top,
  };
}

function resetStats() {
  stats = { blocked: 0, blockedHosts: {}, trimmed: 0 };
}

module.exports = {
  BLOCK_HOSTS,
  setEnabled,
  getEnabled,
  setTrimJunk,
  getTrimJunk,
  shouldBlock,
  note,
  getStats,
  resetStats,
};
