'use strict';

// 本地 CA：生成、安装到「当前用户」的信任区、卸载。
//
// 为什么要这个东西：
// 代理得在中间拆开 TLS 才能替换图片域名（把 static1.e621.net 换成
// static1.e926.net），也才能改网页内容。拆 TLS 就必须给浏览器出示一张
// 它信得过的证书，否则满屏安全警告。所以自己当一次 CA，签证书给浏览器看。
//
// 装在哪：「当前用户」的 Root 信任区，不是整台机器的。
// 装在当前用户下不需要管理员权限，这点已经实测过。
// 代价是只有这个用户信任它，换个用户登录就得重装 —— 这对个人工具正好。
//
// 生成的文件都在 %APPDATA%\E621Link\ca\ 下：
//   ca.pem  证书（PEM 格式，给它自己和 node-forge 用）
//   ca.key  私钥（PEM 格式，绝对不能外泄）
//   ca.cer  证书的 DER 格式（certutil 只认 DER）

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const forge = require('node-forge');

// 信任区里显示的名字。untrust 时按这个名字删，所以别随便改 ——
// 改了之后老用户机器上会留一张删不掉的旧证书。
const CA_NAME = 'E621Link Local CA';

function appDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'E621Link');
}

function caDir() {
  return path.join(appDir(), 'ca');
}

function caCertPath() {
  return path.join(caDir(), 'ca.pem');
}

function caKeyPath() {
  return path.join(caDir(), 'ca.key');
}

function caDerPath() {
  return path.join(caDir(), 'ca.cer');
}

// 从磁盘读现成的 CA。读不到或者格式坏了返回 null。
function readCa() {
  try {
    const certPem = fs.readFileSync(caCertPath(), 'utf8');
    const keyPem = fs.readFileSync(caKeyPath(), 'utf8');
    return {
      cert: forge.pki.certificateFromPem(certPem),
      key: forge.pki.privateKeyFromPem(keyPem),
      certPem,
      keyPem,
    };
  } catch {
    return null;
  }
}

// 生成一套新的 CA 并落盘。
//
// 各项参数都是按「够用就好」定的：
//   2048 位 RSA —— 兼容性最好，生成约 200ms。4096 位要 2 秒以上，不值得。
//   有效期 5 年 —— 够长了，用户基本不会遇到过期。
//   notBefore 往前挪一天 —— 防止用户机器时间稍微慢一点，
//     导致证书被当成「还没生效」。这是个很常见的坑。
//   serialNumber 带随机 —— 光用 Date.now() 在同一毫秒内可能撞号。
//
// 扩展项是照着标准 CA 该有的填的：
//   basicConstraints cA:true    声明自己是 CA，可以签别的证书
//   keyUsage keyCertSign:true   允许用来签证书
//   subjectKeyIdentifier        证书自己的 ID，方便链式校验
// 少填这些，某些严格校验的场景会不认。
function createCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + Date.now().toString(16) + Math.floor(Math.random() * 100000);
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400 * 1000 * 365 * 5);

  const attrs = [
    { name: 'commonName', value: CA_NAME },
    { name: 'organizationName', value: 'E621Link' },
    { name: 'countryName', value: 'CN' },
  ];
  cert.setSubject(attrs);
  // 自签证书，签发者就是自己
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  fs.mkdirSync(caDir(), { recursive: true });
  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  fs.writeFileSync(caCertPath(), certPem, 'utf8');
  fs.writeFileSync(caKeyPath(), keyPem, 'utf8');

  // certutil 只认 DER
  //
  // forge 的 getBytes() 返回的是「每个字符一个字节」的二进制字符串，
  // 得按 latin1 塞进 Buffer，不然中文字符会被当成 UTF-8 编成多字节，内容就坏了。
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  fs.writeFileSync(caDerPath(), der);

  return { cert, key: keys.privateKey, certPem, keyPem };
}

// 保证有一套可用的 CA：有就读出来，没有就现生成。
//
// 这里还处理一个兼容情况：老版本可能只存了 pem 没存 cer，
// 那就顺手从 pem 转一份 der 出来，省得后面 certutil 找不到文件。
function ensureCa() {
  const existing = readCa();
  if (existing) {
    if (!fs.existsSync(caDerPath())) {
      const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(existing.cert)).getBytes(), 'binary');
      fs.writeFileSync(caDerPath(), der);
    }
    return existing;
  }
  return createCa();
}

