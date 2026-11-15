const fs = require('fs');
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const knex = require('../db/knex');
const config = require('../config');
const { requireAuth } = require('../lib/auth');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const { istStromTyp, istWaermeKombiTyp, zaehlerAnzeigeName } = require('../lib/meterTypen');
const { erlaubteGruppenIds, darfMesswertErfassen } = require('../lib/berechtigung');
const { parseMesswert, parseDatumFlexibel, formatWert } = require('../lib/zahlenFormat');
const mailer = require('../lib/mailer');

const router = express.Router();

async function istKiVerfuegbar() {
  const cfg = await settings.getAiConfig();
  if (!cfg.enabled || !cfg.model) return false;
  if (cfg.provider === 'anthropic') return Boolean(cfg.apiKey);
  return Boolean(cfg.baseUrl);
}

// Nur die Zaehler anbieten, fuer deren Gruppe der Benutzer Messwerte erfassen
// darf (Admins sehen alle aktiven Zaehler). Ein Zaehler ohne Gruppe ist fuer
// Nicht-Admins nicht erfassbar (siehe lib/berechtigung.js).
async function ladeFormularDaten(user) {
  const meterTypes = await knex('meter_types').where({ active: true }).orderBy('sort_order');
  let meterQuery = knex('meters')
    .join('meter_types', 'meters.meter_type_id', 'meter_types.id')
    .leftJoin('meter_groups', 'meters.group_id', 'meter_groups.id')
    .select(
      'meters.*',
      'meter_types.key as type_key',
      'meter_types.label as type_label_name',
      'meter_types.unit as type_unit',
      'meter_types.waerme_kombi',
      'meter_groups.name as group_name'
    )
    .where('meters.active', true);
  if (user.role !== 'admin') {
    const gruppenIds = await erlaubteGruppenIds(user);
    meterQuery = gruppenIds.length > 0 ? meterQuery.whereIn('meters.group_id', gruppenIds) : meterQuery.whereRaw('1 = 0');
  }
  const meters = (await meterQuery.orderBy('meters.number')).map((m) => ({ ...m, anzeige_name: zaehlerAnzeigeName(m, m.type_label_name) }));
  const letzteRaw = await knex('readings')
    .join('meters', 'readings.meter_id', 'meters.id')
    .join('meter_types', 'readings.meter_type_id', 'meter_types.id')
    .select('readings.*', 'meters.number as meter_number', 'meters.group_id as meter_group_id', 'meter_types.label as type_label_name')
    .orderBy('readings.reading_at', 'desc')
    .limit(50);
  // Steuert nur, ob der Bearbeiten-/Korrigieren-Link angezeigt wird - die
  // eigentliche Berechtigung wird in den Routen unten serverseitig erneut
  // geprueft (siehe darfMesswertErfassen).
  const erlaubteGruppen = user.role === 'admin' ? null : new Set(await erlaubteGruppenIds(user));
  const letzte = letzteRaw.map((r) => ({
    ...r,
    bearbeitbar: user.role === 'admin' || (r.meter_group_id !== null && erlaubteGruppen.has(r.meter_group_id)),
  }));
  return { meterTypes, meters, letzte };
}

// Laedt einen einzelnen Messwert inkl. Zaehler-/Gruppeninfos - fuer die
// Berechtigungspruefung (group_id) und die Anzeige im Bearbeiten-/
// Korrigieren-Formular (Auftrag Abschnitt 3).
async function ladeMesswertMitZaehler(id) {
  return knex('readings')
    .join('meters', 'readings.meter_id', 'meters.id')
    .join('meter_types', 'readings.meter_type_id', 'meter_types.id')
    .leftJoin('meter_groups', 'meters.group_id', 'meter_groups.id')
    .select(
      'readings.*',
      'meters.number as meter_number',
      'meters.group_id as group_id',
      'meters.anzeige_bezeichnung',
      'meter_types.label as type_label_name',
      'meter_groups.name as group_name'
    )
    .where('readings.id', id)
    .first();
}

