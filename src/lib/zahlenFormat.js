// Gemeinsame Zahlen- und Datumsnormalisierung fuer Messwerte (manuelle
// Erfassung, Admin-Bearbeitung/Korrekturen, Import) - ein einziger Ort, damit
// Eingabe- und Anzeigeverhalten ueberall gleich sind (Auftrag "Zahlen- und
// Datumsformate").

// Zaehlerstaende werden mit Dezimalkomma eingegeben (deutsche Schreibweise).
// Ein einzelner Dezimalpunkt wird weiterhin wie bisher akzeptiert (unveraendertes
// Verhalten, u. a. fuer Re-Importe eigener Exporte und fuer Werte mit 3
// Nachkommastellen, wie sie bei Wasserzaehlern uebliche sind). Mehrere Punkte
// ohne Komma werden nur als deutsche Tausendertrennung (Dreiergruppen)
// akzeptiert; alles andere, insbesondere eine Mischung, die sich nicht
// eindeutig auflösen laesst, gilt als mehrdeutig und wird klar zurueckgewiesen.
function parseMesswert(rohwert) {
  if (rohwert === undefined || rohwert === null) return { ok: false, fehler: 'Zählerstand fehlt.' };
  if (typeof rohwert === 'number') {
    return Number.isFinite(rohwert) ? { ok: true, value: rohwert } : { ok: false, fehler: 'Zählerstand ist keine gültige Zahl.' };
  }
  const text = String(rohwert).trim();
  if (text === '') return { ok: false, fehler: 'Zählerstand fehlt.' };
  if (!/^-?[0-9.,]+$/.test(text)) {
    return { ok: false, fehler: `Zählerstand "${rohwert}" enthält ungültige Zeichen.` };
  }

  const anzahlKomma = (text.match(/,/g) || []).length;
  const anzahlPunkt = (text.match(/\./g) || []).length;
  let normalisiert;

  if (anzahlKomma > 1) {
    return { ok: false, fehler: `Zählerstand "${rohwert}" ist mehrdeutig (mehr als ein Komma).` };
  }
  if (anzahlKomma === 1) {
    const [ganzzahlTeil, dezimalTeil] = text.split(',');
    if (!ganzzahlTeil || !dezimalTeil) {
      return { ok: false, fehler: `Zählerstand "${rohwert}" ist keine gültige Zahl.` };
    }
    if (anzahlPunkt > 0 && !/^-?\d{1,3}(\.\d{3})*$/.test(ganzzahlTeil)) {
      return { ok: false, fehler: `Zählerstand "${rohwert}" ist mehrdeutig (Tausendertrennzeichen unklar).` };
    }
    normalisiert = ganzzahlTeil.replace(/\./g, '') + '.' + dezimalTeil;
  } else if (anzahlPunkt > 1) {
    if (!/^-?\d{1,3}(\.\d{3})+$/.test(text)) {
      return { ok: false, fehler: `Zählerstand "${rohwert}" ist mehrdeutig (Tausendertrennzeichen unklar).` };
    }
    normalisiert = text.replace(/\./g, '');
  } else {
    normalisiert = text;
  }

  const zahl = Number(normalisiert);
  if (Number.isNaN(zahl)) return { ok: false, fehler: `Zählerstand "${rohwert}" ist keine gültige Zahl.` };
  return { ok: true, value: zahl };
}

// Anzeige eines gespeicherten Messwerts (decimal(14,3)): nachgestellte
// Null-Dezimalstellen werden weggelassen, aber mindestens 2 tatsaechlich von
// Null verschiedene Nachkommastellen bleiben erhalten (z. B. 5678.000 -> "5678",
// 12.500 -> "12,50", 123.456 -> "123,456"). Es wird nie gerundet - volle
// gespeicherte Praezision bleibt erhalten, nur die Darstellung wird gekuerzt.
function formatMesswert(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const vorzeichen = n < 0 ? '-' : '';
  const fixed = Math.abs(n).toFixed(3);
  const [ganz, dez] = fixed.split('.');
  if (/^0+$/.test(dez)) return vorzeichen + ganz;
  let gekuerzt = dez;
  while (gekuerzt.length > 2 && gekuerzt.endsWith('0')) gekuerzt = gekuerzt.slice(0, -1);
  return `${vorzeichen}${ganz},${gekuerzt}`;
}

// Schaetzwerte werden auf ganze Zahlen gerundet und ohne Dezimalstellen angezeigt.
function formatSchaetzwert(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return String(Math.round(n));
}

function formatWert(value, status) {
  return status === 'geschaetzt' ? formatSchaetzwert(value) : formatMesswert(value);
}

// Prueft Tag/Monat/Jahr auch inhaltlich (nicht nur das Format) - anders als
// `new Date(...)`, das z. B. "31.02.2026" stillschweigend auf einen anderen Tag
// umdeutet statt den Fehler zu melden.
function istGueltigesDatum(jahr, monat, tag) {
  if (monat < 1 || monat > 12) return false;
  const tageImMonat = new Date(Date.UTC(jahr, monat, 0)).getUTCDate();
  return tag >= 1 && tag <= tageImMonat;
}

// Akzeptiert deutsche Datumsangaben (TT.MM.JJJJ, auch mit einstelligem Tag/
// Monat) sowie weiterhin das bisherige ISO-Format (YYYY-MM-DD, wie es das
// HTML5-Datumsfeld und bisherige Re-Importe liefern). Liefert bei Erfolg immer
// das interne ISO-Format (YYYY-MM-DD), sonst null (ungueltig/mehrdeutig).
function parseDatumFlexibel(text) {
  const s = String(text || '').trim();
  if (!s) return null;

  const deMatch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (deMatch) {
    const tag = Number(deMatch[1]);
    const monat = Number(deMatch[2]);
    const jahr = Number(deMatch[3]);
    if (!istGueltigesDatum(jahr, monat, tag)) return null;
    return `${String(jahr).padStart(4, '0')}-${String(monat).padStart(2, '0')}-${String(tag).padStart(2, '0')}`;
  }

  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const jahr = Number(isoMatch[1]);
    const monat = Number(isoMatch[2]);
    const tag = Number(isoMatch[3]);
    if (!istGueltigesDatum(jahr, monat, tag)) return null;
    return s;
  }

  return null;
}

module.exports = { parseMesswert, formatMesswert, formatSchaetzwert, formatWert, parseDatumFlexibel };
