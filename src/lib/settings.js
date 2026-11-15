const knex = require('../db/knex');
const cryptoLib = require('./crypto');

const SECRET_KEYS = new Set(['ai_api_key_enc', 'smtp_password_enc', 'api_lese_key_hash']);

async function getAll() {
  const rows = await knex('settings').select('key', 'value');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function get(key) {
  const row = await knex('settings').where({ key }).first();
  return row ? row.value : null;
}

async function set(key, value) {
  const exists = await knex('settings').where({ key }).first();
  if (exists) {
    await knex('settings').where({ key }).update({ value, updated_at: knex.fn.now() });
  } else {
    await knex('settings').insert({ key, value, updated_at: knex.fn.now() });
  }
}

async function setMany(obj) {
  for (const [key, value] of Object.entries(obj)) {
    await set(key, value);
  }
}

// Liefert KI-Konfiguration mit entschluesseltem API-Key (nur serverseitig verwenden,
// nie an den Browser zurueckgeben).
async function getAiConfig() {
  const all = await getAll();
  return {
    enabled: all.ai_enabled === 'true',
    provider: all.ai_provider || 'openai_compatible',
    baseUrl: all.ai_base_url || '',
    model: all.ai_model || '',
    apiKey: cryptoLib.decrypt(all.ai_api_key_enc || ''),
    timeoutSeconds: Number(all.ai_timeout_seconds || 30),
  };
}

async function getSmtpConfig() {
  const all = await getAll();
  return {
    enabled: all.smtp_enabled === 'true',
    host: all.smtp_host || '',
    port: Number(all.smtp_port || 587),
    secureMode: all.smtp_secure_mode || 'starttls',
    user: all.smtp_user || '',
    password: cryptoLib.decrypt(all.smtp_password_enc || ''),
    from: all.smtp_from || '',
    notifyDaysBefore: Number(all.notify_eichfrist_days_before || 30),
    notifyRecipients: (all.notify_recipients || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Eigene, von der Eichfrist-Benachrichtigung unabhaengige Empfaengerliste
    // fuer neue Messwerte (Auftrag Abschnitt 5) - bewusst ein eigenes Setting,
    // damit beide Benachrichtigungsarten getrennt konfiguriert werden koennen.
    notifyMesswertEnabled: all.notify_messwert_enabled === 'true',
    notifyMesswertRecipients: (all.notify_messwert_recipients || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

// Gibt die Einstellungen fuer die Admin-Oberflaeche zurueck: Geheimnisse werden
// NIE im Klartext ausgegeben, nur ob ein Wert gesetzt ist.
async function getPublicAdminView() {
  const all = await getAll();
  const view = { ...all };
  for (const k of SECRET_KEYS) {
    view[k + '_gesetzt'] = Boolean(all[k]);
    delete view[k];
  }
  return view;
}

module.exports = { getAll, get, set, setMany, getAiConfig, getSmtpConfig, getPublicAdminView, SECRET_KEYS };
