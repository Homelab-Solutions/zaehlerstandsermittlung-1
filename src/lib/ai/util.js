const SYSTEM_PROMPT = `Du analysierst ein Foto eines Zaehlers (Wasser, Gas, Strom oder Waermemengenzaehler).
Antworte AUSSCHLIESSLICH mit kompaktem JSON ohne Erklaerung, Markdown oder Codeblock, exakt in dieser Form:
{"zaehlerstand": <Zahl oder null>, "zaehlernummer": <Text oder null>, "einheit": <Text oder null>, "confidence": <Zahl 0 bis 1>, "hinweis": <kurzer Text oder null>}
Wenn du dir bei einer Ziffer nicht sicher bist, trage trotzdem deine beste Schaetzung ein und senke "confidence". Wenn gar nichts lesbar ist, setze "zaehlerstand" auf null und erklaere kurz warum in "hinweis".`;

function extractJson(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Manche Modelle liefern Zahlen trotz Anweisung als Text mit deutschem Format
// (Tausenderpunkt, Komma als Dezimaltrennzeichen, z. B. "1.234,567") - ein reines
// Number(...) ergibt dafuer NaN und der erkannte Zaehlerstand ginge sonst
// stillschweigend verloren (Ursache der bisherigen Unzuverlaessigkeit).
function parseZahl(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (val === null || val === undefined) return null;
  const text = String(val).trim();
  if (!text) return null;
  const normalisiert = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  const n = Number(normalisiert);
  return Number.isFinite(n) ? n : null;
}

function normalizeResult(parsed) {
  if (!parsed) {
    return { zaehlerstand: null, zaehlernummer: null, einheit: null, confidence: null, hinweis: 'Antwort der KI konnte nicht ausgewertet werden.' };
  }
  return {
    zaehlerstand: parseZahl(parsed.zaehlerstand),
    zaehlernummer: parsed.zaehlernummer ? String(parsed.zaehlernummer) : null,
    einheit: parsed.einheit ? String(parsed.einheit) : null,
    confidence: parseZahl(parsed.confidence),
    hinweis: parsed.hinweis ? String(parsed.hinweis) : null,
  };
}

module.exports = { SYSTEM_PROMPT, extractJson, normalizeResult };
