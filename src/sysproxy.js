'use strict';

// Windows 系统代理设置：读 / 设 / 还原。
// 只动 HKCU 里的 Internet Settings，不需要管理员权限。
// 改之前会把原来的值备份一份，还原时按备份写回去。

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// 打包成安装包之后，代码都在 app.asar 这个压缩包里。
// PowerShell 打不开 asar 里的文件，所以脚本得先解到磁盘上再跑。
// 开发时 __dirname 就在真实目录里，这一步等于什么都不做。
let cachedScript = '';

function scriptPath() {
  if (cachedScript && fs.existsSync(cachedScript)) return cachedScript;

  const inAsar = path.join(__dirname, '..', 'scripts', 'sysproxy.ps1');

  // app.asar 在路径里出现，说明是打包过的
  if (!inAsar.includes('.asar')) {
    cachedScript = inAsar;
    return cachedScript;
  }

  const target = path.join(scriptDir(), 'sysproxy.ps1');
  try {
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

function scriptDir() {
  const base = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  return path.join(base, 'E621Link', 'scripts');
}

function run(action, payload = {}) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath(), '-Action', action, '-PayloadBase64', b64],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 30000, encoding: 'utf8' },
      (err, stdout) => {
        const text = (stdout || '').trim();
        if (text) {
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

function notify() {
  return run('notify');
}

// 同步版，只在退出/崩溃这种最后一刻用。
// 异步的 execFile 在进程已经要死的时候根本跑不完。
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
