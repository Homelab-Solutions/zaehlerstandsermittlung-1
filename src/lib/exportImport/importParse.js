const { parse } = require('csv-parse/sync');
const ExcelJS = require('exceljs');

const FELD_ALIAS = {
  zaehlernummer: ['zaehlernummer', 'zählernummer', 'number'],
  zaehlerart: ['zaehlerart', 'zählerart', 'meter_type', 'typ'],
  datum: ['datum', 'date'],
  // "uhrzeit" wird nur noch akzeptiert, wenn sie (z. B. aus einem frueheren
  // Export mit reading_at) mitgeliefert wird - die Importvorlage fragt keine
  // Uhrzeit mehr ab (Auftrag "Dashboard, Importvorlage und KI-Status").
  uhrzeit: ['uhrzeit', 'zeit', 'time'],
  wert: ['wert', 'value', 'stand', 'zaehlerstand'],
  einheit: ['einheit', 'unit'],
  // Unterscheidet die Teilwerte von Stromzaehlern (verbrauch/einspeisung) und
  // Waermemengenzaehlern (kwh/m3) - bei anderen Zaehlerarten leer/ignoriert.
  // "strom_richtung"/"waerme_teil" (Spaltennamen des JSON-Exports) werden
  // bewusst NICHT hier aufgefuehrt, sondern unten gesondert behandelt, da ein
  // JSON-Reimport beide Spalten gleichzeitig mitliefert (nur eine davon
  // gefuellt) - ueber FELD_ALIAS wuerde die leere Spalte die gefuellte
  // ueberschreiben.
  messart: ['messart', 'richtung', 'teil'],
  status: ['status'],
  bemerkung: ['bemerkung', 'notiz', 'comment', 'kommentar'],
};

function normalisiereSchluessel(key) {
  const k = String(key).trim().toLowerCase();
  for (const [norm, varianten] of Object.entries(FELD_ALIAS)) {
    if (varianten.includes(k)) return norm;
  }
  return k;
}

function normalisiereZeile(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[normalisiereSchluessel(k)] = typeof v === 'string' ? v.trim() : v;
  }
  // readings-Exportformat (reading_at statt datum/uhrzeit) unterstuetzen
  if (out.reading_at && !out.datum) {
    const dt = new Date(out.reading_at);
    if (!Number.isNaN(dt.getTime())) {
      out.datum = dt.toISOString().slice(0, 10);
      out.uhrzeit = dt.toISOString().slice(11, 16);
    }
  }
  if (out.value !== undefined && out.wert === undefined) out.wert = out.value;
  if (out.unit !== undefined && out.einheit === undefined) out.einheit = out.unit;
  // JSON-Reimport (z. B. eigener Export): strom_richtung/waerme_teil direkt
  // aus dem Rohobjekt uebernehmen, nur wenn "messart" noch nicht gesetzt ist -
  // siehe Begruendung bei FELD_ALIAS oben.
  if (!out.messart) out.messart = obj.strom_richtung || obj.waerme_teil || null;
  if (out.messart) out.messart = String(out.messart).trim().toLowerCase();
  return out;
}

function parseCsv(buffer) {
  const text = buffer.toString('utf8');
  const delimiter = text.split('\n')[0].includes(';') ? ';' : ',';
  const records = parse(text, { columns: true, delimiter, skip_empty_lines: true, trim: true });
  return records.map(normalisiereZeile);
}

function parseJson(buffer) {
  const data = JSON.parse(buffer.toString('utf8'));
  if (Array.isArray(data)) {
    return { zeilen: data.map(normalisiereZeile), stammdaten: null };
  }
  const rohReadings = data.readings || data.messwerte || [];
  // Vollstaendiger Export (lib/exportImport/daten.js gatherAll()): readings
  // tragen nur die rohe Spalte meter_id (Export-ID), keine Zaehlernummer -
  // ueber die mitexportierten meters wird sie hier aufgeloest, damit die
  // bestehende, auf "zaehlernummer" basierende Zuordnung (s. u.) unveraendert
  // greift. Siehe importStammdaten.js fuer das Nachtragen fehlender Zaehler.
  const istVollimport = Array.isArray(data.meters) || Array.isArray(data.meter_types);
  let zeilen;
  if (istVollimport && Array.isArray(data.meters)) {
    const nummerByAltMeterId = new Map(data.meters.map((m) => [m.id, m.number]));
    zeilen = rohReadings.map((r) => normalisiereZeile({ ...r, zaehlernummer: r.zaehlernummer || nummerByAltMeterId.get(r.meter_id) }));
  } else {
    zeilen = rohReadings.map(normalisiereZeile);
  }
  return { zeilen, stammdaten: istVollimport ? data : null };
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets.find((s) => /messwert/i.test(s.name)) || workbook.worksheets[0];
  if (!sheet) return [];
  const header = [];
  sheet.getRow(1).eachCell((cell, col) => {
    header[col] = normalisiereSchluessel(cell.value);
  });
  const out = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};
    row.eachCell((cell, col) => {
      if (!header[col]) return;
      let val = cell.value;
      if (val instanceof Date) val = val.toISOString();
      obj[header[col]] = val;
    });
    if (Object.keys(obj).length > 0) out.push(normalisiereZeile(obj));
  });
  return out;
}

// Liefert immer { zeilen, stammdaten } - stammdaten ist nur bei einem
// vollstaendigen JSON-Export (Zaehler-Stammdaten enthalten) gesetzt, sonst null
// (CSV/Excel enthalten laut bestehendem Export ohnehin nur Messwerte).
async function parseDatei(buffer, originalName) {
  const ext = (originalName.split('.').pop() || '').toLowerCase();
  if (ext === 'csv') return { zeilen: parseCsv(buffer), stammdaten: null };
  if (ext === 'json') return parseJson(buffer);
  if (ext === 'xlsx') return { zeilen: await parseXlsx(buffer), stammdaten: null };
  throw new Error('Nicht unterstütztes Dateiformat: ' + ext);
}

module.exports = { parseDatei, normalisiereZeile };
