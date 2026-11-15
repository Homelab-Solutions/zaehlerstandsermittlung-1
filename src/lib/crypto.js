const crypto = require('crypto');

// AES-256-GCM fuer in der DB gespeicherte Geheimnisse (SMTP-Passwort, KI-API-Key).
// Analog zum Vorgehen der AppFactory selbst (lib/krypto.js laut CLAUDE.md).
let keyBuffer = null;

function init(hexKey) {
  keyBuffer = Buffer.from(hexKey, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error('ENCRYPTION_KEY muss 32 Byte (64 Hex-Zeichen) lang sein');
  }
}

function encrypt(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(payload) {
  if (!payload) return '';
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return '';
  }
}

module.exports = { init, encrypt, decrypt };
