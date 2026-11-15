// Migration zum Auftrag "Import/Export, Messwerte, Korrekturen, Formate":
// Neue, eigenstaendige Tabelle fuer den Freigabeprozess von Benutzer-
// Korrektureintraegen (Abschnitt 3) - bewusst eine CREATE-TABLE-Operation
// (kein alterTable auf eine bestehende, bereits referenzierte Tabelle), damit
// SQLite keine Tabellen-Neuerstellung von "readings" ausloest (siehe bekannte
// Falle bei fruehren Migrationen: alterTable + inline .references() auf eine
// bereits von anderen Tabellen per FK referenzierte Tabelle bricht den Start).
exports.up = async function up(knex) {
  await knex.schema.createTable('reading_corrections', (t) => {
    t.increments('id').primary();
    t.integer('reading_id').unsigned().notNullable()
      .references('id').inTable('readings').onDelete('CASCADE');
    t.decimal('vorgeschlagener_wert', 14, 3).notNullable();
    // NULL = nur der Wert soll korrigiert werden, Datum bleibt unveraendert.
    t.timestamp('vorgeschlagenes_datum');
    t.text('bemerkung').notNullable();
    t.string('status', 20).notNullable().defaultTo('offen'); // 'offen' | 'genehmigt' | 'abgelehnt'
    t.integer('erstellt_von').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('erstellt_am').defaultTo(knex.fn.now());
    t.integer('bearbeitet_von').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('bearbeitet_am');
    t.text('admin_kommentar');
    t.index(['status']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('reading_corrections');
};
