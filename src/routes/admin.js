const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const knex = require('../db/knex');
const config = require('../config');
const { requireAuth, requireAdmin, hashPassword } = require('../lib/auth');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const cryptoLib = require('../lib/crypto');
const mailer = require('../lib/mailer');
const daten = require('../lib/exportImport/daten');
const apiLeseAuth = require('../lib/apiLeseAuth');
const dbWechsel = require('../lib/dbWechsel');
const backup = require('../lib/backup');
const multer = require('multer');
const aiStatus = require('../lib/ai/status');
const { jahresverbrauchJeTyp } = require('../lib/consumption');
const { ERLAUBTE_EINHEITEN, slugifyKey, istStromTyp, istWaermeKombiTyp } = require('../lib/meterTypen');
const { parseMesswert, parseDatumFlexibel } = require('../lib/zahlenFormat');
const zaehlerStammdaten = require('../lib/exportImport/zaehlerStammdaten');
const tempStore = require('../lib/importTempStore');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// --- Uebersicht ---------------------------------------------------------
// Reine Navigationsseite (gruppiertes Menue, Auftrag Abschnitt 4) - Kennzahlen
// stehen seit diesem Auftrag unter /admin/statistik statt hier.
router.get('/', async (req, res) => {
  const [{ n: anzahlOffeneKorrekturen }] = await knex('reading_corrections').where({ status: 'offen' }).count('id as n');
  res.render('admin/uebersicht', { titel: 'Administration', anzahlOffeneKorrekturen });
});

// --- Statistik (Auftrag Abschnitt 4) -------------------------------------
// Ausschliesslich zuverlaessig aus vorhandenen Messwerten berechnete Zahlen
// fuer Verbrauchsvergleiche - keine Prognose/Hochrechnung (siehe forecast.js).
router.get('/statistik', async (req, res) => {
  const [{ n: anzahlNutzer }] = await knex('users').count('id as n');
  const [{ n: anzahlZaehler }] = await knex('meters').count('id as n');
  const [{ n: anzahlMesswerte }] = await knex('readings').count('id as n');
  const jahresverbrauch = await jahresverbrauchJeTyp();
  res.render('admin/statistik', { titel: 'Statistik', anzahlNutzer, anzahlZaehler, anzahlMesswerte, jahresverbrauch });
});

// --- Benutzerverwaltung -------------------------------------------------
// Gruppenrechte steuern ausschliesslich, fuer welche Zaehlergruppen ein
// Benutzer (Rolle "user") Messwerte erfassen darf (Auftrag "Zaehlergruppen
// und Berechtigungen"); Admins sind davon unabhaengig immer berechtigt.
async function ladeBenutzerMitGruppenrechten() {
  const benutzer = await knex('users').orderBy('email');
  const rechte = await knex('user_group_permissions');
  const gruppenJeNutzer = new Map();
  for (const r of rechte) {
    if (!gruppenJeNutzer.has(r.user_id)) gruppenJeNutzer.set(r.user_id, new Set());
    gruppenJeNutzer.get(r.user_id).add(r.group_id);
  }
  return benutzer.map((b) => ({ ...b, gruppenIds: gruppenJeNutzer.get(b.id) || new Set() }));
}

router.get('/benutzer', async (req, res) => {
  const benutzer = await ladeBenutzerMitGruppenrechten();
  const gruppen = await knex('meter_groups').where({ active: true }).orderBy('sort_order');
  res.render('admin/benutzer', { titel: 'Benutzerverwaltung', benutzer, gruppen, fehler: null, erfolg: null });
});

router.post('/benutzer', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const passwort = String(req.body.passwort || '');
    const role = req.body.role === 'admin' ? 'admin' : 'user';
    if (!email || !passwort || passwort.length < 8) throw new Error('E-Mail und ein Passwort mit mindestens 8 Zeichen sind erforderlich.');
    const hash = await hashPassword(passwort);
    await knex('users').insert({ email, password_hash: hash, role, active: true });
    await audit.log(req.user.id, 'benutzer_angelegt', { email, role });
    res.redirect('/admin/benutzer');
  } catch (err) {
    console.error('Fehler in admin.js:', err.message);
    const benutzer = await ladeBenutzerMitGruppenrechten();
    const gruppen = await knex('meter_groups').where({ active: true }).orderBy('sort_order');
    res.status(400).render('admin/benutzer', { titel: 'Benutzerverwaltung', benutzer, gruppen, fehler: err.message, erfolg: null });
  }
});

router.post('/benutzer/:id/aktiv', async (req, res) => {
  const aktiv = req.body.aktiv === '1';
  if (Number(req.params.id) === req.user.id && !aktiv) {
    return res.status(400).render('fehler', { titel: 'Nicht möglich', nachricht: 'Das eigene Konto kann nicht deaktiviert werden.' });
  }
  await knex('users').where({ id: req.params.id }).update({ active: aktiv, updated_at: knex.fn.now() });
  await audit.log(req.user.id, aktiv ? 'benutzer_aktiviert' : 'benutzer_deaktiviert', { user_id: req.params.id });
  res.redirect('/admin/benutzer');
});

router.post('/benutzer/:id/passwort', async (req, res) => {
  const neuesPasswort = String(req.body.neues_passwort || '');
  if (neuesPasswort.length < 8) {
    const benutzer = await ladeBenutzerMitGruppenrechten();
    const gruppen = await knex('meter_groups').where({ active: true }).orderBy('sort_order');
    return res.status(400).render('admin/benutzer', { titel: 'Benutzerverwaltung', benutzer, gruppen, fehler: 'Das neue Passwort muss mindestens 8 Zeichen haben.', erfolg: null });
  }
  const hash = await hashPassword(neuesPasswort);
  await knex('users').where({ id: req.params.id }).update({ password_hash: hash, updated_at: knex.fn.now() });
  await audit.log(req.user.id, 'benutzer_passwort_zurueckgesetzt', { user_id: req.params.id });
  const benutzer = await ladeBenutzerMitGruppenrechten();
  const gruppen = await knex('meter_groups').where({ active: true }).orderBy('sort_order');
  res.render('admin/benutzer', { titel: 'Benutzerverwaltung', benutzer, gruppen, fehler: null, erfolg: 'Passwort wurde zurückgesetzt.' });
});

// Ersetzt vollstaendig die Menge der Gruppen, fuer die dieser Benutzer
// Messwerte erfassen darf (nur Rolle "user" relevant - Admins sind ohnehin
// immer berechtigt, siehe lib/berechtigung.js).
router.post('/benutzer/:id/gruppen', async (req, res) => {
  const userId = Number(req.params.id);
  const benutzer = await knex('users').where({ id: userId }).first();
  if (!benutzer) return res.status(404).render('fehler', { titel: 'Nicht gefunden', nachricht: 'Benutzer nicht gefunden.' });
  const gewaehlt = [].concat(req.body.gruppen || []).map(Number).filter(Boolean);
  const gueltig = gewaehlt.length > 0 ? await knex('meter_groups').whereIn('id', gewaehlt).pluck('id') : [];
  await knex.transaction(async (trx) => {
    await trx('user_group_permissions').where({ user_id: userId }).del();
    if (gueltig.length > 0) {
      await trx('user_group_permissions').insert(gueltig.map((groupId) => ({ user_id: userId, group_id: groupId })));
    }
  });
  await audit.log(req.user.id, 'benutzer_gruppenrechte_geaendert', { user_id: userId, gruppen: gueltig });
  res.redirect('/admin/benutzer');
});

// --- Zaehlerarten-Verwaltung (Auftrag Abschnitt 2) -----------------------
// "Vom Versorger betrieben" und "Eichdaten anzeigen" sind Vorgaben der
// Zaehlerart (betreiber_versorger_standard/eichdaten_anzeigen_standard), die
// pro Zaehler ueberschreibbar bleiben (meters.betreiber_typ bzw.
// meters.eichdaten_anzeigen, siehe meterTypen.js effektivEichdatenAnzeigen).
// Der technische Schluessel (key) ist unveraenderlich, da Saison-/Stromlogik
// (forecast.js, meterTypen.js) daran anknuepft - nur das Label ist editierbar.
async function ladeZaehlerartenListe() {
  const typen = await knex('meter_types').orderBy('sort_order');
  const zaehlerAnzahl = await knex('meters').select('meter_type_id').count('id as n').groupBy('meter_type_id');
  const anzahlJeTyp = new Map(zaehlerAnzahl.map((z) => [z.meter_type_id, Number(z.n)]));
  return typen.map((t) => ({ ...t, anzahl_zaehler: anzahlJeTyp.get(t.id) || 0 }));
}

// bestehendeEinheit: bei einer bestehenden Zaehlerart (Bearbeiten) wird die
// Einheit IMMER beibehalten und ein abweichender Wert im Formular ignoriert -
// das Frontend sperrt das Feld nur optisch, die eigentliche Absicherung (analog
// zum unveraenderlichen "key") muss serverseitig erfolgen, da sonst ein
// direkter POST die Einheit bereits verwendeter Zaehlerarten veraendern koennte.
// waermeKombiBestehend: analog zur Einheit nur bei der Neuanlage setzbar, da
// bestehende Messwerte an der Struktur (ein oder zwei Werte je Ablesung) haengen.
function zaehlerartFeldWerte(body, bestehendeEinheit, waermeKombiBestehend) {
  const label = String(body.label || '').trim();
  if (!label) throw new Error('Name der Zählerart ist erforderlich.');
  const neuanlage = bestehendeEinheit === undefined;
  const waermeKombi = neuanlage ? body.waerme_kombi === 'on' : Boolean(waermeKombiBestehend);
  const unit = bestehendeEinheit || (waermeKombi ? 'kWh' : body.unit);
  if (!ERLAUBTE_EINHEITEN.includes(unit)) throw new Error('Einheit muss m³ oder kWh sein.');
  return {
    label,
    unit,
    waerme_kombi: waermeKombi,
    betreiber_versorger_standard: body.betreiber_versorger_standard === 'on',
    eichdaten_anzeigen_standard: body.eichdaten_anzeigen_standard === 'on' || body.eichdaten_anzeigen_standard === undefined,
  };
}

