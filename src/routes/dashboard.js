const express = require('express');
const knex = require('../db/knex');
const { requireAuth } = require('../lib/auth');
const { latestPerMeter } = require('../lib/consumption');
const { aktuellerStandSchaetzung } = require('../lib/forecast');
const { effektivEichdatenAnzeigen, zaehlerAnzeigeName } = require('../lib/meterTypen');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  let stand = await latestPerMeter();

  const gefilterterMeterId = req.query.meter_id ? Number(req.query.meter_id) : null;
  if (gefilterterMeterId) {
    stand = stand.filter((s) => s.meter.id === gefilterterMeterId);
  }

  for (const s of stand) {
    s.anzeigeName = zaehlerAnzeigeName(s.meter, s.meter.type_label_name);
  }

  // Voraussichtlicher aktueller Stand: rein informative, taeglich neu berechnete
  // Hochrechnung vom letzten Messwert bis heute (Auftrag Abschnitt 4) - wird
  // nirgends gespeichert und nicht exportiert.
  for (const s of stand) {
    const feld = s.richtung ? 'strom_richtung' : (s.teil ? 'waerme_teil' : null);
    const wert = s.richtung || s.teil || null;
    s.prognoseAktuell = s.aktuell ? await aktuellerStandSchaetzung(s.meter.id, { feld, wert }) : { moeglich: false };
  }

  const heute = new Date();
  const in90Tagen = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const eichfristen = await knex('meters')
    .join('meter_types', 'meters.meter_type_id', 'meter_types.id')
    .leftJoin('meter_groups', 'meters.group_id', 'meter_groups.id')
    .select('meters.*', 'meter_types.label as type_label_name', 'meter_types.eichdaten_anzeigen_standard', 'meter_groups.name as group_name')
    .where('meters.active', true)
    .whereNotNull('meters.eich_frist')
    .orderBy('meters.eich_frist');

  const eichfristenListe = eichfristen
    .filter((m) => effektivEichdatenAnzeigen(m))
    .map((m) => ({
      meter: m,
      anzeigeName: zaehlerAnzeigeName(m, m.type_label_name),
      abgelaufen: new Date(m.eich_frist) < heute,
      baldFaellig: new Date(m.eich_frist) >= heute && new Date(m.eich_frist) <= in90Tagen,
    }))
    .filter((e) => e.abgelaufen || e.baldFaellig);

  const alleAktivenZaehler = await knex('meters')
    .join('meter_types', 'meters.meter_type_id', 'meter_types.id')
    .leftJoin('meter_groups', 'meters.group_id', 'meter_groups.id')
    .select('meters.*', 'meter_types.label as type_label_name', 'meter_groups.name as group_name')
    .where('meters.active', true)
    .orderBy(['meter_types.sort_order', 'meters.number'])
    .then((liste) => liste.map((m) => ({ ...m, anzeigeName: zaehlerAnzeigeName(m, m.type_label_name) })));

  res.render('dashboard', { titel: 'Dashboard', stand, eichfristenListe, alleAktivenZaehler, gefilterterMeterId });
});

module.exports = router;
