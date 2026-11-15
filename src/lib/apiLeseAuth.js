const crypto = require('crypto');
const settings = require('./settings');
const audit = require('./audit');

const SPERRE_MAX_VERSUCHE = 10;
const SPERRE_FENSTER_MS = 15 * 60 * 1000;
const fehlversuche = new Map(); // ip -> { anzahl, erstesMal }

function generiereSchluessel() {
  return 'zs_' + crypto.randomBytes(32).toString('base64url');
}

function hasheSchluessel(schluessel) {
  return crypto.createHash('sha256').update(schluessel, 'utf8').digest('hex');
}

function istGesperrt(ip) {
  const eintrag = fehlversuche.get(ip);
  if (!eintrag) return false;
  if (Date.now() - eintrag.erstesMal > SPERRE_FENSTER_MS) {
    fehlversuche.delete(ip);
    return false;
  }
  return eintrag.anzahl >= SPERRE_MAX_VERSUCHE;
}

function vermerkeFehlversuch(ip) {
  const eintrag = fehlversuche.get(ip);
  if (!eintrag || Date.now() - eintrag.erstesMal > SPERRE_FENSTER_MS) {
    fehlversuche.set(ip, { anzahl: 1, erstesMal: Date.now() });
  } else {
    eintrag.anzahl += 1;
  }
}

function setzeFehlversucheZurueck(ip) {
  fehlversuche.delete(ip);
}

function vergleicheSicher(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) {
    // Dummy-Vergleich gleicher Laenge, damit die Antwortzeit bei falscher
    // Laenge nicht zusaetzlich Information preisgibt.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Middleware fuer die externe Lese-API (Abschnitt 1 des Auftrags): eigenstaendige
// Authentifizierung ueber einen vom Admin verwalteten Schluessel, unabhaengig von
// der Session-Anmeldung der Web-Oberflaeche.
async function requireApiKey(req, res, next) {
  try {
    const httpsPflicht = process.env.API_REQUIRE_HTTPS !== 'false';
    if (httpsPflicht && !req.secure) {
      return res.status(400).json({ error: 'HTTPS erforderlich. Im reinen Testbetrieb kann dies ueber API_REQUIRE_HTTPS=false in der .env vorruebergehend abgeschaltet werden.' });
    }

    const aktiviert = (await settings.get('api_lese_enabled')) === 'true';
    if (!aktiviert) {
      return res.status(503).json({ error: 'Die externe Lese-API ist deaktiviert.' });
    }

    const ip = req.ip || 'unbekannt';
    if (istGesperrt(ip)) {
      res.set('Retry-After', String(Math.ceil(SPERRE_FENSTER_MS / 1000)));
      return res.status(429).json({ error: 'Zu viele fehlgeschlagene Versuche. Bitte spaeter erneut versuchen.' });
    }

    const header = req.get('authorization') || '';
    const treffer = header.match(/^Bearer\s+(.+)$/i);
    const gespeicherterHash = await settings.get('api_lese_key_hash');

    if (!treffer || !gespeicherterHash) {
      vermerkeFehlversuch(ip);
      await audit.log(null, 'api_lese_fehlgeschlagen', { ip, grund: !treffer ? 'kein_schluessel_uebergeben' : 'kein_schluessel_konfiguriert' });
      return res.status(401).json({ error: 'Nicht autorisiert.' });
    }

    const praesentierterHash = hasheSchluessel(treffer[1]);
    if (!vergleicheSicher(praesentierterHash, gespeicherterHash)) {
      vermerkeFehlversuch(ip);
      await audit.log(null, 'api_lese_fehlgeschlagen', { ip, grund: 'schluessel_ungueltig' });
      return res.status(401).json({ error: 'Nicht autorisiert.' });
    }

    setzeFehlversucheZurueck(ip);
    settings.set('api_lese_key_last_used_at', new Date().toISOString()).catch(() => {});
    audit.log(null, 'api_lese_zugriff', { ip, pfad: req.path }).catch(() => {});
    next();
  } catch (err) {
    console.error('Fehler in apiLeseAuth.js:', err.message);
    res.status(500).json({ error: 'Interner Fehler.' });
  }
}

module.exports = { generiereSchluessel, hasheSchluessel, requireApiKey };
