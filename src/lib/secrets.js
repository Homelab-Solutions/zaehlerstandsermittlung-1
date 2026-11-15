const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const SECRETS_FILE = path.join(config.DATA_DIR, 'secrets.json');

function readSecretsFile() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSecretsFile(data) {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// SESSION_SECRET / ENCRYPTION_KEY sind interne, vom Betrieb nicht einzutragende
// Geheimnisse (anders als DB_PASSWORD/ADMIN_INITIAL_PASSWORD): wenn nicht per
// .env gesetzt, werden sie einmalig erzeugt und persistent unter data/secrets.json
// abgelegt (Modus 600), damit Sessions/Verschluesselung einen Neustart ueberleben.
function ensureSecrets() {
  const fromEnv = {
    sessionSecret: config.sessionSecretEnv,
    encryptionKey: config.encryptionKeyEnv,
  };
  if (fromEnv.sessionSecret && fromEnv.encryptionKey) {
    return fromEnv;
  }
  const stored = readSecretsFile();
  const result = {
    sessionSecret: fromEnv.sessionSecret || stored.sessionSecret || crypto.randomBytes(48).toString('hex'),
    encryptionKey: fromEnv.encryptionKey || stored.encryptionKey || crypto.randomBytes(32).toString('hex'),
  };
  if (result.sessionSecret !== stored.sessionSecret || result.encryptionKey !== stored.encryptionKey) {
    writeSecretsFile(result);
  }
  return result;
}

function generateReadablePassword() {
  // Zufaelliges, aber tippbares Erstpasswort fuer das Admin-Bootstrap (keine
  // verwechselbaren Zeichen wie 0/O, 1/l).
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

module.exports = { ensureSecrets, generateReadablePassword, SECRETS_FILE };
