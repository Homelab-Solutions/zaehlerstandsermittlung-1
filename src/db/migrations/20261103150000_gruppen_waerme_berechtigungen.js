// Migration zum Auftrag "Zaehlergruppen und Berechtigungen / Waermemengenzaehler":
// - Admin-verwaltete Zaehlergruppen (z. B. "Haupthaus", "Mietwohnung"), jedem
//   Zaehler zugeordnet, plus frei eingebbarer Anzeige-Bezeichnung je Zaehler
//   (Abschnitt "Zaehlergruppen und Berechtigungen").
// - Pro Benutzer einstellbare Gruppenrechte NUR fuer die Messwerterfassung.
// - Waermemengenzaehler-Faehigkeit je Zaehlerart (gemeinsame kWh+m³-Erfassung,
//   Abschnitt "Messwerterfassung") sowie das zugehoerige Unterscheidungsfeld bei
//   den Messwerten (analog zu readings.strom_richtung, bewusst ein eigenes Feld,
//   um die bestehende Stromrichtung-Logik nicht anzufassen).
exports.up = async function up(knex) {
  await knex.schema.createTable('meter_groups', (t) => {
    t.increments('id').primary();
    t.string('name', 120).notNullable().unique();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('user_group_permissions', (t) => {
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('group_id').unsigned().notNullable().references('id').inTable('meter_groups').onDelete('CASCADE');
    t.primary(['user_id', 'group_id']);
  });

  // Kein DB-seitiger FOREIGN-KEY-Verweis auf meter_groups: Ein inline .references()
  // in einem alterTable() zwingt knex bei SQLite zu einer Tabellen-Neuerstellung
  // (CREATE temp + COPY + DROP meters + RENAME); das DROP TABLE "meters" scheitert
  // dabei an "FOREIGN KEY constraint failed", weil readings/photos bereits per
  // Fremdschluessel auf meters verweisen und PRAGMA foreign_keys=ON ist (src/db/knex.js).
  // meter_groups sind ohnehin nie loeschbar (nur deaktivierbar, siehe routes/admin.js),
  // die Gueltigkeit von group_id wird beim Anlegen/Aendern eines Zaehlers bereits in
  // routes/meters.js geprueft - ein DB-FK ist hier nicht noetig.
  await knex.schema.alterTable('meters', (t) => {
    t.integer('group_id').unsigned();
    // Frei eingebbare Anzeige-Bezeichnung (z. B. "Kaltwasser"), ergaenzt/ersetzt
    // die Zaehlerart-Beschriftung in Dashboard/Listen ("Gruppe - Bezeichnung").
    t.string('anzeige_bezeichnung', 120);
  });

  await knex.schema.alterTable('meter_types', (t) => {
    // Nur bei Anlage einer Zaehlerart setzbar (wie "unit"), da bestehende
    // Messwerte an der Struktur (ein oder zwei Werte je Ablesung) haengen.
    t.boolean('waerme_kombi').notNullable().defaultTo(false);
  });

  await knex.schema.alterTable('readings', (t) => {
    // NULL ausser bei Zaehlerarten mit waerme_kombi=true: 'kwh' oder 'm3'.
    t.string('waerme_teil', 20);
  });

  // Bestandsdaten (nur relevant, wenn in dieser Datenbank bereits Zaehler
  // existieren - bei einer frisch migrierten/leeren Zieldatenbank eines
  // Datenbankwechsels bleibt meter_groups bewusst leer, siehe dbWechsel.js
  // pruefeZielLeer): bestehende Zaehler werden anhand des technischen
  // Zaehlerart-Schluessels (enthaelt "mietwohnung" oder nicht) einer der
  // beiden im Auftrag genannten Standardgruppen zugeordnet. Die Gruppen
  // werden nur angelegt, wenn tatsaechlich Zaehler zuzuordnen sind - seed.js
  // legt sie andernfalls beim naechsten Start fuer neue Installationen an.
  const meterCount = await knex('meters').count('id as n').first();
  if (Number(meterCount.n) > 0) {
    const [haupthausId] = await knex('meter_groups').insert({ name: 'Haupthaus', sort_order: 0, active: true });
    const [mietwohnungId] = await knex('meter_groups').insert({ name: 'Mietwohnung', sort_order: 1, active: true });

    const mietwohnungTypIds = await knex('meter_types').where('key', 'like', '%mietwohnung%').pluck('id');
    if (mietwohnungTypIds.length > 0) {
      await knex('meters').whereIn('meter_type_id', mietwohnungTypIds).update({ group_id: mietwohnungId });
    }
    await knex('meters').whereNull('group_id').update({ group_id: haupthausId });
  }
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('readings', (t) => {
    t.dropColumn('waerme_teil');
  });
  await knex.schema.alterTable('meter_types', (t) => {
    t.dropColumn('waerme_kombi');
  });
  await knex.schema.alterTable('meters', (t) => {
    t.dropColumn('anzeige_bezeichnung');
    t.dropColumn('group_id');
  });
  await knex.schema.dropTableIfExists('user_group_permissions');
  await knex.schema.dropTableIfExists('meter_groups');
};