function erfolgsMeldung(query) {
  if (query.gespeichert) return 'Messwert gespeichert.';
  if (query.bearbeitet) return 'Messwert aktualisiert.';
  if (query.korrektur_eingereicht) return 'Korrektur eingereicht - ein Administrator muss sie noch freigeben.';
  return null;
}

router.get('/messwerte', requireAuth, async (req, res) => {
  const { meterTypes, meters, letzte } = await ladeFormularDaten(req.user);
  res.render('messwerte', {
    titel: 'Messwerte erfassen',
    meterTypes,
    meters,
    letzte,
    aiEnabled: await istKiVerfuegbar(),
    fehler: null,
    erfolg: erfolgsMeldung(req.query),
  });
});

router.post('/messwerte', requireAuth, async (req, res) => {
  try {
    const meterId = Number(req.body.meter_id);
    const meter = await knex('meters').where({ id: meterId, active: true }).first();
    if (!meter) throw new Error('Unbekannter oder inaktiver Zähler.');
    if (!(await darfMesswertErfassen(req.user, meter))) {
      return res.status(403).render('fehler', { titel: 'Keine Berechtigung', nachricht: 'Fuer diesen Zaehler (bzw. dessen Gruppe) duerfen Sie keine Messwerte erfassen.' });
    }
    const meterType = await knex('meter_types').where({ id: meter.meter_type_id }).first();
    const strom = istStromTyp(meterType);
    const waermeKombi = istWaermeKombiTyp(meterType);

    // Die Ableseuhrzeit wird nicht mehr im Formular abgefragt (Auftrag Abschnitt 2);
    // sie wird mit der aktuellen Uhrzeit der Erfassung ergaenzt, damit der Zeitstempel
    // (reading_at) weiterhin vollstaendig bleibt. parseDatumFlexibel prueft
    // zusaetzlich inhaltlich (kein stillschweigendes Umdeuten ungueltiger Daten),
    // akzeptiert aber weiterhin das vom <input type="date"> gelieferte ISO-Format.
    const datumIso = parseDatumFlexibel(req.body.datum);
    if (!datumIso) throw new Error('Datum ungültig.');
    const uhrzeit = new Date().toTimeString().slice(0, 5);
    const readingAt = new Date(`${datumIso}T${uhrzeit}:00`);
    if (Number.isNaN(readingAt.getTime())) throw new Error('Datum ungültig.');

    const wertErgebnis = parseMesswert(req.body.wert);
    if (!wertErgebnis.ok) throw new Error(wertErgebnis.fehler);
    const wert = wertErgebnis.value;

    // Stromzaehler: Einspeisung (OBIS 2.8.0) ist optional und gehoert zum selben
    // Zaehler und Ablesedatum wie der Verbrauch (OBIS 1.8.0) - wird als zweiter,
    // eindeutig gekennzeichneter Messwert gespeichert (Auftrag Abschnitt 1).
    let einspeisungWert = null;
    if (strom && String(req.body.wert_einspeisung || '').trim() !== '') {
      const einspeisungErgebnis = parseMesswert(req.body.wert_einspeisung);
      if (!einspeisungErgebnis.ok) throw new Error('Einspeisungswert: ' + einspeisungErgebnis.fehler);
      einspeisungWert = einspeisungErgebnis.value;
    }

    // Waermemengenzaehler: kWh UND m³ sind Pflicht und gehoeren zum selben
    // Zaehler/Ablesedatum (Auftrag "Messwerterfassung") - anders als die
    // optionale Stromeinspeisung wird hier ohne beide Werte abgebrochen.
    let waermeM3Wert = null;
    if (waermeKombi) {
      if (String(req.body.wert_m3 || '').trim() === '') throw new Error('Für Wärmemengenzähler ist zusätzlich der m³-Wert erforderlich.');
      const waermeM3Ergebnis = parseMesswert(req.body.wert_m3);
      if (!waermeM3Ergebnis.ok) throw new Error('m³-Wert: ' + waermeM3Ergebnis.fehler);
      waermeM3Wert = waermeM3Ergebnis.value;
    }

    // Die Auswahl "abgelesen/geschaetzt" wurde aus der Erfassungsoberflaeche entfernt
    // (Auftrag Abschnitt 2); neue manuelle Messwerte gelten als "abgelesen". Die
    // Spalte und historische "geschaetzt"-Werte bleiben unveraendert kompatibel.
    const status = 'abgelesen';

    const [id] = await knex('readings').insert({
      meter_id: meter.id,
      meter_type_id: meter.meter_type_id,
      reading_at: readingAt.toISOString(),
      value: wert,
      unit: meter.unit,
      status,
      strom_richtung: strom ? 'verbrauch' : null,
      waerme_teil: waermeKombi ? 'kwh' : null,
      bemerkung: req.body.bemerkung || null,
      created_by: req.user.id,
    });

    if (einspeisungWert !== null) {
      await knex('readings').insert({
        meter_id: meter.id,
        meter_type_id: meter.meter_type_id,
        reading_at: readingAt.toISOString(),
        value: einspeisungWert,
        unit: meter.unit,
        status,
        strom_richtung: 'einspeisung',
        bemerkung: req.body.bemerkung || null,
        created_by: req.user.id,
      });
    }

    if (waermeM3Wert !== null) {
      await knex('readings').insert({
        meter_id: meter.id,
        meter_type_id: meter.meter_type_id,
        reading_at: readingAt.toISOString(),
        value: waermeM3Wert,
        unit: 'm³',
        status,
        waerme_teil: 'm3',
        bemerkung: req.body.bemerkung || null,
        created_by: req.user.id,
      });
    }

    const fotoTempId = req.body.foto_temp_id;
    const fotoSpeichern = req.body.foto_speichern === 'on' || req.body.foto_speichern === 'true';
    if (fotoTempId) {
      const tmpPath = findeTempFoto(fotoTempId);
      if (tmpPath && fotoSpeichern) {
        const ext = path.extname(tmpPath);
        const zielName = crypto.randomUUID() + ext;
        fs.renameSync(tmpPath, path.join(config.UPLOADS_DIR, zielName));
        await knex('photos').insert({
          filename: zielName,
          original_name: path.basename(tmpPath),
          mime: ext === '.png' ? 'image/png' : 'image/jpeg',
          size: fs.statSync(path.join(config.UPLOADS_DIR, zielName)).size,
          reading_id: id,
          created_by: req.user.id,
        });
      } else if (tmpPath) {
        fs.unlinkSync(tmpPath);
      }
    }

    const erfassungsweg = req.body.erfassungsweg === 'fotoanalyse' ? 'fotoanalyse' : 'manuell';
    await audit.log(req.user.id, 'messwert_erfasst', {
      meter_id: meter.id,
      reading_id: id,
      erfassungsweg,
      mit_einspeisung: einspeisungWert !== null,
      mit_waerme_m3: waermeM3Wert !== null,
    });

    // E-Mail-Benachrichtigung NUR bei dieser neuen, regulaeren manuellen
    // Messwerterfassung (Auftrag Abschnitt 5) - bewusst nie bei Korrekturen,
    // Admin-Bearbeitungen, Loeschungen oder Importen (siehe dortige Routen,
    // dort gibt es keinen entsprechenden Aufruf). Fire-and-forget: wird nicht
    // awaited, damit ein SMTP-Problem die bereits gespeicherte Erfassung nie
    // verzoegert oder rueckgaengig macht (mailer.sendMail faengt alle Fehler
    // bereits intern ab).
    benachrichtigeNeuenMesswert({
      meter,
      meterType,
      datumIso,
      strom,
      waermeKombi,
      wert,
      einspeisungWert,
      waermeM3Wert,
      bemerkung: req.body.bemerkung || null,
    }).catch((err) => console.error('Benachrichtigung bei neuem Messwert fehlgeschlagen:', err.message));

    res.redirect('/messwerte?gespeichert=1');
  } catch (err) {
    console.error('Fehler in readings.js:', err.message);
    const { meterTypes, meters, letzte } = await ladeFormularDaten(req.user);
    res.status(400).render('messwerte', {
      titel: 'Messwerte erfassen',
      meterTypes,
      meters,
      letzte,
      aiEnabled: await istKiVerfuegbar(),
      fehler: err.message,
      erfolg: null,
    });
  }
});

