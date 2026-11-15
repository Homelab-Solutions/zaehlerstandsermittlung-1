const knex = require('../../db/knex');
const { istStromTyp, istWaermeKombiTyp } = require('../meterTypen');
const { parseMesswert, parseDatumFlexibel } = require('../zahlenFormat');

// `stammdaten` (optional): roher Inhalt eines vollstaendigen JSON-Exports
// (lib/exportImport/daten.js gatherAll()), wenn die hochgeladene Datei ein
// solcher ist (siehe importStammdaten.js). Zaehler/Zaehlerarten daraus, die in
// der Datenbank noch fehlen, werden hier nur SIMULIERT (id:null) - damit
// Stromrichtung/Waerme-Teilwert schon in der Vorschau korrekt geprueft werden
// koennen, obwohl der Zaehler erst beim Commit tatsaechlich angelegt wird.
async function validiereZeilen(rohZeilen, stammdaten = null) {
  const meters = await knex('meters').select('id', 'number', 'meter_type_id', 'unit');
  const meterTypes = await knex('meter_types').select('id', 'key', 'unit', 'waerme_kombi');
  const meterByNumber = new Map(meters.map((m) => [String(m.number).trim(), m]));
  const meterTypeById = new Map(meterTypes.map((t) => [t.id, t]));

  const virtuelleMeterTypeByAltId = new Map();
  if (stammdaten && Array.isArray(stammdaten.meter_types)) {
    for (const t of stammdaten.meter_types) {
      virtuelleMeterTypeByAltId.set(t.id, { id: null, key: t.key, unit: t.unit, waerme_kombi: Boolean(t.waerme_kombi) });
    }
  }
  if (stammdaten && Array.isArray(stammdaten.meters)) {
    for (const m of stammdaten.meters) {
      const nummer = m.number ? String(m.number).trim() : '';
      if (!nummer || meterByNumber.has(nummer)) continue; // ein bereits vorhandener echter Zaehler gewinnt immer
      meterByNumber.set(nummer, {
        id: null,
        number: nummer,
        meter_type_id: null,
        unit: m.unit,
        _virtuellerTyp: virtuelleMeterTypeByAltId.get(m.meter_type_id) || null,
      });
    }
  }

  // Erkennt Dubletten NICHT nur gegen bereits gespeicherte Messwerte (DB-Check
  // weiter unten), sondern auch zwischen Zeilen derselben hochgeladenen Datei -
  // ohne das wuerden zwei identische Zeilen in einer Datei beide unbemerkt
  // importiert (gefunden per Testimport, siehe Session-Zwischenstand).
  const gesehenInDieserDatei = new Set();

  const ergebnis = [];
  for (let i = 0; i < rohZeilen.length; i++) {
    const zeile = rohZeilen[i];
    const fehler = [];
    const warnungen = [];

    const nummer = String(zeile.zaehlernummer || '').trim();
    const meter = nummer ? meterByNumber.get(nummer) : null;
    const meterType = meter ? (meter.id === null ? meter._virtuellerTyp : meterTypeById.get(meter.meter_type_id)) : null;
    if (!nummer) fehler.push('Zählernummer fehlt.');
    else if (!meter) fehler.push(`Zähler mit Nummer "${nummer}" nicht gefunden - bitte zuerst in der Zählerverwaltung anlegen.`);
    else if (meter.id === null) warnungen.push('Dieser Zähler ist in der Datenbank noch nicht vorhanden und wird aus dem Stammdaten-Teil dieses Exports neu angelegt.');

    let readingAt = null;
    if (zeile.datum) {
      // Keine Uhrzeit-Spalte in der Importvorlage mehr (Auftrag "Dashboard,
      // Importvorlage und KI-Status"); ohne mitgelieferte Uhrzeit (z. B. bei
      // einem Reimport mit reading_at) wird mittags angesetzt, um
      // Zeitzonenverschiebungen ueber die Datumsgrenze zu vermeiden. Akzeptiert
      // sowohl deutsches (TT.MM.JJJJ) als auch das bisherige ISO-Datumsformat
      // (Auftrag "Zahlen- und Datumsformate") - inhaltlich ungueltige/mehrdeutige
      // Daten (z. B. 31.02.) werden klar zurueckgewiesen statt stillschweigend
      // umgedeutet.
      const datumIso = parseDatumFlexibel(zeile.datum);
      if (!datumIso) {
        fehler.push(`Datum nicht lesbar oder ungültig: "${zeile.datum}" (erwartet TT.MM.JJJJ oder JJJJ-MM-TT).`);
      } else {
        const zeit = zeile.uhrzeit || '12:00';
        const dt = new Date(`${datumIso}T${zeit.length === 5 ? zeit : zeit.slice(0, 5)}:00`);
        if (Number.isNaN(dt.getTime())) fehler.push(`Datum nicht lesbar: "${zeile.datum}".`);
        else readingAt = dt.toISOString();
      }
    } else {
      fehler.push('Datum fehlt.');
    }

    const wertErgebnis = parseMesswert(zeile.wert);
    const wert = wertErgebnis.ok ? wertErgebnis.value : null;
    if (!wertErgebnis.ok) fehler.push(wertErgebnis.fehler);

    let status = String(zeile.status || 'abgelesen').toLowerCase();
    if (!['abgelesen', 'geschaetzt'].includes(status)) {
      warnungen.push(`Status "${zeile.status}" unbekannt, wird als "abgelesen" übernommen.`);
      status = 'abgelesen';
    }

    // Messart (Teilwert) nur fuer Strom-/Waermemengenzaehler relevant - siehe
    // meterTypen.js teilungFuerTyp. Fehlende/unpassende Angaben werden auf den
    // jeweiligen Standardwert (Strom: Verbrauch) umgelegt bzw. als Fehler
    // gemeldet, wenn eine Pflichtangabe (Waerme) fehlt.
    let stromRichtung = null;
    let waermeTeil = null;
    let einheitUeberschreibung = null;
    if (meterType && istStromTyp(meterType)) {
      const messart = zeile.messart || 'verbrauch';
      if (!['verbrauch', 'einspeisung'].includes(messart)) {
        fehler.push(`Messart "${zeile.messart}" ungültig für Stromzähler (erwartet: verbrauch oder einspeisung).`);
      } else {
        stromRichtung = messart;
      }
    } else if (meterType && istWaermeKombiTyp(meterType)) {
      const messart = zeile.messart;
      if (!['kwh', 'm3'].includes(messart)) {
        fehler.push(`Messart "${zeile.messart || ''}" fehlt oder ungültig für Wärmemengenzähler (erforderlich: kwh oder m3, je ein eigener Zeile).`);
      } else {
        waermeTeil = messart;
        if (messart === 'm3') einheitUeberschreibung = 'm³';
      }
    } else if (zeile.messart) {
      warnungen.push(`Messart "${zeile.messart}" wird für diese Zählerart ignoriert.`);
    }

    let dublette = false;
    if (meter && readingAt && fehler.length === 0) {
      const batchSchluessel = `${meter.id !== null ? 'id:' + meter.id : 'neu:' + nummer}|${readingAt}|${stromRichtung || ''}|${waermeTeil || ''}`;
      if (gesehenInDieserDatei.has(batchSchluessel)) {
        dublette = true;
        warnungen.push('Zähler, Zeitpunkt und Messart kommen in dieser Datei mehrfach vor - nur die erste dieser Zeilen wird übernommen, diese wird übersprungen.');
      } else {
        gesehenInDieserDatei.add(batchSchluessel);
        if (meter.id !== null) {
          const dubletteQuery = knex('readings').where({ meter_id: meter.id, reading_at: readingAt });
          if (stromRichtung) dubletteQuery.andWhere({ strom_richtung: stromRichtung });
          if (waermeTeil) dubletteQuery.andWhere({ waerme_teil: waermeTeil });
          const vorhanden = await dubletteQuery.first();
          if (vorhanden) {
            dublette = true;
            warnungen.push('Für diesen Zähler, Zeitpunkt und diese Messart existiert bereits ein Messwert - Zeile wird beim Import übersprungen.');
          }
        }
      }
    }

    ergebnis.push({
      zeile: i + 1,
      eingabe: zeile,
      zaehlernummer: nummer || null,
      aufgeloest: meter && readingAt && fehler.length === 0 ? {
        meter_id: meter.id,
        meter_type_id: meterType ? meterType.id : null,
        reading_at: readingAt,
        value: wert,
        unit: einheitUeberschreibung || zeile.einheit || meter.unit,
        status,
        strom_richtung: stromRichtung,
        waerme_teil: waermeTeil,
        bemerkung: zeile.bemerkung || null,
      } : null,
      dublette,
      status: fehler.length > 0 ? 'fehler' : (warnungen.length > 0 ? 'warnung' : 'ok'),
      meldungen: [...fehler, ...warnungen],
    });
  }

  const summary = {
    gesamt: ergebnis.length,
    ok: ergebnis.filter((r) => r.status === 'ok').length,
    warnung: ergebnis.filter((r) => r.status === 'warnung').length,
    fehler: ergebnis.filter((r) => r.status === 'fehler').length,
    importierbar: ergebnis.filter((r) => r.aufgeloest && !r.dublette).length,
  };

  return { zeilen: ergebnis, summary };
}

module.exports = { validiereZeilen };
