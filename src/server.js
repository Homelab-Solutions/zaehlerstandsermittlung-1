const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const KnexSessionStore = require('connect-session-knex')(session);

const config = require('./config');
const secrets = require('./lib/secrets');
const cryptoLib = require('./lib/crypto');
const knex = require('./db/knex');
const seed = require('./db/seed');
const { hashPassword } = require('./lib/auth');
const auth = require('./lib/auth');
const scheduler = require('./lib/scheduler');
const importTempStore = require('./lib/importTempStore');

for (const dir of [config.DATA_DIR, config.UPLOADS_DIR, config.TMP_UPLOADS_DIR, config.TEMPLATES_DIR, config.EXPORTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const secretValues = secrets.ensureSecrets();
cryptoLib.init(secretValues.encryptionKey);

async function bootstrapAdmin() {
  const anzahl = await knex('users').count('id as n').first();
  if (Number(anzahl.n) > 0) return;

  const passwort = config.adminBootstrap.password || secrets.generateReadablePassword();
  const hash = await hashPassword(passwort);
  await knex('users').insert({ email: config.adminBootstrap.email, password_hash: hash, role: 'admin', active: true });

  if (!config.adminBootstrap.password) {
    console.log('================================================================');
    console.log(' Erstes Admin-Konto angelegt.');
    console.log(' E-Mail:    ' + config.adminBootstrap.email);
    console.log(' Passwort:  ' + passwort);
    console.log(' Dieses Passwort wird nur EINMAL hier ausgegeben - bitte notieren');
    console.log(' und nach der ersten Anmeldung sofort aendern.');
    console.log('================================================================');
  } else {
    console.log('Erstes Admin-Konto aus ADMIN_INITIAL_PASSWORD angelegt (' + config.adminBootstrap.email + ').');
  }
}

async function main() {
  await knex.migrate.latest();
  await seed.runSeeds(knex);
  await bootstrapAdmin();

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1); // Betrieb hinter Apache/Nginx als Reverse Proxy
  // In allen Views verfuegbar: Anzeige von Messwerten (nachgestellte Null-
  // Dezimalstellen weglassen, Schaetzungen ganzzahlig) - Auftrag "Zahlen- und
  // Datumsformate".
  app.locals.formatWert = require('./lib/zahlenFormat').formatWert;
  app.locals.productName = config.PRODUCT_NAME;

  app.use(helmet({
    contentSecurityPolicy: false, // eigene, einfache Inline-Styles/Skripte ohne Build-Schritt
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(session({
    store: new KnexSessionStore({ knex, createtable: true, tablename: 'sessions' }),
    secret: secretValues.sessionSecret,
    resave: false,
    saveUninitialized: false,
    name: 'zsid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // 'secure' faellt bewusst weg, da die App im AppFactory-Testbetrieb per HTTP
      // laeuft; hinter HTTPS-Reverse-Proxy sollte dies ueber SESSION_COOKIE_SECURE
      // aktiviert werden (siehe README, Betrieb hinter Reverse Proxy).
      secure: process.env.SESSION_COOKIE_SECURE === 'true',
      // Login-Sitzung auf maximal 30 Tage begrenzt (Auftrag Abschnitt 7). Da
      // "rolling" nicht aktiviert ist, legt express-session das Ablaufdatum beim
      // Erzeugen der Session fest und verlaengert es nicht bei spaeteren Requests.
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  }));

  app.use(auth.loadUserForSession);
  app.use((req, res, next) => { res.locals.pfad = req.path; next(); });
  app.use('/vendor/chartjs', express.static(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist')));
  app.use('/static', express.static(path.join(__dirname, '..', 'public')));

  const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
  app.use('/login', loginLimiter);

  app.use('/', require('./routes/auth'));
  app.use('/', require('./routes/dashboard'));
  app.use('/', require('./routes/readings'));
  app.use('/', require('./routes/fotos'));
  app.use('/', require('./routes/meters'));
  app.use('/', require('./routes/charts'));
  app.use('/', require('./routes/importExport'));
  app.use('/', require('./routes/rechtliches'));
  app.use('/admin', require('./routes/admin'));
  app.use('/api/v1', require('./routes/apiLese'));

  app.use((req, res) => {
    res.status(404).render('fehler', { titel: 'Seite nicht gefunden', nachricht: 'Diese Seite gibt es nicht.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('Unerwarteter Fehler:', err);
    res.status(500).render('fehler', { titel: 'Fehler', nachricht: 'Es ist ein unerwarteter Fehler aufgetreten.' });
  });

  app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`Zaehlerstandsermittlung laeuft auf 0.0.0.0:${config.PORT} (DB_DRIVER=${config.DB_DRIVER})`);
  });

  scheduler.start();
  setInterval(importTempStore.aufraeumen, 30 * 60 * 1000);
}

main().catch((err) => {
  console.error('Start fehlgeschlagen:', err);
  process.exit(1);
});
