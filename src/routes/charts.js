const express = require('express');
const knex = require('../db/knex');
const { requireAuth } = require('../lib/auth');
const { timelineForType } = require('../lib/consumption');
const { forecastForType } = require('../lib/forecast');

const router = express.Router();

router.get('/diagramme', requireAuth, async (req, res) => {
  const meterTypes = await knex('meter_types').where({ active: true }).orderBy('sort_order');
  res.render('diagramme', { titel: 'Diagramme', meterTypes });
});

// Liefert fuer einen oder mehrere Zaehlertypen die Zeitreihe inkl. Markierung
// von Schaetzwerten, Datenluecken und Zaehlerwechseln. Vergleichseinheiten
// werden nur dann gemeinsam dargestellt, wenn sie uebereinstimmen.
router.get('/api/diagramme/daten', requireAuth, async (req, res) => {
  const ids = String(req.query.meterTypeIds || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean);
  if (ids.length === 0) return res.json({ reihen: [] });

  const von = req.query.von ? new Date(req.query.von) : null;
  const bis = req.query.bis ? new Date(req.query.bis) : null;
  const vorjahr = req.query.vorjahr === '1';

  const typen = await knex('meter_types').whereIn('id', ids);
  const reihen = [];
  for (const typ of typen) {
    const segmente = await timelineForType(typ.id, von, bis);
    reihen.push({ meterType: typ, segmente, vorjahr: false });
    if (vorjahr && von && bis) {
      const vonVorjahr = new Date(von); vonVorjahr.setFullYear(vonVorjahr.getFullYear() - 1);
      const bisVorjahr = new Date(bis); bisVorjahr.setFullYear(bisVorjahr.getFullYear() - 1);
      const segmenteVorjahr = await timelineForType(typ.id, vonVorjahr, bisVorjahr);
      reihen.push({ meterType: typ, segmente: segmenteVorjahr, vorjahr: true });
    }
  }
  res.json({ reihen });
});

router.get('/api/diagramme/prognose', requireAuth, async (req, res) => {
  const meterTypeId = Number(req.query.meterTypeId);
  const tage = Number(req.query.tage || 90);
  if (!meterTypeId) return res.status(400).json({ error: 'meterTypeId fehlt' });
  const prognose = await forecastForType(meterTypeId, { tageVoraus: tage });
  res.json(prognose);
});

module.exports = router;
