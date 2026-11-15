const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const DIR = path.join(config.DATA_DIR, 'import-tmp');
const TTL_MS = 2 * 60 * 60 * 1000;

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function speichere(buffer, originalName) {
  ensureDir();
  const token = crypto.randomBytes(16).toString('hex');
  const datei = path.join(DIR, `${token}__${originalName.replace(/[^A-Za-z0-9_.-]/g, '_')}`);
  fs.writeFileSync(datei, buffer);
  return token;
}

function finde(token) {
  ensureDir();
  const treffer = fs.readdirSync(DIR).find((f) => f.startsWith(token + '__'));
  if (!treffer) return null;
  const vollpfad = path.join(DIR, treffer);
  return { pfad: vollpfad, originalName: treffer.slice(token.length + 2), buffer: fs.readFileSync(vollpfad) };
}

function loesche(token) {
  const eintrag = finde(token);
  if (eintrag) fs.unlinkSync(eintrag.pfad);
}

function aufraeumen() {
  ensureDir();
  const jetzt = Date.now();
  for (const f of fs.readdirSync(DIR)) {
    const p = path.join(DIR, f);
    try {
      if (jetzt - fs.statSync(p).mtimeMs > TTL_MS) fs.unlinkSync(p);
    } catch {
      // Datei evtl. schon entfernt - ignorieren
    }
  }
}

module.exports = { speichere, finde, loesche, aufraeumen };
