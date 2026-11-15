const express = require('express');
const knex = require('../db/knex');
const { requireAuth, requireAdmin } = require('../lib/auth');
const audit = require('../lib/audit');
const { effektivEichdatenAnzeigen } = require('../lib/meterTypen');

const router = express.Router();

// Die gesamte Zaehlerverwaltung (Anlegen/Aendern/Zaehlerwechsel/Loeschen) ist
// eine Verwaltungsfunktion und daher ausschliesslich Admins vorbehalten
// (Auftrag "Zaehlergruppen und Berechtigungen" - Benutzer duerfen nur noch
// Messwerte erfassen, siehe routes/readings.js). Ausdruecklich auf "/zaehler"
// beschraenkt (nicht pfadlos), da dieser Router in server.js auf "/" montiert
// ist und ein pfadloses router.use(...) sonst JEDE danach montierte Route
// (z. B. /diagramme) mit abfangen wuerde, selbst wenn dieser Router dafuer gar
// keinen eigenen Treffer hat.
router.use('/zaehler', requireAuth, requireAdmin);

async function ladeZaehlerListe() {
  const liste = await knex('meters')
    .join('meter_types', 'meters.meter_type_id', 'meter_types.id')
    .leftJoin('meter_groups', 'meters.group_id', 'meter_groups.id')
    .select('meters.*', 'meter_types.label as type_label_name', 'meter_types.eichdaten_anzeigen_standard', 'meter_groups.name as group_name', 'meter_groups.sort_order as group_sort_order')
    .orderBy(['meter_types.sort_order', 'meters.active', 'meters.number']);
  const anzahl = await knex('readings').select('meter_id').count('id as n').groupBy('meter_id');
  const anzahlJeZaehler = new Map(anzahl.map((a) => [a.meter_id, Number(a.n)]));
  return liste.map((z) => ({ ...z, reading_count: anzahlJeZaehler.get(z.id) || 0, eichdaten_anzeigen_effektiv: effektivEichdatenAnzeigen(z) }));
}

