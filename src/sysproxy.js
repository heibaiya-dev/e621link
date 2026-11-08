'use strict';

// Windows 系统代理设置：读 / 设 / 还原。
//
// 这是个薄壳，真正干活的是 scripts/sysproxy.ps1。
// 这里只负责：把脚本喂给 PowerShell、把参数编码好、把输出解析成对象。
//
// 为什么绕一层 PowerShell：改系统代理要碰 wininet.dll 的 InternetSetOption，
// Node 里没有直接调用方式。而且只动 HKCU 里的 Internet Settings，
// 不需要管理员权限，普通用户就能改。
//
// 改之前脚本会把原来的值备份一份（%APPDATA%\E621Link\proxy-backup.json），
// 还原时按备份写回去。

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// 打包成安装包之后，代码都在 app.asar 这个压缩包里。
// PowerShell 打不开 asar 里的文件（它不认这个格式），所以脚本得先解到
// 磁盘上再跑。开发时 __dirname 就在真实目录里，这一步等于什么都不做。
//
// 这个变量缓存解出来的路径。PS 脚本调用很频繁（每次读写设置都调），
// 每次重新判断路径没必要。
let cachedScript = '';

function scriptPath() {
  // 缓存过就直接用，但要确认文件还在 —— 用户可能手动删了 %APPDATA% 下的东西
  if (cachedScript && fs.existsSync(cachedScript)) return cachedScript;

  const inAsar = path.join(__dirname, '..', 'scripts', 'sysproxy.ps1');

  // app.asar 在路径里出现，说明是打包过的
  if (!inAsar.includes('.asar')) {
    cachedScript = inAsar;
    return cachedScript;
  }

  // 打包环境：解一份到 %APPDATA%\E621Link\scripts\ 下
  const target = path.join(scriptDir(), 'sysproxy.ps1');
  try {
    // 比大小判断要不要重新解。
    // 用大小而不是时间戳，是因为 asar 里读出来的时间戳不可靠。
    // 大小不同说明程序更新了、脚本换了，重新拷一份。
    if (!fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(inAsar).size) {
      fs.mkdirSync(scriptDir(), { recursive: true });
      fs.copyFileSync(inAsar, target);
    }
    cachedScript = target;
  } catch {
    // 解不出来只能退回原路径，至少报错清楚
    cachedScript = inAsar;
  }
  return cachedScript;
}

// 脚本解压到哪儿。
// 用 %APPDATA%\E621Link\scripts\ 而不是临时目录，因为临时目录会被系统清掉，
// 清掉之后下次调用就得重新解，还可能出现「文件正在使用」的冲突。
function scriptDir() {
  const base = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  return path.join(base, 'E621Link', 'scripts');
}

// 跑一次脚本。返回 Promise，一定 resolve，不会 reject ——
// 调用方只需要看 ok 字段，不用写 try/catch。
//
// 参数用 base64 传，原因见 sysproxy.ps1 里的注释：
// 直接传 JSON 字符串，引号和中文在命令行里会被 PowerShell 拆坏。
function run(action, payload = {}) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    execFile(
      'powershell.exe',
      // -NoProfile 很重要：不加的话会加载用户的 PowerShell 配置文件，
      //   可能被里面自定义的别名、函数、提示符脚本干扰，输出里混进别的东西。
      // -NonInteractive 防止脚本卡在交互式提示上等输入。
      // -ExecutionPolicy Bypass 绕过执行策略，否则默认策略可能禁止跑 .ps1。
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath(), '-Action', action, '-PayloadBase64', b64],
      {
        windowsHide: true,        // 不弹黑框
        maxBuffer: 4 * 1024 * 1024, // 输出上限 4MB。默认才 1MB，备份内容大时会被截断
        timeout: 30000,           // 30 秒还没跑完就杀掉。正常情况几十毫秒就完事
        encoding: 'utf8',
      },
      (err, stdout) => {
        const text = (stdout || '').trim();
        if (text) {
          // 只截取第一个 { 到最后一个 } 之间的内容。
          //
          // 为什么要这一步：PowerShell 启动时可能往 stdout 里塞点别的东西
          // （警告、加载信息、编码提示），直接 JSON.parse 会失败。
          // 脚本本身约定只输出一段 JSON，所以掐头去尾就能拿到。
          const a = text.indexOf('{');
          const b = text.lastIndexOf('}');
          if (a >= 0 && b > a) {
            try {
              resolve(JSON.parse(text.slice(a, b + 1)));
              return;
            } catch {
              /* 落到下面 */
            }
          }
        }
        // 走到这里说明输出不是能解析的 JSON。
        // 把 stderr 的第一行带上，方便排查是权限问题还是脚本本身出错。
        resolve({
          ok: false,
          error: '系统代理脚本没返回能看懂的内容' + (err ? '：' + String(err.message).split('\n')[0] : ''),
        });
      }
    );
  });
}

function get() {
  return run('get');
}

function set(port) {
  return run('set', { port });
}

function restore() {
  return run('restore');
}

// 只通知系统「代理设置变了」，不改任何值。
// 用在设置没变、但浏览器还在用旧值的情况。
function notify() {
  return run('notify');
}

// 同步版，只在退出/崩溃这种最后一刻用。
//
// 为什么必须有这个：异步的 execFile 在进程已经要死的时候根本跑不完 ——
// 主进程开始退出，事件循环停了，回调永远不会执行，代理就没还原。
// 结果是程序关了，系统代理还指着一个已经没了的端口，整台机器上不了网。
// 这是最要命的 bug，所以退出路径必须走同步版。
//
// 另外用 stdio: 'ignore' 而不是收集输出：这时候不需要知道结果，
// 拿到结果也没地方用，反而多一层解析开销。
function restoreSync() {
  const { execFileSync } = require('child_process');
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath(), '-Action', 'restore',
      ],
      { windowsHide: true, timeout: 6000, stdio: 'ignore' }
    );
    return true;
  } catch {
    return false;
  }
}

module.exports = { get, set, restore, notify, restoreSync, scriptPath };
