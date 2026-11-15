const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Knex = require('knex');

const config = require('../config');
const appKnex = require('../db/knex');
const daten = require('./exportImport/daten');
const envDatei = require('./envDatei');

// Reihenfolge respektiert Fremdschluessel (meters.ersetzt_meter_id ist bewusst
// ohne FK, siehe Migration "bedienung_design_funktionen"): meter_types/users/
// meter_groups zuerst (meters haengt an beiden), dann meters, dann
// readings/photos/audit_log/user_group_permissions, settings unabhaengig.
const TABELLEN = ['meter_types', 'meter_groups', 'users', 'meters', 'readings', 'photos', 'user_group_permissions', 'settings', 'audit_log'];
const TABELLEN_MIT_INCREMENT = ['meter_types', 'meter_groups', 'users', 'meters', 'readings', 'photos', 'audit_log'];

function aktuelleKonfiguration() {
  if (config.DB_DRIVER === 'mariadb') {
    return { treiber: 'mariadb', host: config.mariadb.host, port: config.mariadb.port, datenbank: config.mariadb.database, benutzer: config.mariadb.user };
  }
  return { treiber: 'sqlite', datei: config.SQLITE_FILE };
}

function baueZielKnex(ziel) {
  if (ziel.treiber === 'mariadb') {
    return Knex({
      client: 'mysql2',
      connection: {
        host: ziel.host,
        port: ziel.port,
        user: ziel.user,
        password: ziel.passwort,
        database: ziel.datenbank,
        timezone: 'Z',
        decimalNumbers: true,
      },
      pool: { min: 0, max: 2 },
      migrations: { directory: path.join(__dirname, '..', 'db', 'migrations') },
    });
  }
  return Knex({
    client: 'better-sqlite3',
    connection: { filename: config.SQLITE_FILE },
    useNullAsDefault: true,
    pool: {
      afterCreate: (conn, done) => {
        conn.pragma('journal_mode = WAL');
        conn.pragma('foreign_keys = ON');
        done();
      },
    },
    migrations: { directory: path.join(__dirname, '..', 'db', 'migrations') },
  });
}

function istIdentischMitAktiverVerbindung(ziel) {
  const aktuell = aktuelleKonfiguration();
  if (ziel.treiber !== aktuell.treiber) return false;
  if (ziel.treiber === 'sqlite') return true;
  return (
    String(ziel.host) === String(aktuell.host) &&
    Number(ziel.port) === Number(aktuell.port) &&
    String(ziel.datenbank) === String(aktuell.datenbank)
  );
}

// Prueft Erreichbarkeit UND die fuer Migration/Kopie noetigen Rechte (Tabelle
// anlegen, schreiben, loeschen) ueber eine Wegwerf-Tabelle - ohne etwas an den
// eigentlichen Anwendungstabellen zu veraendern.
async function testeZielverbindung(ziel) {
  const zielKnex = baueZielKnex(ziel);
  const testTabelle = `_db_wechsel_test_${crypto.randomBytes(4).toString('hex')}`;
  try {
    await zielKnex.raw('select 1');
    await zielKnex.schema.createTable(testTabelle, (t) => {
      t.increments('id').primary();
      t.string('wert', 20);
    });
    await zielKnex(testTabelle).insert({ wert: 'ok' });
    await zielKnex.schema.dropTableIfExists(testTabelle);
    return { ok: true };
  } catch (err) {
    try {
      await zielKnex.schema.dropTableIfExists(testTabelle);
    } catch {
      // Aufraeumen best effort - der eigentliche Fehler ist wichtiger.
    }
    return { ok: false, fehler: zielverbindungFehlertext(err) };
  } finally {
    await zielKnex.destroy();
  }
}

function zielverbindungFehlertext(err) {
  const code = err && err.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
    return 'Zielverbindung nicht erreichbar (Host/Port pruefen).';
  }
  if (code === 'ER_ACCESS_DENIED_ERROR') return 'Zugriff verweigert (Benutzername/Passwort pruefen).';
  if (code === 'ER_BAD_DB_ERROR') return 'Datenbank existiert nicht.';
  if (code === 'ER_DBACCESS_DENIED_ERROR' || code === 'ER_TABLEACCESS_DENIED_ERROR') {
    return 'Verbindung erfolgreich, aber fehlende Rechte zum Anlegen/Beschreiben von Tabellen.';
  }
  return 'Verbindung fehlgeschlagen: ' + (err && err.message ? err.message : 'unbekannter Fehler');
}

