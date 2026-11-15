// Migration zum Auftrag "Bedienung, Design und Funktionen verbessern":
// - betrieben/gewartet durch (Eigentuemer/Energieversorger) je Zaehler, inkl.
//   Opt-in/Opt-out fuer Eichfrist-Benachrichtigungen je Zaehler (Abschnitt 5).
// - optionale Verknuepfung "ersetzt Zaehler X" fuer einen beim Anlegen markierten
//   Zaehlerwechsel (Abschnitt 5). Bewusst ohne DB-Fremdschluessel (nur Komfortfeld),
//   um ALTER TABLE unter SQLite robust zu halten.
exports.up = async function up(knex) {
  await knex.schema.alterTable('meters', (t) => {
    t.string('betreiber_typ', 20).notNullable().defaultTo('eigentuemer'); // 'eigentuemer' | 'energieversorger'
    t.boolean('eichfrist_benachrichtigen').notNullable().defaultTo(true);
    t.integer('ersetzt_meter_id').unsigned();
  });

  // Bestandsdaten: ein bereits eingetragener Messbetreiber deutet auf einen
  // Energieversorger-Zaehler hin - fuer diese wird die Eichfrist-Benachrichtigung
  // an den Eigentuemer standardmaessig abgeschaltet (Nutzervorgabe). Neue Zaehler
  // ohne Messbetreiber bleiben beim Standard "Eigentuemer" mit Benachrichtigung an.
  await knex('meters')
    .whereNotNull('messbetreiber')
    .andWhere('messbetreiber', '<>', '')
    .update({ betreiber_typ: 'energieversorger', eichfrist_benachrichtigen: false });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('meters', (t) => {
    t.dropColumn('ersetzt_meter_id');
    t.dropColumn('eichfrist_benachrichtigen');
    t.dropColumn('betreiber_typ');
  });
};
