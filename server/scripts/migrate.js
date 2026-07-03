'use strict';

// Applies db/schema.sql. Creates the database if it doesn't exist yet.
//   npm run migrate

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

async function main() {
  const schemaPath = path.resolve(__dirname, '../../db/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  // Connect without selecting a database so we can create it first.
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  });

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.query(`USE \`${config.db.database}\``);
  await conn.query(sql);
  console.log(`Schema applied to database "${config.db.database}".`);

  // Idempotent upgrades for databases created before a column/index existed.
  // (CREATE TABLE IF NOT EXISTS above won't alter an already-present table.)
  const db = config.db.database;
  const hasColumn = async (table, column) => {
    const [r] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
      [db, table, column]
    );
    return r[0].n > 0;
  };
  const hasIndex = async (table, index) => {
    const [r] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.statistics
        WHERE table_schema = ? AND table_name = ? AND index_name = ?`,
      [db, table, index]
    );
    return r[0].n > 0;
  };
  const ensureColumn = async (table, column, ddl) => {
    if (!(await hasColumn(table, column))) {
      await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
      console.log(`  + ${table}.${column}`);
    }
  };
  const ensureIndex = async (table, index, ddl) => {
    if (!(await hasIndex(table, index))) {
      await conn.query(`ALTER TABLE \`${table}\` ADD ${ddl}`);
      console.log(`  + index ${table}.${index}`);
    }
  };

  // Redial / multi-attempt columns.
  await ensureColumn('campaigns', 'max_attempts', 'max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER max_concurrent');
  await ensureColumn('campaigns', 'retry_delay_min', 'retry_delay_min INT UNSIGNED NOT NULL DEFAULT 0 AFTER max_attempts');
  await ensureColumn('campaigns', 'retry_on', "retry_on VARCHAR(64) NOT NULL DEFAULT 'busy,no_answer,congestion,failed' AFTER retry_delay_min");
  await ensureColumn('campaigns', 'amd_enabled', 'amd_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER retry_on');
  // Records how the current run was launched: NULL = first run, 'all' = redial
  // everyone, 'unreached' = redial only the chosen not-reached outcomes.
  await ensureColumn('campaigns', 'rerun_scope', 'rerun_scope VARCHAR(16) NULL AFTER amd_enabled');
  await ensureColumn('call_logs', 'next_attempt_at', 'next_attempt_at DATETIME NULL AFTER attempts');
  // 1 = this number is part of the current run; 0 = excluded (e.g. an already-
  // reached number skipped by a "redial unreached" run). Lets the monitor/list
  // count and pace off just the numbers being dialed now.
  await ensureColumn('call_logs', 'in_run', 'in_run TINYINT(1) NOT NULL DEFAULT 1 AFTER status');
  // Lifetime dial counter — increments on every dial and is NEVER reset by a
  // redial (unlike `attempts`, which is per-run). Powers the reports "Total
  // dials" column and the lifetime dial cap that stops over-redialing a number.
  await ensureColumn('call_logs', 'total_dials', 'total_dials INT UNSIGNED NOT NULL DEFAULT 0 AFTER attempts');
  await ensureIndex('call_logs', 'idx_calllogs_queue', 'KEY idx_calllogs_queue (campaign_id, status, next_attempt_at)');

  console.log('Migration complete.');
  await conn.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
