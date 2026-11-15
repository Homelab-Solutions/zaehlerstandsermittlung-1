const knex = require('../db/knex');

// Gruppenrechte steuern ausschliesslich, fuer welche Zaehlergruppen ein
// Benutzer (Rolle "user") Messwerte erfassen darf (Auftrag "Zaehlergruppen und
// Berechtigungen") - Admins duerfen immer alles, unabhaengig von Eintraegen in
// user_group_permissions. Ein Zaehler ohne Gruppe (group_id NULL, z. B. ein
// noch nicht zugeordneter Bestandszaehler) kann aus Sicherheitsgruenden
// serverseitig bewusst NUR von Admins erfasst werden (fail-closed), statt ihn
// implizit fuer alle freizugeben.

async function erlaubteGruppenIds(user) {
  if (!user) return [];
  if (user.role === 'admin') {
    return knex('meter_groups').pluck('id');
  }
  return knex('user_group_permissions').where({ user_id: user.id }).pluck('group_id');
}

// Prueft serverseitig, ob der Benutzer fuer GENAU diesen Zaehler (bzw. dessen
// Gruppe) einen Messwert erfassen darf. Wird sowohl beim Formular-Aufbau
// (Filterung der auswaehlbaren Zaehler) als auch beim Speichern verwendet.
async function darfMesswertErfassen(user, meter) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!meter || !meter.group_id) return false;
  const erlaubt = await knex('user_group_permissions').where({ user_id: user.id, group_id: meter.group_id }).first();
  return Boolean(erlaubt);
}

module.exports = { erlaubteGruppenIds, darfMesswertErfassen };
