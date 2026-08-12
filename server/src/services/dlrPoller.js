'use strict';

const config = require('../config');
const logger = require('../logger');
const db = require('../db');
const smsProvider = require('./smsProvider');

// ───────────────────────────────────────────────────────────────────────────
// Delivery-report poller.
//
// A message that was accepted by the gateway shows as 'sent' in call_logs, with
// its gateway msgid in provider_msgid. That only means "accepted", not
// "delivered". This poller periodically asks the gateway's get-dlr endpoint what
// actually happened to each accepted message and records the result:
//   dlr_status = pending | delivered | failed   (folded from the raw dlr_state)
//
// It keeps chasing a message while it's 'pending' (or not yet reported), and
// stops once the message is older than SMS_DLR_MAX_AGE_HOURS — carriers stop
// updating stale reports, so there's nothing more to learn.
// ───────────────────────────────────────────────────────────────────────────

let timer = null;
let busy = false;

// ISO timestamp (possibly with a timezone offset, e.g. "…+08:00") → a MySQL
// UTC 'YYYY-MM-DD HH:MM:SS' string. Returns null if unparseable.
function toMysqlUtc(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Apply one DLR result to its row (matched by the globally-unique msgid).
async function applyDlr(m) {
  await db.execute(
    `UPDATE call_logs
        SET dlr_status = :bucket,
            dlr_state = :state,
            dlr_detail = :detail,
            dlr_credits = :credits,
            dlr_updated_at = COALESCE(:updatedAt, dlr_updated_at, UTC_TIMESTAMP())
      WHERE provider_msgid = :msgid`,
    {
      bucket: m.bucket,
      state: m.state,
      detail: m.detail,
      credits: m.credits,
      updatedAt: toMysqlUtc(m.updatedAt),
      msgid: m.msgid,
    }
  );
}

// Fetch + apply DLRs for a list of {id, provider_msgid} rows, in gateway-sized
// batches. Returns how many rows were updated. Never throws.
async function processRows(rows) {
  const batchSize = config.sms.dlrBatch;
  let updated = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const ids = chunk.map((r) => r.provider_msgid);
    const res = await smsProvider.fetchDlr(ids);
    if (!res.ok) {
      logger.warn(`DLR batch failed (${ids.length} msgids): ${res.detail}`);
      continue; // leave these rows for the next poll
    }
    for (const m of res.messages) {
      try {
        await applyDlr(m);
        updated += 1;
      } catch (e) {
        logger.error(`DLR apply ${m.msgid} failed: ${e.message}`);
      }
    }
  }
  return updated;
}

// Rows still worth polling for a DLR: accepted ('sent') with a msgid, not yet in
// a terminal DLR bucket. `scope` limits by age (the background sweep) or by
// campaign (a manual refresh, which ignores age so the user can always retry).
async function pendingRows({ campaignId = null, limit = 1000 } = {}) {
  if (campaignId) {
    return db.query(
      `SELECT id, provider_msgid FROM call_logs
        WHERE campaign_id = :campaignId AND status = 'sent' AND provider_msgid IS NOT NULL
          AND (dlr_status IS NULL OR dlr_status = 'pending')
        ORDER BY id ASC LIMIT :limit`,
      { campaignId, limit }
    );
  }
  return db.query(
    `SELECT id, provider_msgid FROM call_logs
      WHERE status = 'sent' AND provider_msgid IS NOT NULL
        AND (dlr_status IS NULL OR dlr_status = 'pending')
        AND end_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL :hrs HOUR)
      ORDER BY dlr_updated_at IS NOT NULL, dlr_updated_at ASC, id ASC
      LIMIT :limit`,
    { hrs: config.sms.dlrMaxAgeHours, limit }
  );
}

// One background sweep across all recent campaigns.
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const rows = await pendingRows({ limit: config.sms.dlrBatch * 5 });
    if (rows.length === 0) return;
    const updated = await processRows(rows);
    if (updated > 0) logger.info(`DLR poll updated ${updated}/${rows.length} messages`);
  } catch (e) {
    logger.error(`DLR poll error: ${e.message}`);
  } finally {
    busy = false;
  }
}

// Manual "refresh now" for one campaign: poll all its still-pending messages and
// return fresh delivery counts. Ignores the age cutoff.
async function refreshCampaign(campaignId) {
  const rows = await pendingRows({ campaignId, limit: 100000 });
  const checked = rows.length;
  const updated = checked > 0 ? await processRows(rows) : 0;
  return { checked, updated };
}

function start() {
  if (!config.sms.authKey) {
    logger.info('DLR poller disabled (SMS gateway not configured)');
    return;
  }
  if (config.sms.dlrPollSeconds <= 0) {
    logger.info('DLR poller disabled (SMS_DLR_POLL_SECONDS=0)');
    return;
  }
  timer = setInterval(() => {
    tick().catch((e) => logger.error(`DLR tick crashed: ${e.message}`));
  }, config.sms.dlrPollSeconds * 1000);
  logger.info(`DLR poller started (every ${config.sms.dlrPollSeconds}s, batch ${config.sms.dlrBatch})`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, refreshCampaign, _internal: { toMysqlUtc } };