router.get('/zaehlerarten', async (req, res) => {
  const zaehlerarten = await ladeZaehlerartenListe();
  res.render('admin/zaehlerarten', { titel: 'Zählerarten', zaehlerarten, fehler: null, erfolg: req.query.gespeichert ? 'Gespeichert.' : null });
});

router.get('/zaehlerarten/neu', async (req, res) => {
  res.render('admin/zaehlerart_form', { titel: 'Neue Zählerart', zaehlerart: null, fehler: null });
});

router.post('/zaehlerarten', async (req, res) => {
  try {
    const daten2 = zaehlerartFeldWerte(req.body);
    const vorhandeneSchluessel = new Set((await knex('meter_types').select('key')).map((t) => t.key));
    let key = slugifyKey(daten2.label);
    let n = 2;
    while (vorhandeneSchluessel.has(key)) { key = `${slugifyKey(daten2.label)}_${n}`; n++; }
    const [{ max: maxSort }] = await knex('meter_types').max('sort_order as max');
    await knex('meter_types').insert({ ...daten2, key, sort_order: (maxSort || 0) + 1, active: true });
    await audit.log(req.user.id, 'zaehlerart_angelegt', { key, label: daten2.label });
    res.redirect('/admin/zaehlerarten?gespeichert=1');
  } catch (err) {
    console.error('Fehler in admin.js (Zaehlerart anlegen):', err.message);
    res.status(400).render('admin/zaehlerart_form', { titel: 'Neue Zählerart', zaehlerart: req.body, fehler: err.message });
  }
});

router.get('/zaehlerarten/:id/bearbeiten', async (req, res) => {
  const zaehlerart = await knex('meter_types').where({ id: req.params.id }).first();
  if (!zaehlerart) return res.status(404).render('fehler', { titel: 'Nicht gefunden', nachricht: 'Zählerart nicht gefunden.' });
  res.render('admin/zaehlerart_form', { titel: 'Zählerart bearbeiten', zaehlerart, fehler: null });
});

router.post('/zaehlerarten/:id', async (req, res) => {
  try {
    const vorhanden = await knex('meter_types').where({ id: req.params.id }).first();
    if (!vorhanden) return res.status(404).render('fehler', { titel: 'Nicht gefunden', nachricht: 'Zählerart nicht gefunden.' });
    const daten2 = zaehlerartFeldWerte(req.body, vorhanden.unit, vorhanden.waerme_kombi);
    await knex('meter_types').where({ id: req.params.id }).update(daten2);
    await audit.log(req.user.id, 'zaehlerart_bearbeitet', { meter_type_id: req.params.id, label: daten2.label });
    res.redirect('/admin/zaehlerarten?gespeichert=1');
  } catch (err) {
    console.error('Fehler in admin.js (Zaehlerart bearbeiten):', err.message);
    const zaehlerart = await knex('meter_types').where({ id: req.params.id }).first();
    res.status(400).render('admin/zaehlerart_form', { titel: 'Zählerart bearbeiten', zaehlerart: { ...zaehlerart, ...req.body }, fehler: err.message });
  }
});

router.post('/zaehlerarten/:id/aktivieren', async (req, res) => {
  const aktiv = req.body.aktiv === '1';
  await knex('meter_types').where({ id: req.params.id }).update({ active: aktiv });
  await audit.log(req.user.id, aktiv ? 'zaehlerart_aktiviert' : 'zaehlerart_deaktiviert', { meter_type_id: req.params.id });
  res.redirect('/admin/zaehlerarten');
});

// Zaehlerarten, die bereits von Zaehlern verwendet werden, duerfen keine Daten/
// Beziehungen zerstoeren - die Datenbank verhindert das Loeschen ueber den
// Fremdschluessel meters.meter_type_id (RESTRICT); in diesem Fall wird
// stattdessen zum Deaktivieren/Archivieren geraten (wie bei Zaehlern selbst).
router.post('/zaehlerarten/:id/loeschen', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const zaehlerart = await knex('meter_types').where({ id }).first();
    if (!zaehlerart) return res.redirect('/admin/zaehlerarten');
    await knex('meter_types').where({ id }).del();
    await audit.log(req.user.id, 'zaehlerart_geloescht', { meter_type_id: id, key: zaehlerart.key });
    res.redirect('/admin/zaehlerarten?gespeichert=1');
  } catch (err) {
    console.error('Fehler in admin.js (Zaehlerart loeschen):', err.message);
    const zaehlerarten = await ladeZaehlerartenListe();
    res.status(400).render('admin/zaehlerarten', {
      titel: 'Zählerarten',
      zaehlerarten,
      erfolg: null,
      fehler: 'Diese Zählerart kann nicht gelöscht werden, da noch Zähler damit verbunden sind (Historie bleibt geschützt). Bitte stattdessen deaktivieren.',
    });
  }
});

// --- Zaehlergruppen-Verwaltung (Auftrag "Zaehlergruppen und Berechtigungen") --
// Gruppen koennen bewusst nicht geloescht werden, nur deaktiviert (auch bereits
// verwendete bleiben als Historie an den zugeordneten Zaehlern erhalten).
async function ladeGruppenListe() {
  const gruppen = await knex('meter_groups').orderBy('sort_order');
  const zaehlerAnzahl = await knex('meters').select('group_id').count('id as n').groupBy('group_id');
  const anzahlJeGruppe = new Map(zaehlerAnzahl.map((z) => [z.group_id, Number(z.n)]));
  return gruppen.map((g) => ({ ...g, anzahl_zaehler: anzahlJeGruppe.get(g.id) || 0 }));
}

router.get('/gruppen', async (req, res) => {
  const gruppen = await ladeGruppenListe();
  res.render('admin/gruppen', { titel: 'Zählergruppen', gruppen, fehler: null, erfolg: req.query.gespeichert ? 'Gespeichert.' : null });
});

router.get('/gruppen/neu', async (req, res) => {
  res.render('admin/gruppe_form', { titel: 'Neue Zählergruppe', gruppe: null, fehler: null });
});

router.post('/gruppen', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw new Error('Name der Zählergruppe ist erforderlich.');
    const [{ max: maxSort }] = await knex('meter_groups').max('sort_order as max');
    await knex('meter_groups').insert({ name, sort_order: (maxSort || 0) + 1, active: true });
    await audit.log(req.user.id, 'gruppe_angelegt', { name });
    res.redirect('/admin/gruppen?gespeichert=1');
  } catch (err) {
    console.error('Fehler in admin.js (Gruppe anlegen):', err.message);
    res.status(400).render('admin/gruppe_form', { titel: 'Neue Zählergruppe', gruppe: req.body, fehler: err.message });
  }
});

router.get('/gruppen/:id/bearbeiten', async (req, res) => {
  const gruppe = await knex('meter_groups').where({ id: req.params.id }).first();
  if (!gruppe) return res.status(404).render('fehler', { titel: 'Nicht gefunden', nachricht: 'Zählergruppe nicht gefunden.' });
  res.render('admin/gruppe_form', { titel: 'Zählergruppe bearbeiten', gruppe, fehler: null });
});

router.post('/gruppen/:id', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw new Error('Name der Zählergruppe ist erforderlich.');
    await knex('meter_groups').where({ id: req.params.id }).update({ name, updated_at: knex.fn.now() });
    await audit.log(req.user.id, 'gruppe_bearbeitet', { group_id: req.params.id, name });
    res.redirect('/admin/gruppen?gespeichert=1');
  } catch (err) {
    console.error('Fehler in admin.js (Gruppe bearbeiten):', err.message);
    const gruppe = await knex('meter_groups').where({ id: req.params.id }).first();
    res.status(400).render('admin/gruppe_form', { titel: 'Zählergruppe bearbeiten', gruppe: { ...gruppe, ...req.body }, fehler: err.message });
  }
});

router.post('/gruppen/:id/aktivieren', async (req, res) => {
  const aktiv = req.body.aktiv === '1';
  await knex('meter_groups').where({ id: req.params.id }).update({ active: aktiv, updated_at: knex.fn.now() });
  await audit.log(req.user.id, aktiv ? 'gruppe_aktiviert' : 'gruppe_deaktiviert', { group_id: req.params.id });
  res.redirect('/admin/gruppen');
});

// --- KI-Einstellungen -----------------------------------------------------
router.get('/ki', async (req, res) => {
  const view = await settings.getPublicAdminView();
  res.render('admin/ki', { titel: 'KI-Einstellungen', view, fehler: null, erfolg: null });
});

router.post('/ki', async (req, res) => {
  const update = {
    ai_enabled: req.body.ai_enabled === 'on' ? 'true' : 'false',
    ai_provider: ['ollama', 'anthropic'].includes(req.body.ai_provider) ? req.body.ai_provider : 'openai_compatible',
    ai_base_url: String(req.body.ai_base_url || '').trim(),
    ai_model: String(req.body.ai_model || '').trim(),
    ai_timeout_seconds: String(Number(req.body.ai_timeout_seconds || 30)),
  };
  if (req.body.ai_api_key_loeschen === 'on') {
    update.ai_api_key_enc = '';
  } else if (req.body.ai_api_key) {
    update.ai_api_key_enc = cryptoLib.encrypt(req.body.ai_api_key);
  }
  await settings.setMany(update);
  aiStatus.invalidiere();
  await audit.log(req.user.id, 'ki_einstellungen_geaendert', { provider: update.ai_provider, enabled: update.ai_enabled });
  const view = await settings.getPublicAdminView();
  res.render('admin/ki', { titel: 'KI-Einstellungen', view, fehler: null, erfolg: 'Gespeichert.' });
});

