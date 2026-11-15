const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const unzipper = require('unzipper');

const knex = require('../db/knex');
const config = require('../config');
const dbWechsel = require('./dbWechsel');
const secrets = require('./secrets');

// Vollstaendiges, technisches Backup/Restore (Auftrag "Vollstaendiges Backup und
// Wiederherstellung") - bewusst getrennt vom fachlichen JSON-Export
// (exportImport/daten.js), der absichtlich Passwort-Hashes und Geheimnisse
// weglaesst. Dieses Backup soll eine vollstaendige Wiederherstellung auf einem
// neu aufgesetzten Server ermoeglichen und enthaelt daher ALLE Tabellenspalten
// (inkl. Passwort-Hashes, verschluesselter SMTP-/KI-Zugangsdaten und dem
// Hash des Lese-API-Schluessels) sowie hochgeladene Fotos, die Excel-Vorlage
// und secrets.json (SESSION_SECRET/ENCRYPTION_KEY) - ohne die passenden
// secrets.json bleiben die verschluesselten Settings nach einer Wiederher-
// stellung auf einem anderen Schluessel dauerhaft unentschluesselbar.
// .env/DB_PASSWORD sind bewusst NICHT enthalten (Konvention: Zugangsdaten zur
// Datenbank gehoeren ausschliesslich in die .env und werden nie exportiert).
const FORMAT = 'zaehlerstandsermittlung-vollbackup';
const FORMAT_VERSION = 1;
const STAGING_DIR = path.join(config.DATA_DIR, 'restore-staging');
const LOESCH_REIHENFOLGE = [...dbWechsel.TABELLEN].reverse();

function sichererZielpfad(basisDir, relPfad) {
  const ziel = path.resolve(path.join(basisDir, relPfad));
  const basis = path.resolve(basisDir);
  if (ziel !== basis && !ziel.startsWith(basis + path.sep)) {
    throw new Error('Ungueltiger Pfad in der Backup-Datei.');
  }
  return ziel;
}

function schreibeEintragAlsDatei(entry, zielPfad, mode) {
  fs.mkdirSync(path.dirname(zielPfad), { recursive: true });
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(zielPfad, mode ? { mode } : undefined);
    entry.stream().pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

function fuegeVerzeichnisHinzu(archive, absDir, zielPrefix, ausschlussNamen) {
  if (!fs.existsSync(absDir)) return;
  for (const eintrag of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (ausschlussNamen.includes(eintrag.name)) continue;
    const absPfad = path.join(absDir, eintrag.name);
    if (eintrag.isDirectory()) {
      fuegeVerzeichnisHinzu(archive, absPfad, `${zielPrefix}/${eintrag.name}`, []);
    } else if (eintrag.isFile()) {
      archive.file(absPfad, { name: `${zielPrefix}/${eintrag.name}` });
    }
  }
}

// Erzeugt ein vollstaendiges Backup als ZIP unter data/exports/ (Modus 600 -
// enthaelt hochvertrauliche Daten) und gibt dessen Pfad sowie Kennzahlen
// zurueck. Wird sowohl fuer den regulaeren Download als auch als erzwungene
// Sicherheitskopie vor einer Wiederherstellung verwendet.
async function erzeugeVollbackup() {
  fs.mkdirSync(config.EXPORTS_DIR, { recursive: true });
  const dateiname = `vollbackup-${Date.now()}.zip`;
  const pfad = path.join(config.EXPORTS_DIR, dateiname);

  const tabellenZeilen = {};
  for (const tabelle of dbWechsel.TABELLEN) {
    tabellenZeilen[tabelle] = await knex(tabelle).select('*');
  }
  const tabellenZahlen = Object.fromEntries(Object.entries(tabellenZeilen).map(([t, z]) => [t, z.length]));

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(pfad, { mode: 0o600 });
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });
    archive.pipe(output);

    for (const [tabelle, zeilen] of Object.entries(tabellenZeilen)) {
      archive.append(JSON.stringify(zeilen), { name: `db/${tabelle}.json` });
    }
    const manifest = {
      format: FORMAT,
      version: FORMAT_VERSION,
      erzeugt_am: new Date().toISOString(),
      db_treiber: config.DB_DRIVER,
      tabellen: tabellenZahlen,
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    fuegeVerzeichnisHinzu(archive, config.UPLOADS_DIR, 'uploads', ['tmp']);
    fuegeVerzeichnisHinzu(archive, config.TEMPLATES_DIR, 'vorlagen', []);
    if (fs.existsSync(secrets.SECRETS_FILE)) {
      archive.file(secrets.SECRETS_FILE, { name: 'secrets.json' });
    }

    archive.finalize();
  });
  fs.chmodSync(pfad, 0o600);

  return { pfad, dateiname, erzeugtAm: Date.now(), tabellen: tabellenZahlen };
}