// --- Messwert bearbeiten (Admin, direkt) bzw. Korrektur vorschlagen (Benutzer) --
// Auftrag Abschnitt 3: Bestehende Messwerte duerfen nur Admins direkt bearbeiten.
// Normale Benutzer erstellen stattdessen einen Korrektur-Eintrag (Tabelle
// reading_corrections), der erst nach Freigabe durch einen Admin
// (admin.js /admin/korrekturen) tatsaechlich den Messwert aendert. Die
// Berechtigung (Gruppe des betroffenen Zaehlers) ist dieselbe wie beim
// Erfassen (darfMesswertErfassen) - serverseitig in BEIDEN Routen geprueft,
// unabhaengig davon, ob der Link in der Oberflaeche angezeigt wird.
router.get('/messwerte/:id/bearbeiten', requireAuth, async (req, res) => {
  const reading = await ladeMesswertMitZaehler(req.params.id);
  if (!reading) return res.status(404).render('fehler', { titel: 'Nicht gefunden', nachricht: 'Messwert nicht gefunden.' });
  const berechtigt = req.user.role === 'admin' || await darfMesswertErfassen(req.user, { group_id: reading.group_id });
  if (!berechtigt) {
    return res.status(403).render('fehler', { titel: 'Keine Berechtigung', nachricht: 'Fuer diesen Zaehler (bzw. dessen Gruppe) duerfen Sie keine Korrektur vorschlagen.' });
  }
  res.render('messwert_bearbeiten', { titel: 'Messwert bearbeiten', reading, istAdmin: req.user.role === 'admin', fehler: null });
});