// --- SMTP-Einstellungen -----------------------------------------------------
router.get('/smtp', async (req, res) => {
  const view = await settings.getPublicAdminView();
  res.render('admin/smtp', { titel: 'SMTP-Einstellungen', view, fehler: null, erfolg: null });
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Prueft eine kommagetrennte Empfaengerliste: trimmt, verwirft leere Eintraege,
// meldet aber (anders als die bestehende Eichfrist-Liste) ungueltige Adressen
// statt sie stillschweigend zu uebernehmen (Auftrag Abschnitt 5: "sicher
// speichern"). Nur fuer die NEUE Messwert-Empfaengerliste verwendet, um das
// bestehende, unveraenderte Verhalten der Eichfrist-Liste nicht anzutasten.
function parseUndPruefeEmpfaenger(roh) {
  const eintraege = String(roh || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ungueltig = eintraege.filter((e) => !EMAIL_REGEX.test(e));
  if (ungueltig.length > 0) {
    throw new Error(`Ungültige E-Mail-Adresse(n) bei "Empfänger bei neuen Messwerten": ${ungueltig.join(', ')}`);
  }
  return eintraege.join(', ');
}

router.post('/smtp', async (req, res) => {
  const update = {
    smtp_enabled: req.body.smtp_enabled === 'on' ? 'true' : 'false',
    smtp_host: String(req.body.smtp_host || '').trim(),
    smtp_port: String(Number(req.body.smtp_port || 587)),
    smtp_secure_mode: ['none', 'starttls', 'tls'].includes(req.body.smtp_secure_mode) ? req.body.smtp_secure_mode : 'starttls',
    smtp_user: String(req.body.smtp_user || '').trim(),
    smtp_from: String(req.body.smtp_from || '').trim(),
    notify_eichfrist_days_before: String(Number(req.body.notify_eichfrist_days_before || 30)),
    notify_recipients: String(req.body.notify_recipients || '').trim(),
    notify_messwert_enabled: req.body.notify_messwert_enabled === 'on' ? 'true' : 'false',
  };
  try {
    update.notify_messwert_recipients = parseUndPruefeEmpfaenger(req.body.notify_messwert_recipients);
  } catch (err) {
    const view = await settings.getPublicAdminView();
    return res.status(400).render('admin/smtp', { titel: 'SMTP-Einstellungen', view: { ...view, ...req.body }, fehler: err.message, erfolg: null });
  }
  if (req.body.smtp_password_loeschen === 'on') {
    update.smtp_password_enc = '';
  } else if (req.body.smtp_password) {
    update.smtp_password_enc = cryptoLib.encrypt(req.body.smtp_password);
  }
  await settings.setMany(update);
  await audit.log(req.user.id, 'smtp_einstellungen_geaendert', { host: update.smtp_host, enabled: update.smtp_enabled });
  const view = await settings.getPublicAdminView();
  res.render('admin/smtp', { titel: 'SMTP-Einstellungen', view, fehler: null, erfolg: 'Gespeichert.' });
});

router.post('/smtp/test', async (req, res) => {
  const empfaenger = String(req.body.test_empfaenger || req.user.email).trim();
  const ergebnis = await mailer.sendTestMail(empfaenger);
  const view = await settings.getPublicAdminView();
  res.render('admin/smtp', {
    titel: 'SMTP-Einstellungen',
    view,
    fehler: ergebnis.ok ? null : ergebnis.fehler,
    erfolg: ergebnis.ok ? `Test-E-Mail an ${empfaenger} gesendet.` : null,
  });
});

// --- Rechtliches (Auftrag Abschnitt 7) ------------------------------------
// Editierbare Textvorlagen fuer die oeffentliche Seite /rechtliches (siehe
// routes/rechtliches.js). Werden als einfacher Text (kein HTML) gespeichert
// und mit white-space:pre-wrap dargestellt - verhindert HTML-Injection ueber
// diese Texte von vornherein, ohne eine Markdown-Bibliothek einzufuehren.
router.get('/rechtliches', async (req, res) => {
  const all = await settings.getAll();
  res.render('admin/rechtliches', {
    titel: 'Rechtliches',
    impressum: all.recht_impressum || '',
    datenschutz: all.recht_datenschutz || '',
    sonstiges: all.recht_sonstiges || '',
    fehler: null,
    erfolg: null,
  });
});

router.post('/rechtliches', async (req, res) => {
  const update = {
    recht_impressum: String(req.body.impressum || ''),
    recht_datenschutz: String(req.body.datenschutz || ''),
    recht_sonstiges: String(req.body.sonstiges || ''),
  };
  await settings.setMany(update);
  await audit.log(req.user.id, 'rechtliches_geaendert', {});
  res.render('admin/rechtliches', {
    titel: 'Rechtliches',
    impressum: update.recht_impressum,
    datenschutz: update.recht_datenschutz,
    sonstiges: update.recht_sonstiges,
    fehler: null,
    erfolg: 'Gespeichert.',
  });
});

// --- System/Datenbank (informativ) ------------------------------------------
router.get('/system', async (req, res) => {
  const [{ n: anzahlMesswerte }] = await knex('readings').count('id as n');
  const [{ n: anzahlFotos }] = await knex('photos').count('id as n');
  res.render('admin/system', {
    titel: 'System',
    dbDriver: config.DB_DRIVER,
    dbInfo: config.DB_DRIVER === 'mariadb' ? { host: config.mariadb.host, port: config.mariadb.port, database: config.mariadb.database, user: config.mariadb.user } : { datei: 'data/db.sqlite' },
    anzahlMesswerte,
    anzahlFotos,
  });
});

// --- Externe Lese-API (Auftrag "Lese-API/Datenbankwechsel", Abschnitt 1) ------
// Schluessel wird nur bei Erzeugung einmal im Klartext angezeigt, danach ist
// ausschliesslich der SHA-256-Hash gespeichert (siehe apiLeseAuth.js).
router.get('/api', async (req, res) => {
  const view = await settings.getPublicAdminView();
  res.render('admin/api', {
    titel: 'Externe Lese-API',
    enabled: view.api_lese_enabled === 'true',
    hatSchluessel: Boolean(view.api_lese_key_hash_gesetzt),
    erstelltAm: view.api_lese_key_created_at || null,
    zuletztGenutztAm: view.api_lese_key_last_used_at || null,
    neuerSchluessel: null,
    fehler: null,
    erfolg: null,
  });
});

router.post('/api/erzeugen', async (req, res) => {
  const schluessel = apiLeseAuth.generiereSchluessel();
  await settings.setMany({
    api_lese_key_hash: apiLeseAuth.hasheSchluessel(schluessel),
    api_lese_key_created_at: new Date().toISOString(),
    api_lese_key_last_used_at: '',
  });
  await audit.log(req.user.id, 'api_lese_schluessel_erzeugt', {});
  const view = await settings.getPublicAdminView();
  res.render('admin/api', {
    titel: 'Externe Lese-API',
    enabled: view.api_lese_enabled === 'true',
    hatSchluessel: true,
    erstelltAm: view.api_lese_key_created_at || null,
    zuletztGenutztAm: null,
    neuerSchluessel: schluessel,
    fehler: null,
    erfolg: 'Neuer Schlüssel erzeugt. Er wird nur dieses eine Mal angezeigt - jetzt sicher übernehmen.',
  });
});

router.post('/api/aktivieren', async (req, res) => {
  const aktivieren = req.body.aktiv === '1';
  const view = await settings.getPublicAdminView();
  if (aktivieren && !view.api_lese_key_hash_gesetzt) {
    return res.status(400).render('admin/api', {
      titel: 'Externe Lese-API',
      enabled: false,
      hatSchluessel: false,
      erstelltAm: null,
      zuletztGenutztAm: null,
      neuerSchluessel: null,
      fehler: 'Bitte zuerst einen Schlüssel erzeugen, bevor die API aktiviert wird.',
      erfolg: null,
    });
  }
  await settings.set('api_lese_enabled', aktivieren ? 'true' : 'false');
  await audit.log(req.user.id, aktivieren ? 'api_lese_aktiviert' : 'api_lese_deaktiviert', {});
  res.redirect('/admin/api');
});

router.post('/api/widerrufen', async (req, res) => {
  await settings.setMany({
    api_lese_enabled: 'false',
    api_lese_key_hash: '',
    api_lese_key_created_at: '',
    api_lese_key_last_used_at: '',
  });
  await audit.log(req.user.id, 'api_lese_widerrufen', {});
  res.render('admin/api', {
    titel: 'Externe Lese-API',
    enabled: false,
    hatSchluessel: false,
    erstelltAm: null,
    zuletztGenutztAm: null,
    neuerSchluessel: null,
    fehler: null,
    erfolg: 'Schlüssel widerrufen und API deaktiviert.',
  });
});

// --- Datenbankwechsel (Auftrag Abschnitt 2) -----------------------------------
// Mehrstufiger, im Arbeitsspeicher gehaltener Ablauf (Token wie bei /admin/reset):
// testen -> Export/Backup erzwingen -> migrieren+verifizieren -> explizit
// bestaetigt uebernehmen. Das Zielpasswort wird nie auf die Platte geschrieben,
// bis die Verifikation erfolgreich war, und landet dann ausschliesslich in .env.
const ausstehendeWechsel = new Map();
const DB_WECHSEL_BESTAETIGUNG = 'DATENBANK WECHSELN';

function leereWechselAnsicht(extra) {
  return {
    titel: 'Datenbankwechsel',
    aktuelle: dbWechsel.aktuelleKonfiguration(),
    token: null,
    eintrag: null,
    sqliteDateiVorhanden: fs.existsSync(config.SQLITE_FILE),
    bestaetigungstext: DB_WECHSEL_BESTAETIGUNG,
    fehler: null,
    erfolg: null,
    ...extra,
  };
}

router.get('/datenbank', (req, res) => {
  const token = req.query.token;
  const eintrag = token ? ausstehendeWechsel.get(token) : null;
  res.render('admin/datenbank', leereWechselAnsicht({ token: eintrag ? token : null, eintrag }));
});

router.post('/datenbank/testen', async (req, res) => {
  const treiber = req.body.ziel_treiber === 'mariadb' ? 'mariadb' : 'sqlite';
  const ziel = treiber === 'mariadb'
    ? {
      treiber,
      host: String(req.body.ziel_host || '').trim(),
      port: Number(req.body.ziel_port || 3306),
      user: String(req.body.ziel_user || '').trim(),
      passwort: String(req.body.ziel_passwort || ''),
      datenbank: String(req.body.ziel_datenbank || '').trim(),
    }
    : { treiber };

  if (treiber === 'mariadb' && (!ziel.host || !ziel.user || !ziel.datenbank)) {
    return res.status(400).render('admin/datenbank', leereWechselAnsicht({ fehler: 'Host, Benutzer und Datenbankname sind erforderlich.' }));
  }
  if (dbWechsel.istIdentischMitAktiverVerbindung(ziel)) {
    return res.status(400).render('admin/datenbank', leereWechselAnsicht({ fehler: 'Das Ziel entspricht der aktuell aktiven Verbindung.' }));
  }

  const ergebnis = await dbWechsel.testeZielverbindung(ziel);
  if (!ergebnis.ok) {
    await audit.log(req.user.id, 'db_wechsel_test_fehlgeschlagen', { ziel_treiber: treiber, ziel_host: ziel.host, ziel_datenbank: ziel.datenbank });
    return res.status(400).render('admin/datenbank', leereWechselAnsicht({ fehler: ergebnis.fehler }));
  }

  const token = crypto.randomUUID();
  ausstehendeWechsel.set(token, { ziel, schritt: 'getestet', erzeugtVon: req.user.id, erzeugtAm: Date.now(), backup: null, verifikation: null });
  await audit.log(req.user.id, 'db_wechsel_verbindung_getestet', { ziel_treiber: treiber, ziel_host: ziel.host, ziel_datenbank: ziel.datenbank });
  res.render('admin/datenbank', leereWechselAnsicht({ token, eintrag: ausstehendeWechsel.get(token), erfolg: 'Zielverbindung erreichbar, Rechte ausreichend. Als Nächstes ein Backup der aktuellen Daten erzeugen.' }));
});

router.post('/datenbank/:token/export', async (req, res) => {
  const eintrag = ausstehendeWechsel.get(req.params.token);
  if (!eintrag) return res.status(404).render('admin/datenbank', leereWechselAnsicht({ fehler: 'Dieser Vorgang ist abgelaufen - bitte die Verbindung erneut testen.' }));

  const backup = await dbWechsel.erzeugeBackup(req.user.id);
  eintrag.backup = { ...backup, heruntergeladen: false };
  eintrag.schritt = 'exportiert';
  await audit.log(req.user.id, 'db_wechsel_export_erzeugt', { dateiname: backup.dateiname });
  res.render('admin/datenbank', leereWechselAnsicht({ token: req.params.token, eintrag, erfolg: 'Backup erzeugt. Bitte jetzt herunterladen, bevor migriert werden kann.' }));
});

router.get('/datenbank/:token/download', (req, res) => {
  const eintrag = ausstehendeWechsel.get(req.params.token);
  if (!eintrag || !eintrag.backup) return res.status(404).render('fehler', { titel: 'Abgelaufen', nachricht: 'Dieses Backup ist nicht mehr verfügbar - bitte den Wechsel neu starten.' });
  eintrag.backup.heruntergeladen = true;
  res.download(eintrag.backup.pfad, 'db-wechsel-backup.json');
});

router.post('/datenbank/:token/migrieren', async (req, res) => {
  const token = req.params.token;
  const eintrag = ausstehendeWechsel.get(token);
  if (!eintrag) return res.status(404).render('admin/datenbank', leereWechselAnsicht({ fehler: 'Dieser Vorgang ist abgelaufen - bitte die Verbindung erneut testen.' }));
  if (!eintrag.backup || !eintrag.backup.heruntergeladen) {
    return res.status(400).render('admin/datenbank', leereWechselAnsicht({ token, eintrag, fehler: 'Bitte zuerst das Backup erzeugen UND herunterladen.' }));
  }

  const zielKnex = dbWechsel.baueZielKnex(eintrag.ziel);
  try {
    await dbWechsel.migriereSchema(zielKnex);
    const belegt = await dbWechsel.pruefeZielLeer(zielKnex);
    if (belegt.length > 0) {
      return res.status(400).render('admin/datenbank', leereWechselAnsicht({
        token,
        eintrag,
        fehler: `Die Zieldatenbank enthält bereits Daten in: ${belegt.join(', ')}. Bitte eine leere Zieldatenbank verwenden.`,
      }));
    }
    await dbWechsel.kopiereDaten(zielKnex);
    const verifikation = await dbWechsel.verifiziere(zielKnex);
    eintrag.verifikation = verifikation;
    eintrag.schritt = verifikation.ok ? 'migriert' : 'verifikation_fehlgeschlagen';
    await audit.log(req.user.id, 'db_wechsel_migriert', {
      ziel_treiber: eintrag.ziel.treiber,
      ziel_datenbank: eintrag.ziel.datenbank || null,
      verifiziert: verifikation.ok,
    });
    res.render('admin/datenbank', leereWechselAnsicht({
      token,
      eintrag,
      erfolg: verifikation.ok ? 'Migration abgeschlossen und verifiziert. Der Wechsel kann jetzt übernommen werden.' : null,
      fehler: verifikation.ok ? null : 'Verifikation fehlgeschlagen - Datensatzzahlen stimmen nicht überein (siehe Tabelle unten). Die bisherige Verbindung bleibt aktiv.',
    }));
  } catch (err) {
    console.error('Fehler in admin.js (Datenbankwechsel migrieren):', err.message);
    eintrag.schritt = 'exportiert';
    res.status(400).render('admin/datenbank', leereWechselAnsicht({ token, eintrag, fehler: 'Migration fehlgeschlagen: ' + err.message + ' Die bisherige Verbindung bleibt aktiv.' }));
  } finally {
    await zielKnex.destroy();
  }
});

router.post('/datenbank/:token/aktivieren', async (req, res) => {
  const token = req.params.token;
  const eintrag = ausstehendeWechsel.get(token);
  if (!eintrag) return res.status(404).render('admin/datenbank', leereWechselAnsicht({ fehler: 'Dieser Vorgang ist abgelaufen - bitte die Verbindung erneut testen.' }));
  if (eintrag.schritt !== 'migriert' || !eintrag.verifikation || !eintrag.verifikation.ok) {
    return res.status(400).render('admin/datenbank', leereWechselAnsicht({ token, eintrag, fehler: 'Bitte zuerst erfolgreich migrieren und verifizieren.' }));
  }
  if (String(req.body.bestaetigungstext || '') !== DB_WECHSEL_BESTAETIGUNG) {
    return res.status(400).render('admin/datenbank', leereWechselAnsicht({ token, eintrag, fehler: `Bitte exakt "${DB_WECHSEL_BESTAETIGUNG}" eingeben.` }));
  }

  dbWechsel.schreibeZielInEnv(eintrag.ziel);
  await audit.log(req.user.id, 'db_wechsel_uebernommen', {
    ziel_treiber: eintrag.ziel.treiber,
    ziel_host: eintrag.ziel.host || null,
    ziel_datenbank: eintrag.ziel.datenbank || null,
  });
  ausstehendeWechsel.delete(token);
  res.render('fehler', {
    titel: 'Datenbankwechsel vorbereitet',
    nachricht: 'Die .env wurde aktualisiert. Diese laufende Anwendung nutzt bis zu einem vollständigen Neuanlegen des Containers (docker compose up -d in diesem Projektordner) weiterhin die bisherige Verbindung - erst danach ist die neue Datenbank aktiv. Die bisherige Datenbank bleibt bis dahin unverändert und unverzichtbar als Rücksprungoption.',
  });
});

router.post('/datenbank/alte-sqlite-entfernen', async (req, res) => {
  if (String(req.body.bestaetigungstext || '') !== 'SQLITE DATEI LOESCHEN') {
    return res.status(400).render('admin/datenbank', leereWechselAnsicht({ fehler: 'Bitte exakt "SQLITE DATEI LOESCHEN" eingeben.' }));
  }
  try {
    dbWechsel.entferneAlteSqliteDatei();
    await audit.log(req.user.id, 'db_wechsel_alte_sqlite_entfernt', {});
    res.render('admin/datenbank', leereWechselAnsicht({ erfolg: 'Alte lokale SQLite-Datei entfernt.' }));
  } catch (err) {
    res.status(400).render('admin/datenbank', leereWechselAnsicht({ fehler: err.message }));
  }
});

// --- Vollbackup / Wiederherstellung (Auftrag "Vollstaendiges Backup und
// Wiederherstellung") -----------------------------------------------------
// Backup: jederzeit erzeugbar + herunterladbar (vertraulich - siehe backup.js).
// Wiederherstellung: Datei hochladen -> Vorschau + erzwungene Sicherheitskopie
// des AKTUELLEN Standes -> erst nach deren Download und exakter Textbestae-
// tigung wird angewendet (gleiches Muster wie /admin/reset und /admin/datenbank).
const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
const ausstehendeBackups = new Map();
const ausstehendeRestores = new Map();
const BACKUP_RESTORE_BESTAETIGUNG = 'BACKUP WIEDERHERSTELLEN';

function leereBackupAnsicht(extra) {
  return {
    titel: 'Vollbackup / Wiederherstellung',
    backupToken: null,
    backupEintrag: null,
    restoreToken: null,
    restoreEintrag: null,
    bestaetigungstext: BACKUP_RESTORE_BESTAETIGUNG,
    fehler: null,
    erfolg: null,
    ...extra,
  };
}

router.get('/backup', (req, res) => {
  res.render('admin/backup', leereBackupAnsicht({}));
});

router.post('/backup/erzeugen', async (req, res) => {
  try {
    const ergebnis = await backup.erzeugeVollbackup();
    const token = crypto.randomUUID();
    ausstehendeBackups.set(token, { ...ergebnis, erzeugtVon: req.user.id, heruntergeladen: false });
    await audit.log(req.user.id, 'vollbackup_erzeugt', { dateiname: ergebnis.dateiname, tabellen: ergebnis.tabellen });
    res.render('admin/backup', leereBackupAnsicht({
      backupToken: token,
      backupEintrag: ausstehendeBackups.get(token),
      erfolg: 'Vollbackup erzeugt. Bitte jetzt herunterladen und streng vertraulich/sicher aufbewahren (enthält u. a. Passwort-Hashes und den Verschlüsselungsschlüssel).',
    }));
  } catch (err) {
    console.error('Fehler in admin.js (Vollbackup erzeugen):', err.message);
    res.status(500).render('admin/backup', leereBackupAnsicht({ fehler: 'Vollbackup fehlgeschlagen: ' + err.message }));
  }
});

router.get('/backup/herunterladen/:token', (req, res) => {
  const eintrag = ausstehendeBackups.get(req.params.token);
  if (!eintrag) return res.status(404).render('fehler', { titel: 'Abgelaufen', nachricht: 'Dieses Backup ist nicht mehr verfügbar - bitte neu erzeugen.' });
  eintrag.heruntergeladen = true;
  res.download(eintrag.pfad, eintrag.dateiname);
});

router.post('/backup/restore/vorschau', backupUpload.single('datei'), async (req, res) => {
  if (!req.file) {
    return res.status(400).render('admin/backup', leereBackupAnsicht({ fehler: 'Bitte eine Vollbackup-Datei (.zip) auswählen.' }));
  }
  let vorschau;
  try {
    vorschau = await backup.bereiteRestoreVor(req.file.buffer);
  } catch (err) {
    return res.status(400).render('admin/backup', leereBackupAnsicht({ fehler: 'Backup-Datei konnte nicht gelesen werden: ' + err.message }));
  }
  try {
    const sicherheitsBackup = await backup.erzeugeVollbackup();
    const eintrag = {
      ...vorschau,
      sicherheitsBackup: { ...sicherheitsBackup, heruntergeladen: false },
      erzeugtVon: req.user.id,
      erzeugtAm: Date.now(),
    };
    ausstehendeRestores.set(vorschau.token, eintrag);
    await audit.log(req.user.id, 'vollbackup_restore_vorbereitet', { backup_erzeugt_am: vorschau.manifest.erzeugt_am, tabellen: vorschau.tabellen });
    res.render('admin/backup', leereBackupAnsicht({
      restoreToken: vorschau.token,
      restoreEintrag: eintrag,
      erfolg: 'Backup-Datei gelesen und geprüft. Vor der Wiederherstellung bitte zuerst die Sicherheitskopie des aktuellen Standes herunterladen.',
    }));
  } catch (err) {
    console.error('Fehler in admin.js (Restore-Vorschau):', err.message);
    backup.verwerfeVorbereitung(vorschau.stagingDir);
    res.status(500).render('admin/backup', leereBackupAnsicht({ fehler: 'Sicherheitskopie des aktuellen Standes konnte nicht erzeugt werden: ' + err.message }));
  }
});

router.get('/backup/restore/:token/sicherheitskopie', (req, res) => {
  const eintrag = ausstehendeRestores.get(req.params.token);
  if (!eintrag) return res.status(404).render('fehler', { titel: 'Abgelaufen', nachricht: 'Dieser Wiederherstellungsvorgang ist nicht mehr verfügbar - bitte die Backup-Datei erneut hochladen.' });
  eintrag.sicherheitsBackup.heruntergeladen = true;
  res.download(eintrag.sicherheitsBackup.pfad, eintrag.sicherheitsBackup.dateiname);
});

router.post('/backup/restore/:token/abbrechen', (req, res) => {
  const eintrag = ausstehendeRestores.get(req.params.token);
  if (eintrag) {
    backup.verwerfeVorbereitung(eintrag.stagingDir);
    ausstehendeRestores.delete(req.params.token);
  }
  res.redirect('/admin/backup');
});

router.post('/backup/restore/:token/bestaetigen', async (req, res) => {
  const token = req.params.token;
  const eintrag = ausstehendeRestores.get(token);
  if (!eintrag) {
    return res.status(404).render('admin/backup', leereBackupAnsicht({ fehler: 'Dieser Wiederherstellungsvorgang ist abgelaufen - bitte die Backup-Datei erneut hochladen.' }));
  }
  if (!eintrag.sicherheitsBackup.heruntergeladen) {
    return res.status(400).render('admin/backup', leereBackupAnsicht({ restoreToken: token, restoreEintrag: eintrag, fehler: 'Bitte zuerst die Sicherheitskopie des aktuellen Standes herunterladen.' }));
  }
  if (String(req.body.bestaetigungstext || '') !== BACKUP_RESTORE_BESTAETIGUNG) {
    return res.status(400).render('admin/backup', leereBackupAnsicht({ restoreToken: token, restoreEintrag: eintrag, fehler: `Bitte exakt "${BACKUP_RESTORE_BESTAETIGUNG}" eingeben.` }));
  }

  try {
    const ergebnis = await backup.wendeRestoreAn(eintrag.stagingDir);
    ausstehendeRestores.delete(token);
    await audit.log(req.user.id, 'vollbackup_restore_angewendet', { tabellen: ergebnis.tabellen, secretsWiederhergestellt: ergebnis.secretsWiederhergestellt });
    res.render('fehler', {
      titel: 'Wiederherstellung abgeschlossen',
      nachricht: 'Alle Daten wurden vollständig aus dem Backup wiederhergestellt. Der bisherige Stand liegt zur Sicherheit weiterhin unter data/uploads.vor-restore-*, data/vorlagen.vor-restore-* bzw. data/secrets.json.vor-restore-* und kann nach Prüfung manuell entfernt werden. Bitte jetzt einmal neu anmelden; falls sich der Verschlüsselungsschlüssel geändert hat, ist zusätzlich ein Neuanlegen des Containers nötig, damit SMTP-/KI-Einstellungen wieder entschlüsselt werden können.',
    });
  } catch (err) {
    console.error('Fehler in admin.js (Restore anwenden):', err.message);
    await audit.log(req.user.id, 'vollbackup_restore_fehlgeschlagen', { fehler: err.message, dbCommitted: Boolean(err.dbCommitted) });
    const dbHinweis = err.dbCommitted
      ? ' Die Datenbank wurde bereits erfolgreich wiederhergestellt; nur beim Ersetzen von Dateien (Uploads/Vorlagen/secrets.json) trat danach ein Fehler auf - bitte data/-Verzeichnis prüfen.'
      : ' Es wurde noch nichts verändert (die Datenbank-Transaktion wurde automatisch zurückgesetzt).';
    res.status(500).render('admin/backup', leereBackupAnsicht({
      restoreToken: token,
      restoreEintrag: eintrag,
      fehler: 'Wiederherstellung fehlgeschlagen: ' + err.message + dbHinweis,
    }));
  }
});

// --- Korrekturen (Auftrag Abschnitt 3) -----------------------------------
// Von normalen Benutzern vorgeschlagene Korrekturen (siehe routes/readings.js
// POST /messwerte/:id/bearbeiten) werden hier von einem Admin geprueft. Erst
// die Genehmigung aendert den zugrunde liegenden Messwert tatsaechlich - bis
// dahin bleibt er unveraendert. audit.log() bewusst NACH der Transaktion
// (siehe lib/audit.js - innerhalb einer Transaktion wuerde der Verbindungspool
// blockieren und den Eintrag still verlieren).
router.get('/korrekturen', async (req, res) => {
  const offene = await knex('reading_corrections')
    .join('readings', 'reading_corrections.reading_id', 'readings.id')
    .join('meters', 'readings.meter_id', 'meters.id')
    .join('meter_types', 'readings.meter_type_id', 'meter_types.id')
    .leftJoin('meter_groups', 'meters.group_id', 'meter_groups.id')
    .leftJoin('users as ersteller', 'reading_corrections.erstellt_von', 'ersteller.id')
    .where('reading_corrections.status', 'offen')
    .select(
      'reading_corrections.*',
      'readings.value as aktueller_wert',
      'readings.unit',
      'readings.reading_at as aktuelles_datum',
      'readings.status as aktueller_status',
      'meters.number as meter_number',
      'meters.anzeige_bezeichnung',
      'meter_types.label as type_label_name',
      'meter_groups.name as group_name',
      'ersteller.email as ersteller_email'
    )
    .orderBy('reading_corrections.erstellt_am', 'asc');
  res.render('admin/korrekturen', { titel: 'Korrekturen', offene, fehler: null, erfolg: req.query.entschieden ? 'Entscheidung gespeichert.' : null });
});

router.post('/korrekturen/:id/entscheiden', async (req, res) => {
  const id = Number(req.params.id);
  const entscheidung = req.body.entscheidung === 'genehmigen' ? 'genehmigen' : (req.body.entscheidung === 'ablehnen' ? 'ablehnen' : null);
  if (!entscheidung) return res.status(400).render('fehler', { titel: 'Ungültig', nachricht: 'Unbekannte Entscheidung.' });

  const korrektur = await knex('reading_corrections').where({ id, status: 'offen' }).first();
  if (!korrektur) return res.status(404).render('fehler', { titel: 'Nicht gefunden', nachricht: 'Diese Korrektur ist nicht mehr offen (bereits entschieden oder gelöscht).' });
  const reading = await knex('readings').where({ id: korrektur.reading_id }).first();
  if (!reading) return res.status(404).render('fehler', { titel: 'Nicht gefunden', nachricht: 'Der zugehörige Messwert existiert nicht mehr.' });

  const adminKommentar = String(req.body.admin_kommentar || '').trim() || null;
  if (entscheidung === 'genehmigen') {
    await knex.transaction(async (trx) => {
      await trx('readings').where({ id: reading.id }).update({
        value: korrektur.vorgeschlagener_wert,
        reading_at: korrektur.vorgeschlagenes_datum || reading.reading_at,
      });
      await trx('reading_corrections').where({ id }).update({
        status: 'genehmigt',
        bearbeitet_von: req.user.id,
        bearbeitet_am: trx.fn.now(),
        admin_kommentar: adminKommentar,
      });
    });
    await audit.log(req.user.id, 'korrektur_genehmigt', {
      reading_id: reading.id,
      korrektur_id: id,
      alter_wert: Number(reading.value),
      neuer_wert: Number(korrektur.vorgeschlagener_wert),
      altes_datum: reading.reading_at,
      neues_datum: korrektur.vorgeschlagenes_datum || reading.reading_at,
    });
  } else {
    await knex('reading_corrections').where({ id }).update({
      status: 'abgelehnt',
      bearbeitet_von: req.user.id,
      bearbeitet_am: knex.fn.now(),
      admin_kommentar: adminKommentar,
    });
    await audit.log(req.user.id, 'korrektur_abgelehnt', { reading_id: reading.id, korrektur_id: id });
  }
  res.redirect('/admin/korrekturen?entschieden=1');
});

// --- Zähler-Stammdaten Import/Export (Auftrag Abschnitt 3) ----------------
// Eigenstaendig von Messwerte-Import/-Export (routes/importExport.js):
// importiert/exportiert AUSSCHLIESSLICH Zählergruppen, Zählerarten und Zähler
// - nie Messwerte, Benutzer, Fotos oder Einstellungen. Siehe
// lib/exportImport/zaehlerStammdaten.js fuer die Vorschau-/Commit-Logik
// (nutzt dieselbe, bereits getestete Anlegelogik wie der Messwerte-Import).
const zaehlerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.get('/zaehler-stammdaten/export', (req, res) => {
  res.render('admin/zaehler_export', { titel: 'Zähler-Stammdaten exportieren' });
});

router.get('/zaehler-stammdaten/export/datei', async (req, res) => {
  const daten = await zaehlerStammdaten.erzeugeExport();
  await audit.log(req.user.id, 'zaehler_export', { gruppen: daten.meter_groups.length, typen: daten.meter_types.length, zaehler: daten.meters.length });
  res.setHeader('Content-Disposition', 'attachment; filename="zaehler-stammdaten-export.json"');
  res.json(daten);
});

router.get('/zaehler-stammdaten/import', (req, res) => {
  res.render('admin/zaehler_import', { titel: 'Zähler-Stammdaten importieren', vorschau: null, token: null, fehler: null, erfolg: null });
});

router.post('/zaehler-stammdaten/import/vorschau', zaehlerUpload.single('datei'), async (req, res) => {
  try {
    if (!req.file) throw new Error('Keine Datei hochgeladen.');
    let rohDaten;
    try {
      rohDaten = JSON.parse(req.file.buffer.toString('utf8'));
    } catch {
      throw new Error('Datei ist kein gültiges JSON.');
    }
    if (!zaehlerStammdaten.istGueltigeStammdatendatei(rohDaten)) {
      throw new Error('Diese Datei ist kein gültiger Zähler-Stammdatenexport (erwartet werden die Felder meter_groups/meter_types/meters, z. B. aus "Zähler-Stammdaten exportieren" oder einem vollständigen JSON-Export).');
    }
    const vorschau = await zaehlerStammdaten.analysiereImport(rohDaten);
    const token = tempStore.speichere(req.file.buffer, req.file.originalname);
    res.render('admin/zaehler_import', { titel: 'Zähler-Stammdaten importieren', vorschau, token, fehler: null, erfolg: null });
  } catch (err) {
    console.error('Fehler in admin.js (Zähler-Stammdaten-Vorschau):', err.message);
    res.status(400).render('admin/zaehler_import', { titel: 'Zähler-Stammdaten importieren', vorschau: null, token: null, fehler: err.message, erfolg: null });
  }
});

router.post('/zaehler-stammdaten/import/uebernehmen', async (req, res) => {
  const token = req.body.token;
  try {
    const eintrag = tempStore.finde(token);
    if (!eintrag) throw new Error('Die Vorschau ist abgelaufen - bitte Datei erneut hochladen.');
    const rohDaten = JSON.parse(eintrag.buffer.toString('utf8'));
    const ergebnis = await zaehlerStammdaten.commitImport(rohDaten);
    tempStore.loesche(token);
    await audit.log(req.user.id, 'zaehler_import_uebernommen', {
      neueGruppen: ergebnis.neueGruppen,
      neueTypen: ergebnis.neueTypen,
      neueZaehler: ergebnis.neueZaehler,
      uebersprungen: ergebnis.uebersprungeneZaehler.length,
    });
    const uebersprungenText = ergebnis.uebersprungeneZaehler.length > 0
      ? ` ${ergebnis.uebersprungeneZaehler.length} Zähler übersprungen (nicht auflösbare Zählerart): ${ergebnis.uebersprungeneZaehler.map((z) => z.number).join(', ')}.`
      : '';
    res.render('admin/zaehler_import', {
      titel: 'Zähler-Stammdaten importieren',
      vorschau: null,
      token: null,
      fehler: null,
      erfolg: `Übernommen: ${ergebnis.neueGruppen} Zählergruppe(n), ${ergebnis.neueTypen} Zählerart(en), ${ergebnis.neueZaehler} Zähler neu angelegt.${uebersprungenText}`,
    });
  } catch (err) {
    console.error('Fehler in admin.js (Zähler-Stammdaten-Import):', err.message);
    res.status(400).render('admin/zaehler_import', { titel: 'Zähler-Stammdaten importieren', vorschau: null, token: null, fehler: err.message, erfolg: null });
  }
});

// --- Messwerte gezielt löschen (Auftrag Abschnitt 1) ----------------------
// Eigenstaendige, enger gefasste Aktion (ausdruecklich KEINE Wiederverwendung
// der allgemeinen "/admin/reset"-Funktion weiter unten): loescht ausschliesslich
// Messwerte (und per FK-Kaskade die Datenbankeintraege ihrer Fotos) - Zaehler,
// Zaehlerarten, Benutzer, Einstellungen und das Auditlog bleiben unveraendert.
// Fotodateien gehoeren immer zu genau einem Messwert (photos.reading_id ist bei
// dauerhaft gespeicherten Fotos immer gesetzt, siehe routes/readings.js) und
// werden deshalb nur hier mitgeloescht, nie allgemein.
const MESSWERTE_LOESCHEN_BESTAETIGUNG = 'MESSWERTE LOESCHEN';

router.get('/messwerte-loeschen', async (req, res) => {
  const [{ n: anzahlMesswerte }] = await knex('readings').count('id as n');
  const [{ n: anzahlFotos }] = await knex('photos').count('id as n');
  res.render('admin/messwerte_loeschen', {
    titel: 'Messwerte löschen',
    anzahlMesswerte,
    anzahlFotos,
    bestaetigungstext: MESSWERTE_LOESCHEN_BESTAETIGUNG,
    fehler: null,
  });
});

router.post('/messwerte-loeschen', async (req, res) => {
  if (String(req.body.bestaetigungstext || '') !== MESSWERTE_LOESCHEN_BESTAETIGUNG) {
    const [{ n: anzahlMesswerte }] = await knex('readings').count('id as n');
    const [{ n: anzahlFotos }] = await knex('photos').count('id as n');
    return res.status(400).render('admin/messwerte_loeschen', {
      titel: 'Messwerte löschen',
      anzahlMesswerte,
      anzahlFotos,
      bestaetigungstext: MESSWERTE_LOESCHEN_BESTAETIGUNG,
      fehler: `Bitte exakt "${MESSWERTE_LOESCHEN_BESTAETIGUNG}" eingeben.`,
    });
  }

  const [{ n: anzahlMesswerte }] = await knex('readings').count('id as n');
  const fotoDateien = (await knex('photos').select('filename')).map((f) => f.filename);

  await knex.transaction(async (trx) => {
    // FK onDelete('CASCADE') von photos.reading_id loescht die Fotos-Datensaetze
    // automatisch mit; reading_corrections.reading_id (CASCADE) ebenso.
    await trx('readings').del();
  });

  for (const filename of fotoDateien) {
    const dateipfad = path.join(config.UPLOADS_DIR, filename);
    if (fs.existsSync(dateipfad)) fs.unlinkSync(dateipfad);
  }

  await audit.log(req.user.id, 'messwerte_geloescht', { anzahlMesswerte, anzahlFotos: fotoDateien.length });
  res.render('fehler', {
    titel: 'Messwerte gelöscht',
    nachricht: `${anzahlMesswerte} Messwert(e) und ${fotoDateien.length} zugehörige(s) Foto(s) wurden endgültig gelöscht. Zähler, Zählerarten, Benutzerkonten und Einstellungen bleiben erhalten.`,
  });
});

// --- Messwerte: Admin-Tabelle (Auftrag Abschnitt 1) -----------------------
// Uebersichtliche, filterbare/sortierbare/paginierte Verwaltungsansicht ALLER
// Messwerte (anders als die kurze "Zuletzt erfasste Messwerte"-Liste unter
// /messwerte, die nur die letzten 50 zeigt und fuer Benutzer teils nur
// Korrekturvorschlaege erlaubt). Hier duerfen ausschliesslich Admins direkt
// bearbeiten/loeschen (ueber router.use(requireAuth, requireAdmin) oben bereits
// serverseitig erzwungen) - bestehende Korrekturantraege (reading_corrections,
// siehe oben) bleiben davon unberuehrt.
const MESSWERTE_SEITENGROESSE = 50;
const MESSWERTE_SORTSPALTEN = {
  datum: 'readings.reading_at',
  zaehler: 'meters.number',
  wert: 'readings.value',
  status: 'readings.status',
};

function messartLabel(r) {
  if (r.strom_richtung) return r.strom_richtung === 'verbrauch' ? 'Verbrauch' : 'Einspeisung';
  if (r.waerme_teil) return r.waerme_teil === 'kwh' ? 'kWh' : 'm³';
  return '';
}

async function ladeMesswerteTabelle(query) {
  const seite = Math.max(1, Number(query.seite) || 1);
  const sortSpalte = MESSWERTE_SORTSPALTEN[query.sort] || MESSWERTE_SORTSPALTEN.datum;
  const order = query.order === 'asc' ? 'asc' : 'desc';

  function basisQuery() {
    let q = knex('readings')
      .join('meters', 'readings.meter_id', 'meters.id')
      .join('meter_types', 'readings.meter_type_id', 'meter_types.id')
      .leftJoin('meter_groups', 'meters.group_id', 'meter_groups.id');
    const suche = String(query.q || '').trim();
    if (suche) {
      q = q.where((b) => {
        b.where('meters.number', 'like', `%${suche}%`)
          .orWhere('meters.anzeige_bezeichnung', 'like', `%${suche}%`)
          .orWhere('readings.bemerkung', 'like', `%${suche}%`);
      });
    }
    if (query.gruppe) q = q.where('meters.group_id', Number(query.gruppe));
    if (query.zaehlerart) q = q.where('readings.meter_type_id', Number(query.zaehlerart));
    if (query.status) q = q.where('readings.status', query.status);
    if (query.messart === 'verbrauch' || query.messart === 'einspeisung') q = q.where('readings.strom_richtung', query.messart);
    if (query.messart === 'kwh' || query.messart === 'm3') q = q.where('readings.waerme_teil', query.messart);
    return q;
  }

  const [{ n: gesamt }] = await basisQuery().count('readings.id as n');
  const zeilen = await basisQuery()
    .select(
      'readings.*',
      'meters.number as meter_number',
      'meters.anzeige_bezeichnung',
      'meter_groups.name as group_name',
      'meter_types.label as type_label_name'
    )
    .orderBy(sortSpalte, order)
    .limit(MESSWERTE_SEITENGROESSE)
    .offset((seite - 1) * MESSWERTE_SEITENGROESSE);

  return {
    zeilen: zeilen.map((r) => ({ ...r, messart_label: messartLabel(r), zaehler_anzeige: r.group_name ? `${r.group_name} – ${r.anzeige_bezeichnung || r.type_label_name}` : (r.anzeige_bezeichnung || r.type_label_name) })),
    gesamt: Number(gesamt),
    seite,
    seiten: Math.max(1, Math.ceil(Number(gesamt) / MESSWERTE_SEITENGROESSE)),
  };
}

router.get('/messwerte', async (req, res) => {
  const ergebnis = await ladeMesswerteTabelle(req.query);
  const gruppen = await knex('meter_groups').orderBy('sort_order');
  const zaehlerarten = await knex('meter_types').orderBy('sort_order');
  res.render('admin/messwerte', {
    titel: 'Messwerte',
    ...ergebnis,
    gruppen,
    zaehlerarten,
    query: req.query,
    fehler: null,
    erfolg: req.query.geloescht ? 'Messwert gelöscht.' : (req.query.gespeichert ? 'Messwert gespeichert.' : null),
  });
});

// Laedt einen Messwert inkl. Zaehlerdaten fuer das Bearbeiten-Formular, sowie
// alle Zaehler (gruppiert) zur Auswahl, falls der Messwert einem anderen
// Zaehler zugeordnet werden soll.
async function ladeMesswertAdminAnsicht(id) {
  const reading = await knex('readings')
    .join('meters', 'readings.meter_id', 'meters.id')
    .join('meter_types', 'readings.meter_type_id', 'meter_types.id')
    .leftJoin('meter_groups', 'meters.group_id', 'meter_groups.id')
    .select('readings.*', 'meters.number as meter_number', 'meters.anzeige_bezeichnung', 'meter_groups.name as group_name', 'meter_types.label as type_label_name')
    .where('readings.id', id)
    .first();
  if (!reading) return null;
  const meters = await knex('meters')
    .join('meter_types', 'meters.meter_type_id', 'meter_types.id')
    .leftJoin('meter_groups', 'meters.group_id', 'meter_groups.id')
    .select('meters.id', 'meters.number', 'meters.anzeige_bezeichnung', 'meter_groups.name as group_name', 'meter_types.label as type_label_name')
    .orderBy(['meter_groups.sort_order', 'meters.number']);
  return { reading, meters };
}

router.get('/messwerte/:id/bearbeiten', async (req, res) => {
  const daten = await ladeMesswertAdminAnsicht(req.params.id);
  if (!daten) return res.status(404).render('fehler', { titel: 'Nicht gefunden', nachricht: 'Messwert nicht gefunden.' });
  res.render('admin/messwert_bearbeiten', { titel: 'Messwert bearbeiten', ...daten, fehler: null });
});

router.post('/messwerte/:id/bearbeiten', async (req, res) => {
  const daten = await ladeMesswertAdminAnsicht(req.params.id);
  if (!daten) return res.status(404).render('fehler', { titel: 'Nicht gefunden', nachricht: 'Messwert nicht gefunden.' });
  const { reading } = daten;
  try {
    const neuerMeterId = Number(req.body.meter_id) || reading.meter_id;
    const neuerMeter = await knex('meters').where({ id: neuerMeterId }).first();
    if (!neuerMeter) throw new Error('Unbekannter Zähler.');
    const neuerMeterType = await knex('meter_types').where({ id: neuerMeter.meter_type_id }).first();

    const wertErgebnis = parseMesswert(req.body.wert);
    if (!wertErgebnis.ok) throw new Error(wertErgebnis.fehler);

    const datumIso = parseDatumFlexibel(req.body.datum);
    if (!datumIso) throw new Error('Datum ungültig (erwartet TT.MM.JJJJ oder JJJJ-MM-TT).');
    const bisherigeZeit = new Date(reading.reading_at).toISOString().slice(11, 16);
    const neuesReadingAt = new Date(`${datumIso}T${bisherigeZeit}:00`).toISOString();

    const status = req.body.status === 'geschaetzt' ? 'geschaetzt' : 'abgelesen';

    let stromRichtung = null;
    let waermeTeil = null;
    const messart = String(req.body.messart || '').trim().toLowerCase();
    if (istStromTyp(neuerMeterType)) {
      if (!['verbrauch', 'einspeisung'].includes(messart)) throw new Error('Messart muss für diesen Zähler "verbrauch" oder "einspeisung" sein.');
      stromRichtung = messart;
    } else if (istWaermeKombiTyp(neuerMeterType)) {
      if (!['kwh', 'm3'].includes(messart)) throw new Error('Messart muss für diesen Zähler "kwh" oder "m3" sein.');
      waermeTeil = messart;
    } else if (messart) {
      throw new Error('Dieser Zähler kennt keine Messart - bitte Feld leer lassen.');
    }

    const bemerkung = String(req.body.bemerkung || '').trim() || null;
    const alt = { meter_id: reading.meter_id, value: Number(reading.value), reading_at: reading.reading_at, status: reading.status, messart: messartLabel(reading), bemerkung: reading.bemerkung };

    await knex('readings').where({ id: reading.id }).update({
      meter_id: neuerMeter.id,
      meter_type_id: neuerMeter.meter_type_id,
      value: wertErgebnis.value,
      unit: waermeTeil === 'm3' ? 'm³' : neuerMeter.unit,
      status,
      reading_at: neuesReadingAt,
      strom_richtung: stromRichtung,
      waerme_teil: waermeTeil,
      bemerkung,
    });
    await audit.log(req.user.id, 'messwert_bearbeitet', {
      reading_id: reading.id,
      alt,
      neu: { meter_id: neuerMeter.id, value: wertErgebnis.value, reading_at: neuesReadingAt, status, messart: messart || null, bemerkung },
    });
    res.redirect('/admin/messwerte?gespeichert=1');
  } catch (err) {
    console.error('Fehler in admin.js (Messwert bearbeiten):', err.message);
    res.status(400).render('admin/messwert_bearbeiten', { titel: 'Messwert bearbeiten', ...daten, fehler: err.message });
  }
});

router.post('/messwerte/:id/loeschen', async (req, res) => {
  const id = Number(req.params.id);
  const reading = await knex('readings').where({ id }).first();
  if (!reading) return res.redirect('/admin/messwerte');
  const fotos = await knex('photos').where({ reading_id: id }).select('filename');

  await knex('readings').where({ id }).del(); // FK CASCADE loescht photos/reading_corrections-Zeilen mit

  for (const f of fotos) {
    const dateipfad = path.join(config.UPLOADS_DIR, f.filename);
    if (fs.existsSync(dateipfad)) fs.unlinkSync(dateipfad);
  }

  await audit.log(req.user.id, 'messwert_geloescht_einzeln', {
    reading_id: id,
    meter_id: reading.meter_id,
    value: Number(reading.value),
    reading_at: reading.reading_at,
  });
  res.redirect('/admin/messwerte?geloescht=1');
});

// --- Audit-Protokoll (nur Admin, siehe Auftrag Abschnitt 5) -------------------
const AUDIT_LABELS = {
  messwert_erfasst: 'Messwert erfasst',
  messwert_bearbeitet: 'Messwert bearbeitet (Admin)',
  korrektur_vorgeschlagen: 'Korrektur vorgeschlagen',
  korrektur_genehmigt: 'Korrektur genehmigt',
  korrektur_abgelehnt: 'Korrektur abgelehnt',
  messwerte_geloescht: 'Messwerte gelöscht',
  messwert_geloescht_einzeln: 'Messwert einzeln gelöscht (Admin)',
  zaehler_angelegt: 'Zähler angelegt',
  zaehler_bearbeitet: 'Zähler bearbeitet',
  zaehlerwechsel: 'Zählerwechsel dokumentiert',
  zaehler_geloescht: 'Zähler gelöscht',
  zaehlerart_angelegt: 'Zählerart angelegt',
  zaehlerart_bearbeitet: 'Zählerart bearbeitet',
  zaehlerart_aktiviert: 'Zählerart aktiviert',
  zaehlerart_deaktiviert: 'Zählerart deaktiviert',
  zaehlerart_geloescht: 'Zählerart gelöscht',
  gruppe_angelegt: 'Zählergruppe angelegt',
  gruppe_bearbeitet: 'Zählergruppe bearbeitet',
  gruppe_aktiviert: 'Zählergruppe aktiviert',
  gruppe_deaktiviert: 'Zählergruppe deaktiviert',
  foto_geloescht: 'Foto gelöscht',
  benutzer_angelegt: 'Benutzerkonto angelegt',
  benutzer_aktiviert: 'Benutzerkonto aktiviert',
  benutzer_deaktiviert: 'Benutzerkonto deaktiviert',
  benutzer_passwort_zurueckgesetzt: 'Benutzerpasswort zurückgesetzt',
  benutzer_gruppenrechte_geaendert: 'Benutzer-Gruppenrechte geändert',
  ki_einstellungen_geaendert: 'KI-Einstellungen geändert',
  smtp_einstellungen_geaendert: 'SMTP-Einstellungen geändert',
  rechtliches_geaendert: 'Rechtliche Inhalte geändert',
  eichfrist_benachrichtigung: 'Eichfrist-Benachrichtigung versendet',
  export_json: 'Export (JSON)',
  export_csv: 'Export (CSV)',
  export_xlsx: 'Export (Excel)',
  import_uebernommen: 'Import übernommen',
  zaehler_export: 'Zähler-Stammdaten exportiert',
  zaehler_import_uebernommen: 'Zähler-Stammdaten-Import übernommen',
  reset_export_erzeugt: 'Reset-Export erzeugt',
  datenbank_zurueckgesetzt: 'Messdaten zurückgesetzt',
  api_lese_schluessel_erzeugt: 'Lese-API: Schlüssel erzeugt',
  api_lese_aktiviert: 'Lese-API aktiviert',
  api_lese_deaktiviert: 'Lese-API deaktiviert',
  api_lese_widerrufen: 'Lese-API: Schlüssel widerrufen',
  api_lese_zugriff: 'Lese-API: Zugriff',
  api_lese_fehlgeschlagen: 'Lese-API: Zugriff fehlgeschlagen',
  db_wechsel_verbindung_getestet: 'Datenbankwechsel: Verbindung getestet',
  db_wechsel_test_fehlgeschlagen: 'Datenbankwechsel: Verbindungstest fehlgeschlagen',
  db_wechsel_export_erzeugt: 'Datenbankwechsel: Backup erzeugt',
  db_wechsel_migriert: 'Datenbankwechsel: migriert',
  db_wechsel_uebernommen: 'Datenbankwechsel: übernommen (.env aktualisiert)',
  db_wechsel_alte_sqlite_entfernt: 'Datenbankwechsel: alte SQLite-Datei entfernt',
  vollbackup_erzeugt: 'Vollbackup erzeugt',
  vollbackup_restore_vorbereitet: 'Wiederherstellung vorbereitet (Vorschau + Sicherheitskopie)',
  vollbackup_restore_angewendet: 'Wiederherstellung angewendet',
  vollbackup_restore_fehlgeschlagen: 'Wiederherstellung fehlgeschlagen',
};

router.get('/audit', async (req, res) => {
  const eintraege = await knex('audit_log')
    .leftJoin('users', 'audit_log.user_id', 'users.id')
    .select('audit_log.*', 'users.email as user_email')
    .orderBy('audit_log.created_at', 'desc')
    .limit(300);
  res.render('admin/audit', { titel: 'Audit-Protokoll', eintraege, auditLabels: AUDIT_LABELS });
});

// --- Administratives Zuruecksetzen -------------------------------------------
// Ablauf in zwei getrennten, ausdruecklichen Schritten (kein Loeschen durch
// blossen Seitenaufruf): 1) Export erzeugen + herunterladen, 2) textuelle
// Bestaetigung. Ohne heruntergeladenen Export und exakte Bestaetigung passiert
// nichts. Zurueckgesetzt werden Messdaten (Zaehler, Messwerte, Fotos) - Konten,
// Zaehlerarten-Konfiguration und Einstellungen bleiben erhalten (Dokumentation
// in README, bewusste Entscheidung: ein versehentlich geleertes Admin-Konto
// waere nicht wiederherstellbar).
const ausstehendeResets = new Map();
const BESTAETIGUNGSTEXT = 'DATEN LOESCHEN';

router.get('/reset', (req, res) => {
  res.render('admin/reset', { titel: 'Datenbank zurücksetzen', token: null, heruntergeladen: false, fehler: null, bestaetigungstext: BESTAETIGUNGSTEXT });
});

router.post('/reset/export', async (req, res) => {
  const alle = await daten.gatherAll();
  const inhalt = JSON.stringify(alle, null, 2);
  const token = crypto.randomUUID();
  const dateiname = `reset-export-${Date.now()}.json`;
  const pfad = path.join(config.EXPORTS_DIR, dateiname);
  fs.mkdirSync(config.EXPORTS_DIR, { recursive: true });
  fs.writeFileSync(pfad, inhalt);
  ausstehendeResets.set(token, { pfad, erzeugtVon: req.user.id, erzeugtAm: Date.now(), heruntergeladen: false });
  await audit.log(req.user.id, 'reset_export_erzeugt', { token });
  res.render('admin/reset', { titel: 'Datenbank zurücksetzen', token, heruntergeladen: false, fehler: null, bestaetigungstext: BESTAETIGUNGSTEXT });
});

router.get('/reset/download/:token', (req, res) => {
  const eintrag = ausstehendeResets.get(req.params.token);
  if (!eintrag) return res.status(404).render('fehler', { titel: 'Abgelaufen', nachricht: 'Dieser Export ist nicht mehr verfügbar - bitte neu erzeugen.' });
  eintrag.heruntergeladen = true;
  res.download(eintrag.pfad, 'zaehlerstandsermittlung-export-vor-reset.json');
});

router.post('/reset/bestaetigen', async (req, res) => {
  const token = req.body.token;
  const eintrag = ausstehendeResets.get(token);
  const text = String(req.body.bestaetigungstext || '');

  if (!eintrag || !eintrag.heruntergeladen) {
    return res.status(400).render('admin/reset', { titel: 'Datenbank zurücksetzen', token: token || null, heruntergeladen: false, fehler: 'Bitte zuerst den Export erzeugen UND herunterladen.', bestaetigungstext: BESTAETIGUNGSTEXT });
  }
  if (text !== BESTAETIGUNGSTEXT) {
    return res.status(400).render('admin/reset', { titel: 'Datenbank zurücksetzen', token, heruntergeladen: true, fehler: `Bitte exakt "${BESTAETIGUNGSTEXT}" eingeben.`, bestaetigungstext: BESTAETIGUNGSTEXT });
  }

  const [{ n: anzahlMesswerte }] = await knex('readings').count('id as n');
  const [{ n: anzahlZaehler }] = await knex('meters').count('id as n');

  await knex.transaction(async (trx) => {
    await trx('photos').del();
    await trx('readings').del();
    await trx('meters').del();
  });

  const uploadsDir = config.UPLOADS_DIR;
  for (const f of fs.readdirSync(uploadsDir)) {
    if (f === 'tmp') continue;
    fs.unlinkSync(path.join(uploadsDir, f));
  }

  ausstehendeResets.delete(token);
  await audit.log(req.user.id, 'datenbank_zurueckgesetzt', { anzahlMesswerte, anzahlZaehler });
  res.render('fehler', { titel: 'Zurückgesetzt', nachricht: `Messdaten wurden geleert (${anzahlZaehler} Zähler, ${anzahlMesswerte} Messwerte). Export liegt unter data/exports/.` });
});

module.exports = router;
