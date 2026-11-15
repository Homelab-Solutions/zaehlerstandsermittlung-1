const settings = require('../settings');
const openaiCompatible = require('./openaiCompatible');
const ollama = require('./ollama');
const anthropic = require('./anthropic');

// Fotoerkennung ist immer optional: Rueckgabe signalisiert klar, ob die KI
// genutzt werden konnte; die manuelle Erfassung bleibt davon unberuehrt.
async function fotoAnalysieren({ imageBase64, mime }) {
  const cfg = await settings.getAiConfig();
  if (!cfg.enabled) {
    return { ok: false, fehler: 'KI-Fotoerkennung ist nicht aktiviert.' };
  }
  if (!cfg.model) {
    return { ok: false, fehler: 'KI-Anbieter ist nicht vollstaendig konfiguriert (Modell fehlt).' };
  }
  if (cfg.provider === 'anthropic') {
    if (!cfg.apiKey) return { ok: false, fehler: 'KI-Anbieter ist nicht vollstaendig konfiguriert (API-Key fuer Anthropic fehlt).' };
  } else if (!cfg.baseUrl) {
    return { ok: false, fehler: 'KI-Anbieter ist nicht vollstaendig konfiguriert (Endpunkt fehlt).' };
  }
  try {
    if (cfg.provider === 'ollama') {
      return await ollama.analysiere({ baseUrl: cfg.baseUrl, model: cfg.model, timeoutSeconds: cfg.timeoutSeconds, imageBase64 });
    }
    if (cfg.provider === 'anthropic') {
      return await anthropic.analysiere({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, timeoutSeconds: cfg.timeoutSeconds, imageBase64, mime });
    }
    return await openaiCompatible.analysiere({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, timeoutSeconds: cfg.timeoutSeconds, imageBase64, mime });
  } catch (err) {
    console.error('KI-Fotoerkennung fehlgeschlagen:', err.message);
    return { ok: false, fehler: 'KI-Fotoerkennung fehlgeschlagen.' };
  }
}

module.exports = { fotoAnalysieren };