async function erzeugeBackup(benutzerId) {
  const alle = await daten.gatherAll();
  const dateiname = `db-wechsel-backup-${Date.now()}.json`;
  const pfad = path.join(config.EXPORTS_DIR, dateiname);
  fs.mkdirSync(config.EXPORTS_DIR, { recursive: true });
  fs.writeFileSync(pfad, JSON.stringify(alle, null, 2));
  return { pfad, dateiname, erzeugtVon: benutzerId, erzeugtAm: Date.now() };
}

async function migriereSchema(zielKnex) {
  await zielKnex.migrate.latest();
}

// Verweigert das Ueberschreiben einer bereits genutzten Zieldatenbank: alle
// fachlichen Tabellen muessen nach der Schema-Migration leer sein.
async function pruefeZielLeer(zielKnex) {
  const belegt = [];
  for (const tabelle of TABELLEN) {
    const [{ n }] = await zielKnex(tabelle).count('* as n');
    if (Number(n) > 0) belegt.push(tabelle);
  }
  return belegt;
}

// Liefert je Tabelle die Namen der DATETIME/TIMESTAMP-Spalten der ZIEL-Datenbank
// (Introspektion statt fester Spaltenliste, damit jede betroffene Spalte erfasst
// wird - nicht nur readings.reading_at - und kuenftige Migrationen automatisch
// mitgelten).
async function ermittleZeitspalten(zielKnex, tabelle) {
  const info = await zielKnex(tabelle).columnInfo();
  return Object.keys(info).filter((spalte) => {
    const typ = String(info[spalte] && info[spalte].type).toLowerCase();
    return typ === 'datetime' || typ === 'timestamp';
  });
}

// Interpretiert einen aus der Quelle gelesenen Zeitwert als konkreten
// UTC-Zeitpunkt. Ein Date-Objekt (so liefert mysql2 DATETIME/TIMESTAMP-Spalten)
// wird unveraendert uebernommen. Ein String ohne Zeitzonenangabe (z. B. SQLites
// "CURRENT_TIMESTAMP"-Default "2024-01-01 10:00:00") wird explizit als UTC
// gelesen statt der Prozess-Zeitzone zu folgen - sonst wuerde new Date(...)
// diesen Wert als lokale Zeit missinterpretieren. Ein String mit "Z"/Offset
// (z. B. von der App selbst per toISOString() geschrieben, siehe
// routes/readings.js) wird unveraendert geparst. Projektkonvention ist
// durchgaengig UTC (vgl. "timezone: 'Z'" in baueZielKnex/db/knex.js).
function parsiereAlsUtc(wert) {
  if (wert instanceof Date) return wert;
  let text = String(wert).trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) text += 'Z';
  return new Date(text);
}

// Wandelt einen Zeitwert in eine fuer den Ziel-Client gueltige Bindung um.
// mysql2 akzeptiert ein Date-Objekt direkt und formatiert es ueber die
// Verbindungs-Zeitzone (timezone: 'Z') korrekt als MariaDB-DATETIME-Literal
// ohne "T"/"Z" - robuster als ein von Hand gebauter SQL-String. better-sqlite3
// kann kein Date-Objekt binden; dort wird dieselbe ISO-8601-Schreibweise
// erzeugt, die die App auch sonst verwendet (toISOString()).
function normalisiereZeitwert(wert, zielClient) {
  if (wert === null || wert === undefined || wert === '') return wert;
  const datum = parsiereAlsUtc(wert);
  if (Number.isNaN(datum.getTime())) {
    throw new Error(`Zeitwert "${wert}" konnte nicht als Datum/Uhrzeit interpretiert werden.`);
  }
  return zielClient === 'mysql2' ? datum : datum.toISOString();
}

function normalisiereZeile(zeile, zeitspalten, zielClient) {
  if (zeitspalten.length === 0) return zeile;
  const kopie = { ...zeile };
  for (const spalte of zeitspalten) {
    kopie[spalte] = normalisiereZeitwert(kopie[spalte], zielClient);
  }
  return kopie;
}