// Liest eine hochgeladene Backup-ZIP-Datei (Buffer), prueft Format/Version und
// Vollstaendigkeit und legt die enthaltenen Dateien in einem eigenen
// Staging-Verzeichnis ab, OHNE bereits etwas an echten Daten zu veraendern.
// Gibt eine Vorschau (Zeilenzahlen je Tabelle, Anzahl Dateien) zurueck.
async function bereiteRestoreVor(zipBuffer) {
  let directory;
  try {
    directory = await unzipper.Open.buffer(zipBuffer);
  } catch (err) {
    throw new Error('Datei konnte nicht als ZIP gelesen werden: ' + err.message);
  }
  const dateien = new Map(directory.files.filter((f) => f.type === 'File').map((f) => [f.path, f]));

  const manifestDatei = dateien.get('manifest.json');
  if (!manifestDatei) throw new Error('Ungueltige Backup-Datei: manifest.json fehlt.');
  let manifest;
  try {
    manifest = JSON.parse((await manifestDatei.buffer()).toString('utf8'));
  } catch {
    throw new Error('manifest.json ist kein gueltiges JSON.');
  }
  if (manifest.format !== FORMAT) throw new Error('Keine gueltige Vollbackup-Datei dieser Anwendung.');
  if (manifest.version !== FORMAT_VERSION) throw new Error(`Nicht unterstuetzte Backup-Version (${manifest.version}).`);

  const tabellenZeilen = {};
  for (const tabelle of dbWechsel.TABELLEN) {
    const eintrag = dateien.get(`db/${tabelle}.json`);
    if (!eintrag) throw new Error(`Backup unvollstaendig: Tabelle "${tabelle}" fehlt.`);
    try {
      tabellenZeilen[tabelle] = JSON.parse((await eintrag.buffer()).toString('utf8'));
    } catch {
      throw new Error(`Backup fehlerhaft: db/${tabelle}.json ist kein gueltiges JSON.`);
    }
    if (!Array.isArray(tabellenZeilen[tabelle])) throw new Error(`Backup fehlerhaft: db/${tabelle}.json enthaelt keine Liste.`);
  }

  const token = crypto.randomUUID();
  const stagingDir = path.join(STAGING_DIR, token);
  const uploadsStaging = path.join(stagingDir, 'uploads');
  const vorlagenStaging = path.join(stagingDir, 'vorlagen');
  fs.mkdirSync(uploadsStaging, { recursive: true });
  fs.mkdirSync(vorlagenStaging, { recursive: true });

  let anzahlUploadDateien = 0;
  let hatVorlagen = false;
  let hatSecrets = false;

  for (const datei of directory.files) {
    if (datei.type !== 'File') continue;
    if (datei.path.startsWith('uploads/')) {
      const rel = datei.path.slice('uploads/'.length);
      if (!rel) continue;
      const ziel = sichererZielpfad(uploadsStaging, rel);
      await schreibeEintragAlsDatei(datei, ziel);
      anzahlUploadDateien++;
    } else if (datei.path.startsWith('vorlagen/')) {
      const rel = datei.path.slice('vorlagen/'.length);
      if (!rel) continue;
      const ziel = sichererZielpfad(vorlagenStaging, rel);
      await schreibeEintragAlsDatei(datei, ziel);
      hatVorlagen = true;
    } else if (datei.path === 'secrets.json') {
      await schreibeEintragAlsDatei(datei, path.join(stagingDir, 'secrets.json'), 0o600);
      hatSecrets = true;
    }
  }

  fs.writeFileSync(path.join(stagingDir, 'db-daten.json'), JSON.stringify(tabellenZeilen));

  return {
    token,
    stagingDir,
    manifest,
    tabellen: Object.fromEntries(Object.entries(tabellenZeilen).map(([t, z]) => [t, z.length])),
    anzahlUploadDateien,
    hatVorlagen,
    hatSecrets,
  };
}