router.post('/messwerte/:id/bearbeiten', requireAuth, async (req, res) => {
  const reading = await ladeMesswertMitZaehler(req.params.id);
  if (!reading) return res.status(404).render('fehler', { titel: 'Nicht gefunden', nachricht: 'Messwert nicht gefunden.' });
  const berechtigt = req.user.role === 'admin' || await darfMesswertErfassen(req.user, { group_id: reading.group_id });
  if (!berechtigt) {
    return res.status(403).render('fehler', { titel: 'Keine Berechtigung', nachricht: 'Fuer diesen Zaehler (bzw. dessen Gruppe) duerfen Sie keine Korrektur vorschlagen.' });
  }

  const istAdmin = req.user.role === 'admin';
  try {
    const wertErgebnis = parseMesswert(req.body.wert);
    if (!wertErgebnis.ok) throw new Error(wertErgebnis.fehler);

    // Datum optional - leer gelassen bedeutet "Datum unveraendert lassen".
    let neuesReadingAt = null;
    if (String(req.body.datum || '').trim() !== '') {
      const datumIso = parseDatumFlexibel(req.body.datum);
      if (!datumIso) throw new Error('Datum ungültig (erwartet TT.MM.JJJJ oder JJJJ-MM-TT).');
      const bisherigeZeit = new Date(reading.reading_at).toISOString().slice(11, 16);
      neuesReadingAt = new Date(`${datumIso}T${bisherigeZeit}:00`).toISOString();
    }
    const bemerkung = String(req.body.bemerkung || '').trim();

    if (istAdmin) {
      const update = { value: wertErgebnis.value };
      if (neuesReadingAt) update.reading_at = neuesReadingAt;
      if (bemerkung) update.bemerkung = bemerkung;
      await knex('readings').where({ id: reading.id }).update(update);
      await audit.log(req.user.id, 'messwert_bearbeitet', {
        reading_id: reading.id,
        meter_id: reading.meter_id,
        alter_wert: Number(reading.value),
        neuer_wert: wertErgebnis.value,
        altes_datum: reading.reading_at,
        neues_datum: neuesReadingAt || reading.reading_at,
      });
      return res.redirect('/messwerte?bearbeitet=1');
    }

    if (!bemerkung) throw new Error('Bitte eine Begründung für die Korrektur angeben.');
    const [korrekturId] = await knex('reading_corrections').insert({
      reading_id: reading.id,
      vorgeschlagener_wert: wertErgebnis.value,
      vorgeschlagenes_datum: neuesReadingAt,
      bemerkung,
      status: 'offen',
      erstellt_von: req.user.id,
    });
    await audit.log(req.user.id, 'korrektur_vorgeschlagen', {
      reading_id: reading.id,
      korrektur_id: korrekturId,
      vorgeschlagener_wert: wertErgebnis.value,
    });
    res.redirect('/messwerte?korrektur_eingereicht=1');
  } catch (err) {
    console.error('Fehler in readings.js (bearbeiten/korrigieren):', err.message);
    res.status(400).render('messwert_bearbeiten', { titel: 'Messwert bearbeiten', reading, istAdmin, fehler: err.message });
  }
});

