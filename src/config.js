require('dotenv').config();
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const TMP_UPLOADS_DIR = path.join(UPLOADS_DIR, 'tmp');
const TEMPLATES_DIR = path.join(DATA_DIR, 'vorlagen');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');

function argvValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const PORT = Number(argvValue('--port') || process.env.PORT || 3008);
const DB_DRIVER = (process.env.DB_DRIVER || 'sqlite').trim();
// Vorlaeufiger, konfigurierbarer Produktname fuer die Anzeige (Titel, Kopfzeile,
// E-Mail-Betreffs) - rein kosmetisch. Der technische Projekt-Slug
// "zaehlerstandsermittlung-1" (Ordner, Compose, Datenbankname) bleibt davon
// unberuehrt (Auftrag Abschnitt 6: keine Namensverfuegbarkeit geprueft).
const PRODUCT_NAME = (process.env.PRODUCT_NAME || 'Zählwerk').trim();

module.exports = {
  PORT,
  DB_DRIVER,
  PRODUCT_NAME,
  PROJECT_ROOT,
  ENV_DATEI: path.join(PROJECT_ROOT, '.env'),
  DATA_DIR,
  UPLOADS_DIR,
  TMP_UPLOADS_DIR,
  TEMPLATES_DIR,
  EXPORTS_DIR,
  SQLITE_FILE: path.join(DATA_DIR, 'db.sqlite'),
  mariadb: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'appfactory_admin',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'zaehlerstandsermittlung-1_db',
  },
  adminBootstrap: {
    email: (process.env.ADMIN_INITIAL_EMAIL || 'admin@local').trim(),
    password: process.env.ADMIN_INITIAL_PASSWORD || '',
  },
  sessionSecretEnv: process.env.SESSION_SECRET || '',
  encryptionKeyEnv: process.env.ENCRYPTION_KEY || '',
};
