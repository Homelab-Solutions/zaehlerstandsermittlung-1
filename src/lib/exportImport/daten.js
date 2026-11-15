const knex = require('../../db/knex');

// Sammelt alle fachlichen Daten (ohne Passwort-Hashes und ohne entschluesselte
// Geheimnisse) fuer Export bzw. den Pflicht-Export vor dem Zuruecksetzen.
async function gatherAll() {
  const [meterTypes, meterGroups, meters, readings, photos, users, userGroupPermissions, auditLog] = await Promise.all([
    knex('meter_types').select('*').orderBy('sort_order'),
    knex('meter_groups').select('*').orderBy('sort_order'),
    knex('meters').select('*').orderBy('id'),
    knex('readings').select('*').orderBy('reading_at'),
    knex('photos').select('id', 'filename', 'original_name', 'mime', 'size', 'reading_id', 'created_by', 'created_at'),
    knex('users').select('id', 'email', 'role', 'active', 'created_at'),
    knex('user_group_permissions').select('*'),
    knex('audit_log').select('*').orderBy('created_at'),
  ]);
  return {
    erzeugt_am: new Date().toISOString(),
    meter_types: meterTypes,
    meter_groups: meterGroups,
    meters,
    readings,
    photos,
    users,
    user_group_permissions: userGroupPermissions,
    audit_log: auditLog,
  };
}

module.exports = { gatherAll };