// Baut die Benachrichtigungs-Zeilen (bis zu 3: Hauptwert, optionale Stromein-
// speisung, optionaler Waerme-m³-Wert) zusammen und verschickt sie als EINE
// E-Mail pro Erfassungsvorgang (siehe mailer.js). Holt die Zählergruppe separat
// nach, da der in POST /messwerte geladene `meter` (bewusst ohne Join) keinen
// Gruppennamen enthält.
async function benachrichtigeNeuenMesswert({ meter, meterType, datumIso, strom, waermeKombi, wert, einspeisungWert, waermeM3Wert, bemerkung }) {
  const cfg = await settings.getSmtpConfig();
  if (!cfg.enabled || !cfg.notifyMesswertEnabled || cfg.notifyMesswertRecipients.length === 0) return;

  const gruppe = meter.group_id ? await knex('meter_groups').where({ id: meter.group_id }).first() : null;
  const zaehlerName = zaehlerAnzeigeName({ ...meter, group_name: gruppe ? gruppe.name : null }, meterType.label);

  const zeilen = [{ label: strom ? `${meterType.label} (Verbrauch)` : (waermeKombi ? `${meterType.label} (kWh)` : meterType.label), wert: formatWert(wert, 'abgelesen'), einheit: waermeKombi ? 'kWh' : meter.unit }];
  if (einspeisungWert !== null) zeilen.push({ label: `${meterType.label} (Einspeisung)`, wert: formatWert(einspeisungWert, 'abgelesen'), einheit: meter.unit });
  if (waermeM3Wert !== null) zeilen.push({ label: `${meterType.label} (m³)`, wert: formatWert(waermeM3Wert, 'abgelesen'), einheit: 'm³' });

  await mailer.sendNeueMesswerteBenachrichtigung({
    empfaenger: cfg.notifyMesswertRecipients,
    zaehlerName,
    zaehlerNummer: meter.number,
    datum: datumIso,
    zeilen,
    bemerkung,
  });
}

function findeTempFoto(tempId) {
  const safe = String(tempId).replace(/[^a-zA-Z0-9-]/g, '');
  const dir = config.TMP_UPLOADS_DIR;
  const treffer = fs.readdirSync(dir).find((f) => f.startsWith(safe + '.'));
  return treffer ? path.join(dir, treffer) : null;
}

module.exports = router;