// Gruppiert aktive Zaehler nach ihrer Zaehlergruppe (sortiert nach deren
// sort_order, Zaehler ohne Gruppe am Ende als eigene "Ohne Gruppe"-Gruppe);
// nicht mehr verbaute/inaktive Zaehler (z. B. nach Zaehlerwechsel) werden
// unabhaengig von ihrer frueheren Gruppe separat am Ende gefuehrt (Auftrag
// Abschnitt 2) - der Status selbst wird dabei nicht veraendert, nur die
// Darstellung gruppiert.
function gruppiereZaehlerFuerAnsicht(liste) {
  const aktive = liste.filter((z) => z.active);
  const inaktive = liste.filter((z) => !z.active).sort((a, b) => String(a.number).localeCompare(String(b.number)));

  const gruppenMap = new Map();
  for (const z of aktive) {
    const schluessel = z.group_id || 'ohne';
    if (!gruppenMap.has(schluessel)) {
      gruppenMap.set(schluessel, { name: z.group_name || 'Ohne Gruppe', sortOrder: z.group_id ? Number(z.group_sort_order) || 0 : Infinity, zaehler: [] });
    }
    gruppenMap.get(schluessel).zaehler.push(z);
  }
  const gruppen = [...gruppenMap.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  return { gruppen, inaktive };
}

router.get('/zaehler', async (req, res) => {
  const zaehler = await ladeZaehlerListe();
  const { gruppen, inaktive } = gruppiereZaehlerFuerAnsicht(zaehler);
  res.render('zaehler', { titel: 'Zählerverwaltung', gruppen, inaktive, fehler: null, erfolg: req.query.gespeichert ? 'Gespeichert.' : null });
});

router.get('/zaehler/neu', async (req, res) => {
  const meterTypes = await knex('meter_types').where({ active: true }).orderBy('sort_order');
  const gruppen = await knex('meter_groups').where({ active: true }).orderBy('sort_order');
  const aktiveZaehler = await knex('meters').where({ active: true }).orderBy('number');
  res.render('zaehler_form', { titel: 'Neuer Zähler', meterTypes, gruppen, aktiveZaehler, zaehler: null, fehler: null });
});

router.post('/zaehler', async (req, res) => {
  try {
    const daten = await feldWerte(req.body);
    const ersetztId = req.body.ersetzt_meter_id ? Number(req.body.ersetzt_meter_id) : null;

    let neuId;
    await knex.transaction(async (trx) => {
      [neuId] = await trx('meters').insert(daten);
      if (ersetztId) {
        const alt = await trx('meters').where({ id: ersetztId, active: true }).first();
        if (!alt) throw new Error('Der zu ersetzende Zähler wurde nicht gefunden oder ist bereits ausgebaut.');
        const heute = new Date().toISOString().slice(0, 10);
        await trx('meters').where({ id: ersetztId }).update({ active: false, ausbau_datum: heute, updated_at: trx.fn.now() });
        await trx('meters').where({ id: neuId }).update({ ersetzt_meter_id: ersetztId });
      }
    });

    await audit.log(req.user.id, 'zaehler_angelegt', { meter_id: neuId, number: daten.number });
    if (ersetztId) await audit.log(req.user.id, 'zaehlerwechsel', { alter_zaehler: ersetztId, neuer_zaehler: neuId, markiert_bei: 'anlage' });
    res.redirect('/zaehler?gespeichert=1');
  } catch (err) {
    console.error('Fehler in meters.js:', err.message);
    const meterTypes = await knex('meter_types').where({ active: true }).orderBy('sort_order');
    const gruppen = await knex('meter_groups').where({ active: true }).orderBy('sort_order');
    const aktiveZaehler = await knex('meters').where({ active: true }).orderBy('number');
    res.status(400).render('zaehler_form', { titel: 'Neuer Zähler', meterTypes, gruppen, aktiveZaehler, zaehler: req.body, fehler: err.message });
  }
});

router.get('/zaehler/:id/bearbeiten', async (req, res) => {
  const zaehler = await knex('meters').where({ id: req.params.id }).first();
  if (!zaehler) return res.status(404).render('fehler', { titel: 'Nicht gefunden', nachricht: 'Zähler nicht gefunden.' });
  const meterTypes = await knex('meter_types').where({ active: true }).orderBy('sort_order');
  const gruppen = await knex('meter_groups').where({ active: true }).orderBy('sort_order');
  res.render('zaehler_form', { titel: 'Zähler bearbeiten', meterTypes, gruppen, aktiveZaehler: [], zaehler, fehler: null });
});

router.post('/zaehler/:id', async (req, res) => {
  try {
    const daten = await feldWerte(req.body);
    daten.updated_at = knex.fn.now();
    await knex('meters').where({ id: req.params.id }).update(daten);
    await audit.log(req.user.id, 'zaehler_bearbeitet', { meter_id: req.params.id });
    res.redirect('/zaehler?gespeichert=1');
  } catch (err) {
    console.error('Fehler in meters.js:', err.message);
    const zaehler = await knex('meters').where({ id: req.params.id }).first();
    const meterTypes = await knex('meter_types').where({ active: true }).orderBy('sort_order');
    const gruppen = await knex('meter_groups').where({ active: true }).orderBy('sort_order');
    res.status(400).render('zaehler_form', { titel: 'Zähler bearbeiten', meterTypes, gruppen, aktiveZaehler: [], zaehler: { ...zaehler, ...req.body }, fehler: err.message });
  }
});

// Zaehlerwechsel: alter Zaehler wird mit Ausbaudatum/Abschlussstand geschlossen
// (seine Historie bleibt unveraendert erhalten), ein neuer Zaehler beginnt eine
// eigene Messreihe. Es wird NIE ueber den Wechsel hinweg ein Verbrauch berechnet.
router.post('/zaehler/:id/wechsel', async (req, res) => {
  const altId = Number(req.params.id);
  try {
    let neuId;
    await knex.transaction(async (trx) => {
      const alt = await trx('meters').where({ id: altId }).first();
      if (!alt) throw new Error('Zähler nicht gefunden.');

      const ausbauDatum = req.body.ausbau_datum || new Date().toISOString().slice(0, 10);
      // Die Ableseuhrzeit wird nicht mehr im Formular abgefragt (Auftrag Abschnitt 6);
      // sie wird mit der aktuellen Uhrzeit der Erfassung ergaenzt, analog zu readings.js.
      const uhrzeit = new Date().toTimeString().slice(0, 5);
      await trx('meters').where({ id: altId }).update({ ausbau_datum: ausbauDatum, active: false, updated_at: trx.fn.now() });

      if (req.body.abschluss_wert) {
        await trx('readings').insert({
          meter_id: alt.id,
          meter_type_id: alt.meter_type_id,
          reading_at: new Date(`${ausbauDatum}T${uhrzeit}:00`).toISOString(),
          value: Number(String(req.body.abschluss_wert).replace(',', '.')),
          unit: alt.unit,
          status: 'abgelesen',
          is_ausbau_reading: true,
          bemerkung: 'Abschlussstand bei Zählerwechsel',
          created_by: req.user.id,
        });
      }

      const neu = {
        meter_type_id: alt.meter_type_id,
        group_id: alt.group_id,
        anzeige_bezeichnung: alt.anzeige_bezeichnung,
        number: req.body.neu_number,
        manufacturer: req.body.neu_manufacturer || null,
        messbetreiber: req.body.neu_messbetreiber || alt.messbetreiber,
        type_label: req.body.neu_type_label || null,
        unit: alt.unit,
        eich_datum: req.body.neu_eich_datum || null,
        eich_frist: req.body.neu_eich_frist || null,
        eichdaten_anzeigen: alt.eichdaten_anzeigen,
        einbau_datum: ausbauDatum,
        active: true,
        betreiber_typ: alt.betreiber_typ,
        eichfrist_benachrichtigen: alt.eichfrist_benachrichtigen,
        ersetzt_meter_id: alt.id,
      };
      if (!neu.number) throw new Error('Zählernummer des neuen Zählers fehlt.');
      [neuId] = await trx('meters').insert(neu);

      if (req.body.einbau_wert) {
        await trx('readings').insert({
          meter_id: neuId,
          meter_type_id: alt.meter_type_id,
          reading_at: new Date(`${ausbauDatum}T${uhrzeit}:00`).toISOString(),
          value: Number(String(req.body.einbau_wert).replace(',', '.')),
          unit: alt.unit,
          status: 'abgelesen',
          bemerkung: 'Einbaustand (Übergangsstand) nach Zählerwechsel',
          created_by: req.user.id,
        });
      }
    });
    // Audit-Eintrag erst NACH der Transaktion (sonst versucht audit.log ueber den
    // globalen Pool eine zweite Verbindung waehrend die Transaktion die einzige
    // Verbindung haelt - das lief bisher in einen Pool-Timeout und der Eintrag
    // ging stillschweigend verloren, siehe auditierter Fehler "Timeout acquiring
    // a connection").
    await audit.log(req.user.id, 'zaehlerwechsel', { alter_zaehler: altId, neuer_zaehler: neuId, markiert_bei: 'alter_zaehler' });
    res.redirect('/zaehler?gespeichert=1');
  } catch (err) {
    console.error('Fehler in meters.js:', err.message);
    res.status(400).render('fehler', { titel: 'Zählerwechsel fehlgeschlagen', nachricht: err.message });
  }
});

// Loeschen ist ausschliesslich Admins vorbehalten (Auftrag Abschnitt 5) und wird
// im Audit protokolliert. Die Datenbank verhindert ueber den Fremdschluessel
// readings.meter_id (RESTRICT), dass dabei historische Messwerte verwaisen -
// ein Zaehler mit Messwerten kann daher nicht geloescht werden (stattdessen
// deaktivieren).
router.post('/zaehler/:id/loeschen', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const zaehler = await knex('meters').where({ id }).first();
    if (!zaehler) return res.redirect('/zaehler');
    await knex('meters').where({ id }).del();
    await audit.log(req.user.id, 'zaehler_geloescht', { meter_id: id, number: zaehler.number });
    res.redirect('/zaehler?gespeichert=1');
  } catch (err) {
    console.error('Fehler in meters.js (loeschen):', err.message);
    const zaehler = await ladeZaehlerListe();
    const { gruppen, inaktive } = gruppiereZaehlerFuerAnsicht(zaehler);
    res.status(400).render('zaehler', {
      titel: 'Zählerverwaltung',
      gruppen,
      inaktive,
      erfolg: null,
      fehler: 'Dieser Zähler kann nicht gelöscht werden, da noch Messwerte mit ihm verbunden sind (Historie bleibt geschützt). Bitte stattdessen deaktivieren.',
    });
  }
});