// Ersetzt ein Verzeichnis durch den Inhalt von quelleDir, nachdem das bisherige
// Verzeichnis (falls vorhanden) zur Sicherheit umbenannt statt geloescht wurde.
// Schlaegt das Kopieren fehl, wird die Sicherung automatisch zurueckgetauscht
// (Rollback) - das urspruengliche Verzeichnis bleibt dann unveraendert
// erhalten. Die Sicherung selbst wird NIE automatisch geloescht.
function ersetzeVerzeichnisMitSicherung(quelleDir, zielDir) {
  const vorherVorhanden = fs.existsSync(zielDir);
  const sicherung = vorherVorhanden ? `${zielDir}.vor-restore-${Date.now()}` : null;
  if (sicherung) fs.renameSync(zielDir, sicherung);
  try {
    fs.mkdirSync(zielDir, { recursive: true });
    if (fs.existsSync(quelleDir)) {
      fs.cpSync(quelleDir, zielDir, { recursive: true });
    }
    return sicherung ? path.basename(sicherung) : null;
  } catch (err) {
    fs.rmSync(zielDir, { recursive: true, force: true });
    if (sicherung) fs.renameSync(sicherung, zielDir);
    throw err;
  }
}

// Wendet eine zuvor mit bereiteRestoreVor() vorbereitete Wiederherstellung an:
// 1) alle fachlichen Tabellen werden in einer Transaktion vollstaendig durch
//    den Inhalt des Backups ersetzt (automatisches Rollback bei Fehlern -
//    siehe Loeschreihenfolge unten fuer Fremdschluessel-Vertraeglichkeit),
// 2) ERST danach (nur bei erfolgreichem Commit) werden Uploads/Vorlagen/
//    secrets.json ersetzt, jeweils mit Sicherung des bisherigen Standes.
// audit.log() wird bewusst NICHT hier, sondern erst vom Aufrufer NACH dieser
// Funktion aufgerufen (laeuft sonst in den Transaktions-Pool-Timeout).
async function wendeRestoreAn(stagingDir) {
  const dbDatenPfad = path.join(stagingDir, 'db-daten.json');
  if (!fs.existsSync(dbDatenPfad)) throw new Error('Wiederherstellungsdaten nicht mehr vorhanden - bitte die Backup-Datei erneut hochladen.');
  const tabellenZeilen = JSON.parse(fs.readFileSync(dbDatenPfad, 'utf8'));

  await knex.transaction(async (trx) => {
    for (const tabelle of LOESCH_REIHENFOLGE) {
      await trx(tabelle).del();
    }
    for (const tabelle of dbWechsel.TABELLEN) {
      const zeilen = tabellenZeilen[tabelle] || [];
      if (zeilen.length === 0) continue;
      await knex.batchInsert(tabelle, zeilen, 200).transacting(trx);
    }
    for (const tabelle of dbWechsel.TABELLEN_MIT_INCREMENT) {
      await dbWechsel.setzeNaechsteId(trx, tabelle, trx.client.config.client);
    }
  });

  // Ab hier ist die Datenbank bereits erfolgreich committed - ein Fehler in
  // diesem Abschnitt kann die DB nicht mehr automatisch zurueckrollen; der
  // Aufrufer wird darueber per err.dbCommitted unterschieden informiert.
  const ergebnis = {
    tabellen: Object.fromEntries(Object.entries(tabellenZeilen).map(([t, z]) => [t, (z || []).length])),
  };

  try {
    ergebnis.uploadsSicherung = ersetzeVerzeichnisMitSicherung(path.join(stagingDir, 'uploads'), config.UPLOADS_DIR);
    fs.mkdirSync(config.TMP_UPLOADS_DIR, { recursive: true });
    ergebnis.vorlagenSicherung = ersetzeVerzeichnisMitSicherung(path.join(stagingDir, 'vorlagen'), config.TEMPLATES_DIR);

    const stagedSecrets = path.join(stagingDir, 'secrets.json');
    if (fs.existsSync(stagedSecrets)) {
      if (fs.existsSync(secrets.SECRETS_FILE)) {
        fs.copyFileSync(secrets.SECRETS_FILE, secrets.SECRETS_FILE + `.vor-restore-${Date.now()}`);
      }
      fs.copyFileSync(stagedSecrets, secrets.SECRETS_FILE);
      fs.chmodSync(secrets.SECRETS_FILE, 0o600);
      ergebnis.secretsWiederhergestellt = true;
    } else {
      ergebnis.secretsWiederhergestellt = false;
    }
  } catch (err) {
    err.dbCommitted = true;
    throw err;
  }

  fs.rmSync(stagingDir, { recursive: true, force: true });
  return ergebnis;
}

// Entfernt ein vorbereitetes, aber nicht angewendetes Staging-Verzeichnis
// (z. B. nach fehlgeschlagener/abgebrochener Vorschau).
function verwerfeVorbereitung(stagingDir) {
  if (stagingDir && stagingDir.startsWith(STAGING_DIR + path.sep)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  erzeugeVollbackup,
  bereiteRestoreVor,
  wendeRestoreAn,
  verwerfeVorbereitung,
};