// 现在这个用户信任区里有没有它
// 判断「证书真的能用」：本地文件在、而且信任区里装的是这一张。
// 只看名字不够——以前删掉文件重装过的话，信任区里会留一张对不上的旧证书，
// 那样照样弹安全警告，界面却显示装好了。
//
// 具体做法是比对序列号：
//   1. 读出本地证书的序列号
//   2. 用 certutil 列出信任区里所有根证书（含名字和序列号的文本）
//   3. 把空白全去掉、转小写，看里面有没有这个序列号
//
// 为什么要 replace(/^0+/, '')：forge 给的序列号可能带前导零，
// 而 certutil 显示的时候不补零，不处理就永远对不上。
//
// encoding 用 latin1 而不是 utf8：certutil 输出的编码不受控，
// 用 latin1 至少能保证每个字节原样映射成字符，不会因为碰到非法
// UTF-8 序列而丢内容。这里只找十六进制数字，不需要正确理解中文。
function isTrusted() {
  if (!fs.existsSync(caCertPath())) return false;

  let mine = '';
  try {
    mine = forge.pki.certificateFromPem(fs.readFileSync(caCertPath(), 'utf8')).serialNumber;
  } catch {
    return false;
  }
  if (!mine) return false;

  try {
    const out = execFileSync('certutil', ['-user', '-store', 'Root'], {
      encoding: 'latin1',
      windowsHide: true,
      timeout: 30000,
    });
    if (!out.includes(CA_NAME)) return false;

    // certutil 的输出里，序列号是十六进制字符串
    const want = mine.toLowerCase().replace(/^0+/, '');
    const flat = out.replace(/\s+/g, '').toLowerCase();
    return flat.includes(want);
  } catch {
    return false;
  }
}

// 装进当前用户的 Root 信任区（不需要管理员）
//
// -user 是关键：不加这个参数会往整台机器的信任区装，那个要管理员权限，
// 普通用户跑会直接失败。
//
// 装完立刻用 isTrusted() 验一遍，不能只看 certutil 的退出码。
// 有些安全软件（360、火绒之类）会「假装」让命令执行成功，
// 然后把证书悄悄拦掉。这种情况必须报错给用户，否则他点击启动后
// 浏览器弹安全警告，完全不知道发生了什么。
function trust() {
  const ca = ensureCa();
  try {
    execFileSync('certutil', ['-addstore', '-user', 'Root', caDerPath()], {
      windowsHide: true,
      timeout: 30000,
      stdio: 'ignore',
    });
  } catch (e) {
    return { ok: false, error: '装证书失败：' + String(e.message || e).split('\n')[0] };
  }
  if (!isTrusted()) {
    return { ok: false, error: '证书装上了，但没过一会儿又查不到。可能被安全软件拦了。' };
  }
  return { ok: true };
}

// 从信任区删掉。
// 按名字删（-delstore 后面跟 CA_NAME），所以 CA_NAME 改了这里就删不到了。
// 删完同样验证一遍，确认真的没了才算成功。
function untrust() {
  try {
    execFileSync('certutil', ['-delstore', '-user', 'Root', CA_NAME], {
      windowsHide: true,
      timeout: 30000,
      stdio: 'ignore',
    });
  } catch {
    /* 本来就没有就算了 */
  }
  return { ok: !isTrusted() };
}

// ---- 临时域名证书 ----
// 每个域名现签一张，签完缓存起来，别每次都花 200ms 生成密钥。
//
// 这里签的是「叶子证书」——真正出示给浏览器的那张，由上面那个 CA 签发。
// 浏览器看到叶子证书，往上追到 CA，发现 CA 在信任区里，就认了。

const leafCache = new Map();

function leafFor(host, ca) {
  const hit = leafCache.get(host);
  if (hit) return hit;

  const kp = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = kp.publicKey;
  cert.serialNumber = '02' + Date.now().toString(16) + Math.floor(Math.random() * 100000);
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  // 397 天是证书有效期的一个常见上限（苹果和 Chrome 都推这个数），
  // 虽然自己签的没人管，但跟着标准来不会出意外
  cert.validity.notAfter = new Date(Date.now() + 86400 * 1000 * 397);
  cert.setSubject([{ name: 'commonName', value: host }]);
  // 签发者必须跟 CA 的主体完全一致，否则链校验断掉
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    // 叶子证书不能是 CA，这个必须显式声明 false 且标 critical
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    // serverAuth 表示这张证书可以用于服务端 TLS。
    // 少了这一项，Chrome 会拒绝（它对 extKeyUsage 检查比较严）。
    { name: 'extKeyUsage', serverAuth: true },
    // SAN 才是现代浏览器真正看的地方，CN 早就被忽略了。
    // type: 2 表示 DNS 名称（1 是邮箱，6 是 URI，7 是 IP）。
    { name: 'subjectAltName', altNames: [{ type: 2, value: host }] },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());

  const pair = {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(kp.privateKey),
  };
  leafCache.set(host, pair);
  return pair;
}

module.exports = {
  CA_NAME,
  caDir,
  caCertPath,
  caDerPath,
  ensureCa,
  readCa,
  isTrusted,
  trust,
  untrust,
  leafFor,
};
