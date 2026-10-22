// 맥용 암호 보관: 키체인 대신 설정 폴더의 열쇠 파일로 암호화해서 저장
// (서명 없는 앱은 새 버전으로 바꿀 때마다 키체인이 접근을 막아서 연동이 끊기기 때문)
// 열쇠 파일은 이 맥 사용자 계정만 읽을 수 있게(권한 600) 만듭니다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'local1:';

function loadKey(dir) {
  const file = path.join(dir, 'secret.key');
  try {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length === 32) {
      try { fs.chmodSync(file, 0o600); } catch {}
      return key;
    }
  } catch {}
  const key = crypto.randomBytes(32);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return key;
}

function isLocal(enc) {
  return typeof enc === 'string' && enc.startsWith(PREFIX);
}

function encrypt(dir, text) {
  const key = loadKey(dir);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

function decrypt(dir, enc) {
  const raw = Buffer.from(enc.slice(PREFIX.length), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', loadKey(dir), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, isLocal };
