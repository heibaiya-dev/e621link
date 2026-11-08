'use strict';

// preload：只暴露必要的接口给界面用。
//
// 这个文件是界面（渲染进程）跟主进程之间唯一的通道。
// Electron 默认不允许网页直接调 Node 的 API（那样随便一个 XSS 就能读硬盘、
// 执行命令），所以中间要隔一层：preload 跑在有权限的上下文里，
// 用 contextBridge 把挑好的函数挂到 window 上，界面只能看到这些。
//
// 约定：
//   - 界面里所有调用都长成 window.e621.xxx()，没有别的入口
//   - 方法名用动词开头，参数尽量简单（能传对象就传对象，别传一堆位置参数）
//   - 主进程那边用 ipcMain.handle 注册同名 channel，一一对应
//
// 加新接口的时候两个地方都要改：这里加一行，main.js 里加一个 ipcMain.handle。

const { contextBridge, ipcRenderer } = require('electron');

// 包一层事件订阅，返回一个取消订阅的函数。
//
// 为什么要包：ipcRenderer.on 的回调第一个参数是 event 对象，
// 里面带着 sender 之类的东西。直接透给界面等于把内部对象漏出去了，
// 而且界面那边每次都要写 (_e, data) 这种没意义的第一参数。
// 这里剥掉只留数据。
//
// 返回取消函数是必须的：Electron 里监听器不手动移除就会一直积累，
// 界面来回切页签、反复打开设置，监听器越堆越多，
// 最后一次事件触发几十个回调，内存也一路涨。
const on = (channel, cb) => {
  const h = (_e, s) => cb(s);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

// 挂到 window.e621 上。这个对象是界面唯一的对外接口。
contextBridge.exposeInMainWorld('e621', {
  // 程序信息：版本号、Electron 版本、设置内容、运行状态、端口、证书状态
  info: () => ipcRenderer.invoke('app:info'),

  // 设置。saveSettings 传的是「要改的字段」，不用传完整的设置对象
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  // 重启程序。改端口、改主题这类需要重新初始化才生效的设置，存完调这个
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  quit: () => ipcRenderer.invoke('app:quit'),

  // 窗口控制。自己画标题栏，所以最小化/最大化/关闭要手动接
  win: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    // 最大化状态变了会推过来，界面据此换图标
    onState: (cb) => on('window:state', cb),
  },

  // 一键启动 / 停止
  // onRunning 是主进程主动推的：代理自己挂了、或者用户在托盘里退出，
  // 界面得跟着变，不能还显示「运行中」
  launch: () => ipcRenderer.invoke('app:launch'),
  stop: () => ipcRenderer.invoke('app:stop'),
  onRunning: (cb) => on('app:running', cb),

  // 代理
  // state 是当前状态快照，log 是最近若干条日志
  // onLog 每次有新日志推一条过来，日志页用它实时刷新
  proxy: {
    state: () => ipcRenderer.invoke('proxy:state'),
    log: () => ipcRenderer.invoke('proxy:log'),
    onLog: (cb) => on('proxy:log', cb),
  },

  // 缓存
  cache: {
    stats: () => ipcRenderer.invoke('cache:stats'),
    clear: () => ipcRenderer.invoke('cache:clear'),
    // 打开缓存目录。用系统资源管理器打开，不是程序内浏览
    openFolder: () => ipcRenderer.invoke('cache:openFolder'),
  },

  // 本机证书
  // trust 装进信任区，untrust 删掉。这两个都会弹系统确认框，
  // 但装到「当前用户」不需要管理员密码
  ca: {
    state: () => ipcRenderer.invoke('ca:state'),
    trust: () => ipcRenderer.invoke('ca:trust'),
    untrust: () => ipcRenderer.invoke('ca:untrust'),
    openFolder: () => ipcRenderer.invoke('ca:openFolder'),
  },

  // 连通性自检。点「检查连接」时调，返回主站/图片服务器各自通不通、
  // 握手是不是加密的、加密 DNS 有没有工作
  check: () => ipcRenderer.invoke('net:check'),

  // 小工具
  // copy 用 Electron 的剪贴板，比 navigator.clipboard 可靠
  //   （后者在非 https 上下文里会被禁掉，Electron 里也时不时抽风）
  // openFile 用系统默认程序打开，openExternal 用默认浏览器打开网址
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  openFile: (p) => ipcRenderer.invoke('app:openFile', p),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
});