async function feldWerte(body) {
  const nummer = String(body.number || '').trim();
  if (!nummer) throw new Error('Zählernummer ist erforderlich.');
  const meterTypeId = Number(body.meter_type_id);
  if (!meterTypeId) throw new Error('Zählerart ist erforderlich.');
  const groupId = Number(body.group_id);
  if (!groupId) throw new Error('Zählergruppe ist erforderlich.');
  const gruppe = await knex('meter_groups').where({ id: groupId, active: true }).first();
  if (!gruppe) throw new Error('Unbekannte oder deaktivierte Zählergruppe.');
  const betreiberTyp = body.betreiber_typ === 'energieversorger' ? 'energieversorger' : 'eigentuemer';
  // eichdaten_anzeigen: leerer Wert = Vorgabe der Zaehlerart uebernehmen (NULL),
  // sonst expliziter Override fuer genau diesen Zaehler (Auftrag Abschnitt 2).
  let eichdatenAnzeigen = null;
  if (body.eichdaten_anzeigen === '1') eichdatenAnzeigen = true;
  else if (body.eichdaten_anzeigen === '0') eichdatenAnzeigen = false;
  return {
    meter_type_id: meterTypeId,
    group_id: groupId,
    anzeige_bezeichnung: String(body.anzeige_bezeichnung || '').trim() || null,
    number: nummer,
    manufacturer: body.manufacturer || null,
    messbetreiber: body.messbetreiber || null,
    type_label: body.type_label || null,
    unit: body.unit || 'm³',
    eich_datum: body.eich_datum || null,
    eich_frist: body.eich_frist || null,
    eichdaten_anzeigen: eichdatenAnzeigen,
    einbau_datum: body.einbau_datum || null,
    ausbau_datum: body.ausbau_datum || null,
    bemerkung: body.bemerkung || null,
    active: body.active === 'on' || body.active === 'true' || body.active === undefined,
    betreiber_typ: betreiberTyp,
    eichfrist_benachrichtigen: body.eichfrist_benachrichtigen === 'on' || body.eichfrist_benachrichtigen === 'true',
  };
}

module.exports = router;
