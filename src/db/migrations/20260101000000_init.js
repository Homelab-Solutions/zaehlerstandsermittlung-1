exports.up = async function up(knex) {
  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('email', 190).notNullable().unique();
    t.string('password_hash', 255).notNullable();
    t.string('role', 20).notNullable().defaultTo('user'); // 'admin' | 'user'
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('meter_types', (t) => {
    t.increments('id').primary();
    t.string('key', 60).notNullable().unique();
    t.string('label', 120).notNullable();
    t.string('unit', 20).notNullable();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
  });

  await knex.schema.createTable('meters', (t) => {
    t.increments('id').primary();
    t.integer('meter_type_id').unsigned().notNullable()
      .references('id').inTable('meter_types').onDelete('RESTRICT');
    t.string('number', 120).notNullable(); // Zaehlernummer
    t.string('manufacturer', 120);
    t.string('messbetreiber', 120);
    t.string('type_label', 120); // Typ/Bezeichnung
    t.string('unit', 20).notNullable();
    t.date('eich_datum');
    t.date('eich_frist');
    t.date('einbau_datum');
    t.date('ausbau_datum');
    t.text('bemerkung');
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('eichfrist_notified_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('readings', (t) => {
    t.increments('id').primary();
    t.integer('meter_id').unsigned().notNullable()
      .references('id').inTable('meters').onDelete('RESTRICT');
    t.integer('meter_type_id').unsigned().notNullable()
      .references('id').inTable('meter_types').onDelete('RESTRICT');
    t.timestamp('reading_at').notNullable();
    t.decimal('value', 14, 3).notNullable();
    t.string('unit', 20).notNullable();
    t.string('status', 20).notNullable().defaultTo('abgelesen'); // 'abgelesen' | 'geschaetzt'
    t.boolean('is_ausbau_reading').notNullable().defaultTo(false);
    t.text('bemerkung');
    t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['meter_id', 'reading_at']);
    t.index(['meter_type_id', 'reading_at']);
  });

  await knex.schema.createTable('photos', (t) => {
    t.increments('id').primary();
    t.string('filename', 255).notNullable();
    t.string('original_name', 255);
    t.string('mime', 100);
    t.integer('size');
    t.integer('reading_id').unsigned().references('id').inTable('readings').onDelete('CASCADE');
    t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('settings', (t) => {
    t.string('key', 100).primary();
    t.text('value');
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('audit_log', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.string('action', 100).notNullable();
    t.text('details');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['created_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('audit_log');
  await knex.schema.dropTableIfExists('settings');
  await knex.schema.dropTableIfExists('photos');
  await knex.schema.dropTableIfExists('readings');
  await knex.schema.dropTableIfExists('meters');
  await knex.schema.dropTableIfExists('meter_types');
  await knex.schema.dropTableIfExists('users');
};
