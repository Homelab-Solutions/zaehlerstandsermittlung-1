const crypto = require('crypto');
const settings = require('../settings');

// Guenstige, nicht-generative Erreichbarkeits-/Modellpruefung fuer den
// konfigurierten KI-Anbieter (Auftrag Abschnitt 5): listet nur vorhandene
// Modelle auf (kein Bildupload, keine Bildanalyse, kein generativer Aufruf)
// und wird fuer eine kurze Zeit zwischengespeichert, damit nicht bei jedem
// Seitenaufruf erneut ein Netzwerkaufruf (ggf. mit Kosten) ausgeloest wird.
const CACHE_MS = 5 * 60 * 1000;
const PRUEF_TIMEOUT_MS = 10 * 1000;
let cache = null; // { konfigHash, zeit, ergebnis }

function konfigHash(cfg) {
  return crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
}

function modellGefunden(modell, liste) {
  const basis = (s) => String(s).split(':')[0].trim().toLowerCase();
  const gesucht = String(modell).trim().toLowerCase();
  return liste.some((name) => String(name).trim().toLowerCase() === gesucht || basis(name) === basis(gesucht));
}

async function holeMitTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRUEF_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function pruefeOpenaiCompatible(cfg) {
  const url = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/models';
  const res = await holeMitTimeout(url, {
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
  });
  if (!res.ok) return { verfuegbar: false, meldung: `Anbieter antwortete mit Status ${res.status}.` };
  const data = await res.json().catch(() => null);
  const modelle = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
  if (modelle.length > 0 && !modellGefunden(cfg.model, modelle)) {
    return { verfuegbar: false, meldung: `Modell "${cfg.model}" wurde beim Anbieter nicht gefunden.` };
  }
  return { verfuegbar: true, meldung: null };
}

async function pruefeAnthropic(cfg) {
  const url = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/models';
  const res = await holeMitTimeout(url, {
    headers: { 'x-api-key': cfg.apiKey || '', 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) return { verfuegbar: false, meldung: `Anthropic-API antwortete mit Status ${res.status}.` };
  const data = await res.json().catch(() => null);
  const modelle = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
  if (modelle.length > 0 && !modellGefunden(cfg.model, modelle)) {
    return { verfuegbar: false, meldung: `Modell "${cfg.model}" wurde bei Anthropic nicht gefunden.` };
  }
  return { verfuegbar: true, meldung: null };
}

async function pruefeOllama(cfg) {
  const url = (cfg.baseUrl || 'http://localhost:11434').replace(/\/+$/, '') + '/api/tags';
  const res = await holeMitTimeout(url, {});
  if (!res.ok) return { verfuegbar: false, meldung: `Ollama antwortete mit Status ${res.status}.` };
  const data = await res.json().catch(() => null);
  const modelle = Array.isArray(data?.models) ? data.models.map((m) => m.name) : [];
  if (modelle.length > 0 && !modellGefunden(cfg.model, modelle)) {
    return { verfuegbar: false, meldung: `Modell "${cfg.model}" ist auf dem Ollama-Server nicht installiert.` };
  }
  return { verfuegbar: true, meldung: null };
}

async function pruefeRoh(cfg) {
  if (!cfg.enabled) return { verfuegbar: false, meldung: 'KI-Fotoerkennung ist nicht aktiviert.' };
  if (!cfg.model) return { verfuegbar: false, meldung: 'Kein Modell konfiguriert.' };
  if (cfg.provider === 'anthropic') {
    if (!cfg.apiKey) return { verfuegbar: false, meldung: 'API-Key fuer Anthropic fehlt.' };
  } else if (!cfg.baseUrl) {
    return { verfuegbar: false, meldung: 'Endpunkt (Base-URL) fehlt.' };
  }

  try {
    if (cfg.provider === 'anthropic') return await pruefeAnthropic(cfg);
    if (cfg.provider === 'ollama') return await pruefeOllama(cfg);
    return await pruefeOpenaiCompatible(cfg);
  } catch (err) {
    const abgebrochen = err.name === 'AbortError';
    return { verfuegbar: false, meldung: abgebrochen ? 'Zeitlimit bei der Erreichbarkeitspruefung ueberschritten.' : 'Anbieter nicht erreichbar.' };
  }
}

// Liefert den gecachten Status, sofern sich die Konfiguration seit der letzten
// Pruefung nicht geaendert hat; sonst wird einmal neu (und danach wieder
// zwischengespeichert) geprueft. Gibt NIE den API-Key oder die Base-URL zurueck.
async function status() {
  const cfg = await settings.getAiConfig();
  const hash = konfigHash(cfg);
  if (cache && cache.konfigHash === hash && Date.now() - cache.zeit < CACHE_MS) {
    return { ...cache.ergebnis, geprueftAm: cache.zeit, cache: true };
  }
  const ergebnis = await pruefeRoh(cfg);
  cache = { konfigHash: hash, zeit: Date.now(), ergebnis };
  return { ...ergebnis, geprueftAm: cache.zeit, cache: false };
}

function invalidiere() {
  cache = null;
}

module.exports = { status, invalidiere };
