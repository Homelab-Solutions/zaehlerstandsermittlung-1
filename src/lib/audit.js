const knex = require('../db/knex');

async function log(userId, action, details) {
  try {
    await knex('audit_log').insert({
      user_id: userId || null,
      action,
      details: details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
    });
  } catch (err) {
    // Audit darf den eigentlichen Vorgang nie verhindern.
    console.error('Audit-Log fehlgeschlagen:', err.message);
  }
}

module.exports = { log };
