const { SYSTEM_PROMPT, extractJson, normalizeResult } = require('./util');

// Fuer OpenAI selbst und jeden OpenAI-kompatiblen Endpunkt (Chat-Completions-API
// mit Vision-Nachrichten, z. B. per base64-Data-URL).
async function analysiere({ baseUrl, apiKey, model, timeoutSeconds, imageBase64, mime }) {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), (timeoutSeconds || 30) * 1000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 400,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Hier ist das Zaehlerfoto. Antworte im geforderten JSON-Format.' },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, fehler: `KI-Anbieter antwortete mit Status ${res.status}`, details: body.slice(0, 300) };
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const parsed = extractJson(typeof content === 'string' ? content : JSON.stringify(content));
    return { ok: true, ergebnis: normalizeResult(parsed) };
  } catch (err) {
    const abgebrochen = err.name === 'AbortError';
    return { ok: false, fehler: abgebrochen ? 'Zeitlimit ueberschritten' : ('Verbindung fehlgeschlagen: ' + err.message) };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { analysiere };
