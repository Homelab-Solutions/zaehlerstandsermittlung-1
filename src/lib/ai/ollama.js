const { SYSTEM_PROMPT, extractJson, normalizeResult } = require('./util');

// Ollama (lokal oder im Netz), Vision-Modell per /api/chat mit images[] (base64 ohne Data-URL-Praefix).
async function analysiere({ baseUrl, model, timeoutSeconds, imageBase64 }) {
  const url = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '') + '/api/chat';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), (timeoutSeconds || 30) * 1000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: 'Hier ist das Zaehlerfoto. Antworte im geforderten JSON-Format.', images: [imageBase64] },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, fehler: `Ollama antwortete mit Status ${res.status}`, details: body.slice(0, 300) };
    }
    const data = await res.json();
    const content = data?.message?.content;
    const parsed = extractJson(content);
    return { ok: true, ergebnis: normalizeResult(parsed) };
  } catch (err) {
    const abgebrochen = err.name === 'AbortError';
    return { ok: false, fehler: abgebrochen ? 'Zeitlimit ueberschritten' : ('Verbindung fehlgeschlagen: ' + err.message) };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { analysiere };
