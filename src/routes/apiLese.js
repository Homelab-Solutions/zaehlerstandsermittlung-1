// Versionierte, ausschliesslich lesende API fuer ein spaeteres externes
// Nebenkostenabrechnungsprogramm (Auftrag Abschnitt 1). Komplett unabhaengig
// von der Session-Anmeldung der Web-Oberflaeche; Authentifizierung ausschliesslich
// ueber den admin-verwalteten Schluessel (siehe apiLeseAuth.js). Liefert NIE die
// unverbindliche Prognose (forecast.js) - nur tatsaechlich gespeicherte Messwerte.
const express = require('express');
const rateLimit = require('express-rate-limit');
const knex = require('../db/knex');
const { requireApiKey } = require('../lib/apiLeseAuth');

const router = express.Router();

const begrenzer = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte die Anfragerate verringern.' },
});
router.use(begrenzer);
router.use(requireApiKey);

function paginierung(req, res) {
  const seite = Number.parseInt(req.query.seite, 10);
  const proSeite = Number.parseInt(req.query.pro_seite, 10);
  const s = Number.isFinite(seite) && seite >= 1 ? seite : 1;
  const p = Number.isFinite(proSeite) && proSeite >= 1 ? Math.min(proSeite, 500) : 100;
  if (req.query.seite !== undefined && !(Number.isFinite(seite) && seite >= 1)) {
    res.status(400).json({ error: '"seite" muss eine ganze Zahl >= 1 sein.' });
    return null;
  }
  if (req.query.pro_seite !== undefined && !(Number.isFinite(proSeite) && proSeite >= 1)) {
    res.status(400).json({ error: '"pro_seite" muss eine ganze Zahl >= 1 sein (maximal 500).' });
    return null;
  }
  return { seite: s, proSeite: p, offset: (s - 1) * p };
}

function hUlle(daten, gesamt, seite, proSeite) {
  return {
    daten,
    seite,
    pro_seite: proSeite,
    gesamt,
    gesamt_seiten: Math.max(1, Math.ceil(gesamt / proSeite)),
  };
}

// --- Zaehler (aktiv und historisch) inkl. Metadaten und Wechselbeziehungen ---
router.get('/zaehler', async (req, res) => {
  const seite = paginierung(req, res);
  if (!seite) return;

  const [{ n: gesamt }] = await knex('meters').count('id as n');
  const zeilen = await knex('meters')
    .join('meter_types', 'meters.meter_type_id', 'meter_types.id')
    .select(
      'meters.id',
      'meters.number',
      'meters.manufacturer',
      'meters.messbetreiber',
      'meters.type_label',
      'meters.unit',
      'meters.eich_datum',
      'meters.eich_frist',
      'meters.einbau_datum',
      'meters.ausbau_datum',
      'meters.active',
      'meters.betreiber_typ',
      'meters.ersetzt_meter_id',
      'meters.bemerkung',
      'meters.created_at',
      'meters.updated_at',
      'meter_types.id as zaehlerart_id',
      'meter_types.key as zaehlerart_key',
      'meter_types.label as zaehlerart_label',
    )
    .orderBy('meters.id')
    .limit(seite.proSeite)
    .offset(seite.offset);

  const ids = zeilen.map((z) => z.id);
  const nachfolger = ids.length
    ? await knex('meters').select('id', 'ersetzt_meter_id').whereIn('ersetzt_meter_id', ids)
    : [];
  const nachfolgerJeAlt = new Map(nachfolger.map((n) => [n.ersetzt_meter_id, n.id]));

  const daten = zeilen.map((z) => ({
    id: z.id,
    zaehlernummer: z.number,
    aktiv: Boolean(z.active),
    zaehlerart: { id: z.zaehlerart_id, schluessel: z.zaehlerart_key, bezeichnung: z.zaehlerart_label },
    einheit: z.unit,
    hersteller: z.manufacturer,
    messbetreiber: z.messbetreiber,
    typ_bezeichnung: z.type_label,
    betreiber_typ: z.betreiber_typ,
    eich_datum: z.eich_datum,
    eich_frist: z.eich_frist,
    einbau_datum: z.einbau_datum,
    ausbau_datum: z.ausbau_datum,
    ersetzt_zaehler_id: z.ersetzt_meter_id || null,
    ersetzt_durch_zaehler_id: nachfolgerJeAlt.get(z.id) || null,
    bemerkung: z.bemerkung,
    erstellt_am: z.created_at,
    aktualisiert_am: z.updated_at,
  }));

  res.json(hUlle(daten, Number(gesamt), seite.seite, seite.proSeite));
});

// --- Messwerte (alle, keine Zeitraum-/Zaehlerarteinschraenkung) -------------
router.get('/messwerte', async (req, res) => {
  const seite = paginierung(req, res);
  if (!seite) return;

  const [{ n: gesamt }] = await knex('readings').count('id as n');
  const zeilen = await knex('readings')
    .join('meters', 'readings.meter_id', 'meters.id')
    .join('meter_types', 'readings.meter_type_id', 'meter_types.id')
    .select(
      'readings.id',
      'readings.meter_id',
      'meters.number as meter_number',
      'meter_types.key as zaehlerart_key',
      'readings.reading_at',
      'readings.value',
      'readings.unit',
      'readings.status',
      'readings.is_ausbau_reading',
      'readings.bemerkung',
      'readings.created_at',
    )
    .orderBy('readings.id')
    .limit(seite.proSeite)
    .offset(seite.offset);

  const daten = zeilen.map((r) => ({
    id: r.id,
    zaehler_id: r.meter_id,
    zaehlernummer: r.meter_number,
    zaehlerart: r.zaehlerart_key,
    datum: r.reading_at,
    wert: Number(r.value),
    einheit: r.unit,
    ablesestatus: r.status,
    ausbau_messwert: Boolean(r.is_ausbau_reading),
    bemerkung: r.bemerkung,
    erfasst_am: r.created_at,
  }));

  res.json(hUlle(daten, Number(gesamt), seite.seite, seite.proSeite));
});

module.exports = router;
