const DEFAULT_METER_TYPES = [
  { key: 'kaltwasser_haus', label: 'Kaltwasser Haus', unit: 'm³' },
  { key: 'warmwasser_gesamt', label: 'Warmwasser gesamt', unit: 'm³' },
  { key: 'heizung_gesamt_kwh', label: 'Heizung gesamt kWh', unit: 'kWh' },
  { key: 'heizung_gesamt_m3', label: 'Heizung gesamt m³', unit: 'm³' },
  { key: 'gas_gesamt', label: 'Gasverbrauch gesamt', unit: 'm³' },
  { key: 'heizungsstrom_gesamt', label: 'Heizungsstrom gesamt', unit: 'kWh' },
  { key: 'heizungsanlage_kwh', label: 'Heizungsanlage kWh', unit: 'kWh' },
  { key: 'kaltwasser_mietwohnung', label: 'Kaltwasser Mietwohnung', unit: 'm³' },
  { key: 'warmwasser_mietwohnung', label: 'Warmwasser Mietwohnung', unit: 'm³' },
  { key: 'heizung_mietwohnung_kwh', label: 'Heizung Mietwohnung kWh', unit: 'kWh' },
  { key: 'heizung_mietwohnung_m3', label: 'Heizung Mietwohnung m³', unit: 'm³' },
  { key: 'strom_mietwohnung', label: 'Strom Mietwohnung', unit: 'kWh' },
];

const DEFAULT_RECHT_IMPRESSUM = `Angaben gemäß § 5 TMG (Platzhalter - bitte durch echte Angaben ersetzen)

Max Mustermann
Musterstraße 1
12345 Musterstadt

Kontakt:
E-Mail: kontakt@example.com

Hinweis: Dieser Text ist eine unausgefüllte Vorlage und keine Rechtsberatung. Bitte vor Veröffentlichung durch die tatsächlichen Angaben des Betreibers ersetzen und bei Bedarf rechtlich prüfen lassen.`;

const DEFAULT_RECHT_DATENSCHUTZ = `Datenschutzhinweise (Platzhalter - bitte prüfen und anpassen)

Verantwortlicher:
Max Mustermann, Musterstraße 1, 12345 Musterstadt, kontakt@example.com

Diese Anwendung wird vom Betreiber selbst gehostet (kein externes Hosting durch Dritte, sofern unten nichts anderes genannt ist).

Welche Daten verarbeitet werden:
- Zählerstände (Messwerte) und optional dazu hochgeladene Zählerfotos der angelegten Zähler.
- Zugangsdaten angelegter Benutzerkonten (E-Mail-Adresse, Passwort-Hash).
- IP-Adressen werden zur Ratenbegrenzung beim Login sowie bei Zugriffen auf die externe Lese-API verarbeitet (bei der Lese-API zusätzlich knapp im Audit-Protokoll vermerkt); darüber hinaus erfolgt keine dauerhafte IP-Speicherung durch diese Anwendung selbst.
- Ein technisch notwendiges Session-Cookie zur Anmeldung (siehe Abschnitt "Cookies" auf der Seite "Rechtliches").

Zweck: Erfassung und Auswertung von Zählerständen für die interne Verwaltung des Objekts.

Speicherdauer: Messwerte, Fotos und Benutzerkonten werden gespeichert, bis sie durch einen Administrator gelöscht werden; es ist keine automatische Löschfrist eingerichtet.

Empfänger/Weitergabe:
- Ist die optionale KI-Fotoerkennung durch einen Administrator aktiviert und konfiguriert, werden hochgeladene Zählerfotos zur Analyse an den dort hinterlegten Anbieter (OpenAI-kompatibler Dienst, Anthropic-API oder ein selbst betriebener Ollama-Server) übertragen.
- Ist der E-Mail-Versand (SMTP) aktiviert, werden Benachrichtigungen (z. B. zu Eichfristen oder neuen Messwerten) an die vom Administrator hinterlegten Empfängeradressen über den konfigurierten SMTP-Server versendet.
- Ist die externe Lese-API aktiviert, kann ein vom Administrator autorisiertes externes Programm lesend auf Zähler- und Messwertdaten zugreifen.
- Ohne diese optionalen Funktionen findet keine Weitergabe an Dritte statt.

Betroffenenrechte: Auskunft, Berichtigung, Löschung und Einschränkung der Verarbeitung können beim oben genannten Verantwortlichen geltend gemacht werden.

Hinweis: Dieser Text ist eine Vorlage und keine Rechtsberatung. Bitte vor Veröffentlichung prüfen und an die tatsächlichen Gegebenheiten anpassen.`;

