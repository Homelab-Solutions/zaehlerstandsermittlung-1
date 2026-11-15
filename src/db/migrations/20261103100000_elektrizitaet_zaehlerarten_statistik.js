// Migration zum Auftrag "Stromzaehler/Zaehlerarten-Verwaltung/Dashboard/Navigation":
// - Zaehlerarten bekommen administrierbare Vorgaben ("Vom Versorger betrieben",
//   "Eichdaten anzeigen"), die pro Zaehler ueberschreibbar sind (Abschnitt 2).
// - readings bekommen ein Feld fuer die Stromrichtung (Verbrauch/Einspeisung),
//   damit ein Stromzaehler beide OBIS-Werte (1.8.0/2.8.0) zum selben Ablesedatum
//   eindeutig getrennt speichern kann (Abschnitt 1).
exports.up = async function up(knex) {
  await knex.schema.alterTable('meter_types', (t) => {
    t.boolean('betreiber_versorger_standard').notNullable().defaultTo(false);
    t.boolean('eichdaten_anzeigen_standard').notNullable().defaultTo(true);
  });

  await knex.schema.alterTable('meters', (t) => {
    // NULL = Vorgabe der Zaehlerart (eichdaten_anzeigen_standard) verwenden;
    // true/false = expliziter Override fuer genau diesen Zaehler.
    t.boolean('eichdaten_anzeigen');
  });

  await knex.schema.alterTable('readings', (t) => {
    // NULL fuer alle nicht-elektrischen Zaehlerarten (unveraendertes Verhalten);
    // 'verbrauch'/'einspeisung' nur fuer Stromzaehler (OBIS 1.8.0 bzw. 2.8.0).
    t.string('strom_richtung', 20);
  });

  // Bestandsdaten: bisherige Messwerte von Stromzaehlern waren ausschliesslich
  // Verbrauchswerte (es gab noch kein Einspeisungsfeld) - werden entsprechend
  // nachgetragen, damit sie von der neuen, nach Richtung filternden Auswertung
  // weiterhin gefunden werden.
  const stromTypIds = await knex('meter_types')
    .where({ unit: 'kWh' })
    .andWhere('key', 'like', '%strom%')
    .pluck('id');
  if (stromTypIds.length > 0) {
    await knex('readings').whereIn('meter_type_id', stromTypIds).update({ strom_richtung: 'verbrauch' });
  }
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('readings', (t) => {
    t.dropColumn('strom_richtung');
  });
  await knex.schema.alterTable('meters', (t) => {
    t.dropColumn('eichdaten_anzeigen');
  });
  await knex.schema.alterTable('meter_types', (t) => {
    t.dropColumn('eichdaten_anzeigen_standard');
    t.dropColumn('betreiber_versorger_standard');
  });
};
