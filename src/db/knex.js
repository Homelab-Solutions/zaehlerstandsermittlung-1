const path = require('path');
const fs = require('fs');
const config = require('../config');

function buildKnexConfig() {
  if (config.DB_DRIVER === 'mariadb') {
    const m = config.mariadb;
    return {
      client: 'mysql2',
      connection: {
        host: m.host,
        port: m.port,
        user: m.user,
        password: m.password,
        database: m.database,
        timezone: 'Z',
        decimalNumbers: true,
      },
      pool: { min: 0, max: 10 },
      migrations: { directory: path.join(__dirname, 'migrations') },
    };
  }
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  return {
    client: 'better-sqlite3',
    connection: { filename: config.SQLITE_FILE },
    useNullAsDefault: true,
    pool: {
      afterCreate: (conn, done) => {
        conn.pragma('journal_mode = WAL');
        conn.pragma('foreign_keys = ON');
        done();
      },
    },
    migrations: { directory: path.join(__dirname, 'migrations') },
  };
}

const knex = require('knex')(buildKnexConfig());

module.exports = knex;
