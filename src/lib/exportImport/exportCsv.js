const { stringify } = require('csv-stringify/sync');
const knex = require('../../db/knex');

// Keine Uhrzeit-Spalte, "Messart" fuer Strom-/Waerme-Teilwerte - siehe exportXlsx.js.
const SPALTEN = ['Zählernummer', 'Zählerart', 'Datum', 'Wert', 'Einheit', 'Messart', 'Status', 'Bemerkung'];

async function readingsAlsCsv() {
  const rows = await knex('readings')
    .join('meters', 'readings.meter_id', 'meters.id')
    .join('meter_types', 'readings.meter_type_id', 'meter_types.id')
    .select(
      'meters.number as zaehlernummer',
      'meter_types.label as zaehlerart',
      'readings.reading_at',
      'readings.value',
      'readings.unit',
      'readings.status',
      'readings.strom_richtung',
      'readings.waerme_teil',
      'readings.bemerkung'
    )
    .orderBy('readings.reading_at');

  const data = rows.map((r) => {
    const dt = new Date(r.reading_at);
    return [
      r.zaehlernummer,
      r.zaehlerart,
      dt.toISOString().slice(0, 10),
      r.value,
      r.unit,
      r.strom_richtung || r.waerme_teil || '',
      r.status,
      r.bemerkung || '',
    ];
  });

  return stringify([SPALTEN, ...data], { delimiter: ';' });
}

module.exports = { readingsAlsCsv, SPALTEN };
