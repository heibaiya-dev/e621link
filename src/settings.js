'use strict';

// 设置。存在 %APPDATA%\E621Link\settings.json

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  port: 0,              // 0 = 每次自动挑一个空端口
  trustCa: true,        // 启动时把本机证书装进当前用户的信任区
  rewriteImages: true,  // 把 static1.e621.net 换成 static1.e926.net
  autoStopOnQuit: true, // 关软件时把系统代理撤掉

  minimizeToTray: true, // 关窗口时缩到托盘，不退出
  trayHintShown: false, // 第一次缩托盘时的气泡提示有没有弹过

  useCache: true,       // 本地缓存
  cacheMB: 512,         // 缓存最多占多少 MB
  blockAds: true,       // 广告拦截
  trimJunk: false,      // 顺手挡掉装饰图之类没用资源

  theme: 'system',      // system | light | dark
  rememberWindow: true,
  windowWidth: 1120,
  windowHeight: 780,
  startMaximized: false,
};

const BOOL_KEYS = [
  'trustCa', 'rewriteImages', 'autoStopOnQuit',
  'minimizeToTray', 'trayHintShown',
  'useCache', 'blockAds', 'trimJunk',
  'rememberWindow', 'startMaximized',
];
const ALL_KEYS = Object.keys(DEFAULTS);

let cache = null;

function dir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'E621Link');
}

function file() {
  return path.join(dir(), 'settings.json');
}

function pick(obj) {
  const out = {};
  for (const k of ALL_KEYS) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function normalize(s) {
  s.port = Math.min(65535, Math.max(0, Math.round(Number(s.port) || 0)));
  s.windowWidth = Math.min(3840, Math.max(720, Math.round(Number(s.windowWidth) || DEFAULTS.windowWidth)));
  s.windowHeight = Math.min(2160, Math.max(540, Math.round(Number(s.windowHeight) || DEFAULTS.windowHeight)));
  s.cacheMB = Math.min(8192, Math.max(64, Math.round(Number(s.cacheMB) || DEFAULTS.cacheMB)));
  if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = DEFAULTS.theme;
  for (const k of BOOL_KEYS) s[k] = s[k] !== false && s[k] !== 'false';
  return s;
}

function load() {
  if (cache) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8')) || {};
  } catch {
    raw = {};
  }
  cache = normalize({ ...DEFAULTS, ...pick(raw) });
  return cache;
}

function get() {
  return load();
}

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