const DEFAULT_RECHT_SONSTIGES = `Ergänzende Hinweise (Platzhalter)

Hier können weitere Pflicht- oder Zusatzinformationen ergänzt werden, z. B. zu einer Haftungsbeschränkung oder zu Nutzungsbedingungen. Dieser Abschnitt ist optional und kann leer bleiben.`;


const DEFAULT_SETTINGS = {
  ai_enabled: 'false',
  ai_provider: 'openai_compatible',
  ai_base_url: '',
  ai_model: '',
  ai_api_key_enc: '',
  ai_timeout_seconds: '30',
  smtp_enabled: 'false',
  smtp_host: '',
  smtp_port: '587',
  smtp_secure_mode: 'starttls', // 'none' | 'starttls' | 'tls'
  smtp_user: '',
  smtp_password_enc: '',
  smtp_from: '',
  notify_eichfrist_days_before: '30',
  notify_recipients: '',
  // Eigene Empfaengerliste fuer neue Messwerte, unabhaengig von den
  // Eichfrist-Empfaengern oben (Auftrag Abschnitt 5).
  notify_messwert_enabled: 'false',
  notify_messwert_recipients: '',
  api_lese_enabled: 'false',
  api_lese_key_hash: '',
  api_lese_key_created_at: '',
  api_lese_key_last_used_at: '',
  // Editierbare Rechtstexte-Vorlagen (Auftrag Abschnitt 7) - Admin kann sie
  // unter /admin/rechtliches ueberschreiben; Platzhalter sind bewusst klar
  // als solche erkennbar, es wird nirgends behauptet, die Texte seien
  // rechtlich geprueft.
  recht_impressum: DEFAULT_RECHT_IMPRESSUM,
  recht_datenschutz: DEFAULT_RECHT_DATENSCHUTZ,
  recht_sonstiges: DEFAULT_RECHT_SONSTIGES,
};

async function ensureMeterTypes(knex) {
  for (let i = 0; i < DEFAULT_METER_TYPES.length; i++) {
    const mt = DEFAULT_METER_TYPES[i];
    const existing = await knex('meter_types').where({ key: mt.key }).first();
    if (!existing) {
      await knex('meter_types').insert({ ...mt, sort_order: i, active: true });
    }
  }
}

const DEFAULT_GROUPS = ['Haupthaus', 'Mietwohnung'];

// Legt die im Auftrag genannten Standardgruppen an, falls noch keine Gruppe
// dieses Namens existiert - greift insbesondere bei einer frischen Installation
// ohne Bestandszaehler (die Migration selbst legt die Gruppen nur an, wenn es
// bereits Zaehler zuzuordnen gibt, siehe deren Kommentar).
async function ensureMeterGroups(knex) {
  for (let i = 0; i < DEFAULT_GROUPS.length; i++) {
    const name = DEFAULT_GROUPS[i];
    const existing = await knex('meter_groups').where({ name }).first();
    if (!existing) {
      await knex('meter_groups').insert({ name, sort_order: i, active: true });
    }
  }
}

async function ensureSettings(knex) {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const existing = await knex('settings').where({ key }).first();
    if (!existing) {
      await knex('settings').insert({ key, value });
    }
  }
}

async function runSeeds(knex) {
  await ensureMeterTypes(knex);
  await ensureMeterGroups(knex);
  await ensureSettings(knex);
}

module.exports = { runSeeds, DEFAULT_METER_TYPES, DEFAULT_SETTINGS, DEFAULT_GROUPS };
