'use strict';

// 本地 CA：生成、安装到「当前用户」的信任区、卸载。
// 装在当前用户下不需要管理员权限，这点已经实测过。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const forge = require('node-forge');

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

// 生成一套新的 CA 并落盘
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
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  fs.writeFileSync(caDerPath(), der);

  return { cert, key: keys.privateKey, certPem, keyPem };
}

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

// 从信任区删掉
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

const leafCache = new Map();

function leafFor(host, ca) {
  const hit = leafCache.get(host);
  if (hit) return hit;

  const kp = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = kp.publicKey;
  cert.serialNumber = '02' + Date.now().toString(16) + Math.floor(Math.random() * 100000);
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400 * 1000 * 397);
  cert.setSubject([{ name: 'commonName', value: host }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
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
