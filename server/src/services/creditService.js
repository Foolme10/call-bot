'use strict';

const db = require('../db');
const logger = require('../logger');

// ───────────────────────────────────────────────────────────────────────────
// Prepaid SMS credit accounting.
//
//   company pool  ──allocate──▶  user wallet  ──spend──▶  (sent SMS)
//        ▲                            │
//     top up                     deallocate (claw-back)
//
// The pool and each user's wallet are explicit balances, mutated inside DB
// transactions alongside a ledger row so the two never drift. Per-message
// spend/refund on the hot send path are single atomic UPDATEs (no ledger row
// each — a summary 'spend' row is written when a campaign finishes).
// ───────────────────────────────────────────────────────────────────────────

async function getPool() {
  const [row] = await db.query('SELECT balance FROM credit_pool WHERE id = 1');
  return row ? Number(row.balance) : 0;
}

async function getUserBalance(userId) {
  const [row] = await db.query('SELECT credit_balance FROM users WHERE id = :id', { id: userId });
  return row ? Number(row.credit_balance) : 0;
}

// Run `fn(conn)` inside a transaction, committing on success and rolling back on
// any error. Returns fn's result.
async function inTransaction(fn) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    try {
      await conn.rollback();
    } catch (_e) {
      /* ignore */
    }
    throw e;
  } finally {
    conn.release();
  }
}

function assertPositiveInt(amount) {
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error('Amount must be a positive whole number');
    err.status = 400;
    throw err;
  }
  return n;
}

// Vendor records a purchase: increase the company pool.
async function topUp(amount, actorId, note) {
  const n = assertPositiveInt(amount);
  return inTransaction(async (conn) => {
    await conn.execute('UPDATE credit_pool SET balance = balance + :n WHERE id = 1', { n });
    await conn.execute(
      'INSERT INTO credit_transactions (kind, amount, note, actor_id) VALUES (:kind, :amount, :note, :actor)',
      { kind: 'topup', amount: n, note: note || null, actor: actorId || null }
    );
    const [[pool]] = await conn.query('SELECT balance FROM credit_pool WHERE id = 1');
    logger.info(`Credits: topup ${n} (pool now ${pool.balance})`);
    return { pool: Number(pool.balance) };
  });
}

// Move credits from the pool into a user's wallet. Fails if the pool is short.
async function allocate(userId, amount, actorId, note) {
  const n = assertPositiveInt(amount);
  return inTransaction(async (conn) => {
    const [dr] = await conn.execute(
      'UPDATE credit_pool SET balance = balance - :n WHERE id = 1 AND balance >= :n',
      { n }
    );
    if (dr.affectedRows === 0) {
      const err = new Error('Not enough credits in the company pool');
      err.status = 400;
      throw err;
    }
    const [ur] = await conn.execute(
      "UPDATE users SET credit_balance = credit_balance + :n WHERE id = :id AND role = 'user'",
      { n, id: userId }
    );
    if (ur.affectedRows === 0) {
      const err = new Error('User not found (or is an admin, which needs no wallet)');
      err.status = 404;
      throw err;
    }
    await conn.execute(
      'INSERT INTO credit_transactions (kind, user_id, amount, note, actor_id) VALUES (:kind, :id, :amount, :note, :actor)',
      { kind: 'allocate', id: userId, amount: n, note: note || null, actor: actorId || null }
    );
    const [[pool]] = await conn.query('SELECT balance FROM credit_pool WHERE id = 1');
    const [[u]] = await conn.query('SELECT credit_balance FROM users WHERE id = :id', { id: userId });
    return { pool: Number(pool.balance), userBalance: Number(u.credit_balance) };
  });
}

// Pull unused credits back from a user's wallet into the pool.
async function deallocate(userId, amount, actorId, note) {
  const n = assertPositiveInt(amount);
  return inTransaction(async (conn) => {
    const [ur] = await conn.execute(
      "UPDATE users SET credit_balance = credit_balance - :n WHERE id = :id AND role = 'user' AND credit_balance >= :n",
      { n, id: userId }
    );
    if (ur.affectedRows === 0) {
      const err = new Error("User not found or doesn't have that many credits to reclaim");
      err.status = 400;
      throw err;
    }
    await conn.execute('UPDATE credit_pool SET balance = balance + :n WHERE id = 1', { n });
    await conn.execute(
      'INSERT INTO credit_transactions (kind, user_id, amount, note, actor_id) VALUES (:kind, :id, :amount, :note, :actor)',
      { kind: 'deallocate', id: userId, amount: n, note: note || null, actor: actorId || null }
    );
    const [[pool]] = await conn.query('SELECT balance FROM credit_pool WHERE id = 1');
    const [[u]] = await conn.query('SELECT credit_balance FROM users WHERE id = :id', { id: userId });
    return { pool: Number(pool.balance), userBalance: Number(u.credit_balance) };
  });
}

// Hot path: atomically take `amount` credits from a user's wallet for a send.
// Returns true if it succeeded, false if the wallet couldn't cover it (caller
// should then stop the campaign). No ledger row per message.
async function charge(userId, amount) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  if (n === 0) return true;
  const r = await db.execute(
    'UPDATE users SET credit_balance = credit_balance - :n WHERE id = :id AND credit_balance >= :n',
    { n, id: userId }
  );
  return r.affectedRows > 0;
}

// Hot path: return credits to a wallet (e.g. a send the gateway rejected, so no
// credit was actually consumed).
async function refund(userId, amount) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  if (n === 0) return;
  await db.execute('UPDATE users SET credit_balance = credit_balance + :n WHERE id = :id', {
    n,
    id: userId,
  });
}

// Write a single summary ledger row for what a campaign spent (called when it
// finishes). The wallet was already debited per-message; this is for the audit
// trail only.
async function recordSpend(userId, campaignId, amount, note) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  if (n === 0 || !userId) return;
  await db
    .execute(
      'INSERT INTO credit_transactions (kind, user_id, campaign_id, amount, note) VALUES (:kind, :uid, :cid, :amount, :note)',
      { kind: 'spend', uid: userId, cid: campaignId || null, amount: n, note: note || null }
    )
    .catch((e) => logger.error('Credit spend ledger write failed:', e.message));
}

// Admin views.
async function listUsers() {
  return db.query(
    `SELECT id, username, full_name, role, is_active, credit_balance
       FROM users ORDER BY role DESC, username ASC`
  );
}

async function listTransactions(limit = 100) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  return db.query(
    `SELECT t.id, t.kind, t.amount, t.note, t.created_at, t.campaign_id,
            u.username AS user, a.username AS actor
       FROM credit_transactions t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN users a ON a.id = t.actor_id
      ORDER BY t.id DESC LIMIT :lim`,
    { lim }
  );
}

module.exports = {
  getPool,
  getUserBalance,
  topUp,
  allocate,
  deallocate,
  charge,
  refund,
  recordSpend,
  listUsers,
  listTransactions,
};
