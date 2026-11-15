const { SYSTEM_PROMPT, extractJson, normalizeResult } = require('./util');

// Direkte Anthropic-API (Messages-Endpunkt) fuer die Foto-Erkennung. Modellname
// wird vom Admin eingetragen (keine fest hinterlegten Modell-IDs).
async function analysiere({ baseUrl, apiKey, model, timeoutSeconds, imageBase64, mime }) {
  const url = (baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), (timeoutSeconds || 30) * 1000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mime, data: imageBase64 } },
              { type: 'text', text: 'Hier ist das Zaehlerfoto. Antworte im geforderten JSON-Format.' },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, fehler: `Anthropic-API antwortete mit Status ${res.status}`, details: body.slice(0, 300) };
    }
    const data = await res.json();
    const block = Array.isArray(data?.content) ? data.content.find((b) => b.type === 'text') : null;
    const parsed = extractJson(block ? block.text : null);
    return { ok: true, ergebnis: normalizeResult(parsed) };
  } catch (err) {
    const abgebrochen = err.name === 'AbortError';
    return { ok: false, fehler: abgebrochen ? 'Zeitlimit ueberschritten' : ('Verbindung fehlgeschlagen: ' + err.message) };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { analysiere };
