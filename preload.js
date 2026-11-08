'use strict';

// preload：只暴露必要的接口给界面用。

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const h = (_e, s) => cb(s);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('e621', {
  info: () => ipcRenderer.invoke('app:info'),

  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  quit: () => ipcRenderer.invoke('app:quit'),

  win: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onState: (cb) => on('window:state', cb),
  },

  // 一键启动 / 停止
  launch: () => ipcRenderer.invoke('app:launch'),
  stop: () => ipcRenderer.invoke('app:stop'),
  onRunning: (cb) => on('app:running', cb),

  // 代理
  proxy: {
    state: () => ipcRenderer.invoke('proxy:state'),
    log: () => ipcRenderer.invoke('proxy:log'),
    onLog: (cb) => on('proxy:log', cb),
  },

  // 缓存
  cache: {
    stats: () => ipcRenderer.invoke('cache:stats'),
    clear: () => ipcRenderer.invoke('cache:clear'),
    openFolder: () => ipcRenderer.invoke('cache:openFolder'),
  },

  // 本机证书
  ca: {
    state: () => ipcRenderer.invoke('ca:state'),
    trust: () => ipcRenderer.invoke('ca:trust'),
    untrust: () => ipcRenderer.invoke('ca:untrust'),
    openFolder: () => ipcRenderer.invoke('ca:openFolder'),
  },

  check: () => ipcRenderer.invoke('net:check'),

  copy: (text) => ipcRenderer.invoke('app:copy', text),
  openFile: (p) => ipcRenderer.invoke('app:openFile', p),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
});
