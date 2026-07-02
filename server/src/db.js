'use strict';

const mysql = require('mysql2/promise');
const config = require('./config');

// Single shared connection pool for the whole app.
const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: config.db.connectionLimit,
  waitForConnections: true,
  queueLimit: 0,
  namedPlaceholders: true,
  timezone: 'Z', // store/read everything in UTC
  charset: 'utf8mb4',
});

// Thin helpers so routes don't deal with the [rows, fields] tuple.
async function query(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function execute(sql, params) {
  const [result] = await pool.execute(sql, params);
  return result;
}

async function getConnection() {
  return pool.getConnection();
}

module.exports = { pool, query, execute, getConnection };