async function kopiereDaten(zielKnex) {
  const zielClient = zielKnex.client.config.client;
  const zeitspaltenJeTabelle = {};
  for (const tabelle of TABELLEN) {
    zeitspaltenJeTabelle[tabelle] = await ermittleZeitspalten(zielKnex, tabelle);
  }
  await zielKnex.transaction(async (trx) => {
    for (const tabelle of TABELLEN) {
      const zeilen = await appKnex(tabelle).select('*');
      if (zeilen.length === 0) continue;
      const zeitspalten = zeitspaltenJeTabelle[tabelle];
      const zuSchreiben = zeilen.map((zeile) => normalisiereZeile(zeile, zeitspalten, zielClient));
      await zielKnex.batchInsert(tabelle, zuSchreiben, 200).transacting(trx);
    }
    for (const tabelle of TABELLEN_MIT_INCREMENT) {
      await setzeNaechsteId(trx, tabelle, zielKnex.client.config.client);
    }
  });
}

async function setzeNaechsteId(trx, tabelle, client) {
  const zeile = await trx(tabelle).max('id as maxId').first();
  const maxId = Number(zeile && zeile.maxId) || 0;
  try {
    if (client === 'mysql2') {
      if (maxId > 0) await trx.raw('ALTER TABLE ?? AUTO_INCREMENT = ?', [tabelle, maxId + 1]);
    } else {
      // better-sqlite3: nur relevant, wenn die Tabelle per AUTOINCREMENT-Schluesselwort
      // angelegt wurde (dann existiert sqlite_sequence); sonst Fehler ignorieren, da
      // SQLite ohnehin automatisch mit max(rowid)+1 fortsetzt.
      await trx.raw('UPDATE sqlite_sequence SET seq = ? WHERE name = ?', [maxId, tabelle]);
    }
  } catch {
    // Nicht kritisch: schlimmstenfalls wird beim naechsten Insert eine hoehere,
    // noch freie ID vergeben statt der direkt folgenden.
  }
}

async function verifiziere(zielKnex) {
  const ergebnisse = [];
  let alleOk = true;
  for (const tabelle of TABELLEN) {
    const [{ n: quelle }] = await appKnex(tabelle).count('* as n');
    const [{ n: ziel }] = await zielKnex(tabelle).count('* as n');
    const ok = Number(quelle) === Number(ziel);
    if (!ok) alleOk = false;
    ergebnisse.push({ tabelle, quelle: Number(quelle), ziel: Number(ziel), ok });
  }
  return { ok: alleOk, ergebnisse };
}

function schreibeZielInEnv(ziel) {
  const updates = { DB_DRIVER: ziel.treiber };
  if (ziel.treiber === 'mariadb') {
    Object.assign(updates, {
      DB_HOST: ziel.host,
      DB_PORT: String(ziel.port),
      DB_USER: ziel.user,
      DB_PASSWORD: ziel.passwort,
      DB_NAME: ziel.datenbank,
    });
  }
  envDatei.updateEnvFile(config.ENV_DATEI, updates);
}

// Entfernt die lokale SQLite-Datei, NACHDEM aktiv auf MariaDB umgeschaltet und
// das neu gestartet wurde (config.DB_DRIVER spiegelt dann bereits den
// tatsaechlich laufenden Treiber wider). Quelle wird nie automatisch geloescht -
// dies ist eine separate, vom Admin ausdruecklich bestaetigte Aktion.
function entferneAlteSqliteDatei() {
  if (config.DB_DRIVER !== 'mariadb') {
    throw new Error('Die lokale SQLite-Datei kann nur entfernt werden, wenn aktuell MariaDB aktiv ist.');
  }
  if (!fs.existsSync(config.SQLITE_FILE)) {
    throw new Error('Keine lokale SQLite-Datei gefunden.');
  }
  for (const suffix of ['', '-shm', '-wal']) {
    const p = config.SQLITE_FILE + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

module.exports = {
  TABELLEN,
  TABELLEN_MIT_INCREMENT,
  aktuelleKonfiguration,
  baueZielKnex,
  istIdentischMitAktiverVerbindung,
  testeZielverbindung,
  erzeugeBackup,
  migriereSchema,
  pruefeZielLeer,
  kopiereDaten,
  setzeNaechsteId,
  verifiziere,
  schreibeZielInEnv,
  entferneAlteSqliteDatei,
};
