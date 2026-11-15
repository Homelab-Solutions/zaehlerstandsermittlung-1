const knex = require('../db/knex');
const settings = require('./settings');
const mailer = require('./mailer');
const audit = require('./audit');
const config = require('../config');

const TAG_MS = 24 * 60 * 60 * 1000;

// Prueft faellige/bald faellige Eichfristen und verschickt je Zaehler maximal
// eine Benachrichtigung pro Frist (eichfrist_notified_at). Mailfehler duerfen
// den Rest der App nie beeintraechtigen.
async function pruefeEichfristen() {
  try {
    const cfg = await settings.getSmtpConfig();
    if (!cfg.enabled || cfg.notifyRecipients.length === 0) return;

    const grenze = new Date(Date.now() + cfg.notifyDaysBefore * TAG_MS);
    const meters = await knex('meters')
      .join('meter_types', 'meters.meter_type_id', 'meter_types.id')
      .select('meters.*', 'meter_types.label as type_label_name')
      .where('meters.active', true)
      .where('meters.eichfrist_benachrichtigen', true)
      .whereNotNull('meters.eich_frist');

    const faellig = meters.filter((m) => new Date(m.eich_frist) <= grenze);
    const nochNichtBenachrichtigt = faellig.filter((m) => {
      if (!m.eichfrist_notified_at) return true;
      // erneut benachrichtigen, falls die Eichfrist seit der letzten Meldung
      // geaendert wurde (z. B. nach Zaehlertausch)
      return new Date(m.eichfrist_notified_at) < new Date(m.updated_at);
    });

    if (nochNichtBenachrichtigt.length === 0) return;

    const heute = new Date().toISOString().slice(0, 10);
    const zeilen = nochNichtBenachrichtigt.map((m) => {
      const abgelaufen = new Date(m.eich_frist) < new Date();
      return `- ${m.type_label_name} (Zaehler ${m.number}): Eichfrist ${m.eich_frist} (${abgelaufen ? 'ABGELAUFEN' : 'faellig in Kuerze'})`;
    });
    const text = `Stand ${heute}:\n\n${zeilen.join('\n')}\n\nBitte Eichung/Austausch veranlassen.`;

    for (const empfaenger of cfg.notifyRecipients) {
      const result = await mailer.sendMail({ to: empfaenger, subject: `[${config.PRODUCT_NAME}] Eichfristen fällig`, text });
      if (!result.ok) {
        console.error('Eichfrist-Benachrichtigung fehlgeschlagen:', result.fehler);
      }
    }

    const ids = nochNichtBenachrichtigt.map((m) => m.id);
    await knex('meters').whereIn('id', ids).update({ eichfrist_notified_at: knex.fn.now() });
    await audit.log(null, 'eichfrist_benachrichtigung', { anzahl: ids.length });
  } catch (err) {
    console.error('Eichfrist-Pruefung fehlgeschlagen:', err.message);
  }
}

function start() {
  setTimeout(pruefeEichfristen, 15000);
  setInterval(pruefeEichfristen, TAG_MS);
}

module.exports = { start, pruefeEichfristen };
