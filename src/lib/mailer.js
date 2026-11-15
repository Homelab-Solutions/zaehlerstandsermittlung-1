const nodemailer = require('nodemailer');
const settings = require('./settings');
const config = require('../config');

function buildTransport(cfg) {
  const secure = cfg.secureMode === 'tls'; // implizites TLS (meist Port 465)
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure,
    requireTLS: cfg.secureMode === 'starttls',
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    connectionTimeout: 10000,
  });
}

// Mailfehler duerfen die App nie blockieren: Fehler werden abgefangen und
// als {ok:false, fehler} zurueckgegeben, nie geworfen.
async function sendMail({ to, subject, text, html }) {
  const cfg = await settings.getSmtpConfig();
  if (!cfg.enabled || !cfg.host || !cfg.from) {
    return { ok: false, fehler: 'SMTP ist nicht konfiguriert oder deaktiviert.' };
  }
  try {
    const transport = buildTransport(cfg);
    await transport.sendMail({ from: cfg.from, to, subject, text, html });
    return { ok: true };
  } catch (err) {
    console.error('SMTP-Versand fehlgeschlagen:', err.message);
    return { ok: false, fehler: 'Versand fehlgeschlagen: ' + err.message };
  }
}

async function sendTestMail(to) {
  return sendMail({
    to,
    subject: `[${config.PRODUCT_NAME}] Test-E-Mail`,
    text: `Dies ist eine Test-E-Mail der ${config.PRODUCT_NAME}-App. Die SMTP-Konfiguration funktioniert.`,
  });
}

// Benachrichtigung bei JEDER neu angelegten (manuellen) Messwerterfassung
// (Auftrag Abschnitt 5) - bewusst NICHT bei Korrekturen/Bearbeitungen/Löschungen
// oder Importen ausgeloest (siehe routes/readings.js, Aufrufstelle). Ein Aufruf
// deckt eine komplette Erfassung ab (ggf. mehrere Teilwerte wie Verbrauch +
// Einspeisung bzw. kWh + m³ zum selben Ablesedatum) - eine E-Mail pro
// Erfassungsvorgang statt pro gespeicherter Zeile. Mailfehler werden hier nie
// geworfen (sendMail faengt sie bereits ab); der Aufrufer wartet bewusst nicht
// auf das Ergebnis (fire-and-forget), damit ein SMTP-Problem die Erfassung
// selbst nie verzoegert oder rueckgaengig macht.
async function sendNeueMesswerteBenachrichtigung({ empfaenger, zaehlerName, zaehlerNummer, datum, zeilen, bemerkung }) {
  const zeilenText = zeilen.map((z) => `- ${z.label}: ${z.wert} ${z.einheit}`).join('\n');
  const text = [
    `Neuer Messwert erfasst für: ${zaehlerName} (Zähler ${zaehlerNummer})`,
    `Ablesedatum: ${datum}`,
    '',
    zeilenText,
    bemerkung ? `\nBemerkung: ${bemerkung}` : '',
  ].join('\n');

  for (const to of empfaenger) {
    const ergebnis = await sendMail({ to, subject: `[${config.PRODUCT_NAME}] Neuer Messwert erfasst`, text });
    if (!ergebnis.ok) {
      console.error('Benachrichtigung bei neuem Messwert fehlgeschlagen:', ergebnis.fehler);
    }
  }
}

module.exports = { sendMail, sendTestMail, sendNeueMesswerteBenachrichtigung };
