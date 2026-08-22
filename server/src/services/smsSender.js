'use strict';

const config = require('../config');
const logger = require('../logger');
const db = require('../db');
const monitor = require('../ws/monitor');
const smsProvider = require('./smsProvider');
const creditService = require('./creditService');
const { smsSegments } = require('./smsText');

// The real message a recipient gets (prepend + rendered template) and how many
// SMS credits it costs (gateway sender-label prefix included, no composer
// safety cushion — that's only for blocking over-long templates, not billing).
function messageFor(template, row) {
  const content = config.sms.prepend + renderTemplate(template, { name: row.name, amount: row.amount });
  const { segments } = smsSegments(content, config.sms.prefixChars || 0);
  return { content, credits: Math.max(1, segments) };
}

// ───────────────────────────────────────────────────────────────────────────
// SMS broadcasting engine. Mirrors dialer.js's lifecycle interface
// (startCampaign / pauseCampaign / stopCampaign / rerunCampaign) so the
// campaigns route can drive voice and SMS the same way — but instead of
// originating Asterisk channels it POSTs each message to the SMS gateway.
//
// Per-recipient status lives in call_logs, reusing the shared statuses:
//   queued  → not yet sent
//   dialing → in-flight ("sending")
//   sent    → gateway accepted (code 1)
//   failed  → gateway rejected or network error (reason in error_detail)
// ───────────────────────────────────────────────────────────────────────────

const runners = new Map(); // campaignId -> SmsRunner
let schedulerTimer = null;
// In-flight sends across ALL campaigns — the shared gateway budget.
let globalInFlight = 0;

const TICK_MS = 250;

// Fill {name} / {amount} placeholders (case-insensitive) from a contact row.
// Missing values substitute to an empty string so a template never leaks a raw
// "{amount}" to a recipient. Single-pass so a value that itself contains a
// token (e.g. a name of "{amount}") is never re-expanded.
function renderTemplate(template, { name, amount }) {
  const values = {
    name: name == null ? '' : String(name),
    amount: amount == null ? '' : String(amount),
  };
  return String(template || '').replace(/\{\s*(name|amount)\s*\}/gi, (_m, key) => values[key.toLowerCase()]);
}

// Should this failed send be requeued for another attempt? Only transient
// gateway/network errors are retryable, and only within the campaign's limits.
function shouldRetry(code, attempt, maxAttempts, retryOn, totalDials, maxTotalDials) {
  if (!retryOn.has('failed') || attempt >= maxAttempts) return false;
  if (maxTotalDials > 0 && totalDials >= maxTotalDials) return false;
  return smsProvider.isTransient(code);
}

// ───────────────────────────────────────────────────────────────────────────
// Runner: paces a single SMS campaign's sending.
// ───────────────────────────────────────────────────────────────────────────
class SmsRunner {
  constructor(campaign) {
    this.id = campaign.id;
    this.cps = Number(campaign.cps) || 1;
    this.maxConcurrent = Number(campaign.max_concurrent) || 10; // in-flight HTTP cap
    this.template = campaign.message_template || '';
    // SMS campaigns never auto-retry — exactly one send attempt per recipient.
    // (A gateway reject won't succeed on a resend, and a message the gateway
    // accepted must not be sent twice.) Redialing unreached numbers is still a
    // separate, manual action.
    this.maxAttempts = 1;
    this.retryDelayMin = 0;
    this.retryOn = new Set();
    this.maxTotalDials = config.calls.maxTotalDials; // shared lifetime cap
    this.nextRetryAt = null;
    this.inFlight = 0; // this campaign's in-flight sends
    this.buffer = []; // prefetched queued rows
    this.tokens = 0;
    this.running = false;
    this.timer = null;
    this._busy = false;
    // Safety brake: count gateway failures in a row so a systemic problem
    // (gateway down, repeated timeouts) auto-stops the campaign. Reset on any
    // successful send. `aborted` guards abortCampaign() so it fires once.
    this.autoStopThreshold = config.sms.autoStopFailures;
    this.consecutiveFailures = 0;
    this.aborted = false;
    // Prepaid credit wallet. User-owned campaigns spend the owner's wallet;
    // admin-owned campaigns are not gated (the vendor draws from the pool).
    this.ownerId = campaign.user_id || null;
    this.walletGated = (campaign.owner_role || 'user') === 'user';
    this.creditsSpent = 0; // net credits charged this run (for the spend ledger)
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.aborted = false;
    this.consecutiveFailures = 0;
    this.tokens = 0;
    this.timer = setInterval(() => this.pump(), TICK_MS);
    logger.info(`SMS campaign ${this.id} runner started (cps=${this.cps}, max=${this.maxConcurrent})`);
  }

  pause() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pump() {
    if (!this.running || this._busy) return;
    if (this.nextRetryAt && this.inFlight === 0 && Date.now() < this.nextRetryAt) return;
    this._busy = true;
    try {
      this.tokens = Math.min(this.tokens + this.cps * (TICK_MS / 1000), Math.max(this.cps, 1));

      let ranDry = false;
      while (
        this.running &&
        this.tokens >= 1 &&
        this.inFlight < this.maxConcurrent &&
        globalInFlight < config.sms.globalMaxConcurrent
      ) {
        const row = await this.takeNext();
        if (!row) {
          ranDry = true;
          break;
        }
        this.tokens -= 1;
        // Render the message + its credit cost once, reuse in deliver().
        const msg = messageFor(this.template, row);
        row._content = msg.content;
        row._credits = msg.credits;
        // Prepaid: debit the owner's wallet BEFORE sending. If it can't cover
        // this message, stop the campaign (the row stays 'queued' — it wasn't
        // reserved — so a later top-up + redial resumes exactly here).
        if (this.walletGated) {
          const paid = await creditService.charge(this.ownerId, msg.credits);
          if (!paid) {
            if (!this.aborted) {
              this.aborted = true;
              this.pause();
              abortCampaign(
                this.id,
                "Out of SMS credits. Ask the administrator to top up the account's balance, then redial the remaining messages."
              ).catch((e) => logger.error(`SMS credit auto-stop ${this.id}:`, e.message));
            }
            break;
          }
          this.creditsSpent += msg.credits;
        }
        // Reserve the row synchronously (so a concurrent re-select can't grab
        // it) BEFORE counting it in flight. If the reserve itself errors, the
        // row stays queued and no counter leaks — refund the charge and skip.
        try {
          await this.reserve(row);
        } catch (e) {
          if (this.walletGated) {
            await creditService.refund(this.ownerId, msg.credits).catch(() => {});
            this.creditsSpent -= msg.credits;
          }
          logger.error(`SMS reserve ${row.id} failed:`, e.message);
          continue;
        }
        // Count it in flight, then fire the actual HTTP send without awaiting —
        // that's what lets up to maxConcurrent sends run at once. deliver()'s
        // finally always releases these counters.
        this.inFlight += 1;
        globalInFlight += 1;
        this.deliver(row).catch((e) => logger.error(`SMS deliver ${row.id} error:`, e.message));
      }

      if (this.running && ranDry && this.inFlight === 0) {
        // Nothing is in flight, so any row still 'dialing' is orphaned (an
        // outcome write that failed after the send). Reclaim it to 'queued' so
        // it's resent rather than silently lost — and so we never finalize a
        // campaign with a non-terminal row. A row already AT the lifetime cap
        // can't be requeued (the queue filters capped rows, it would sit
        // 'queued' forever) — close it out instead.
        if (this.maxTotalDials > 0) {
          await db.execute(
            `UPDATE call_logs
                SET status = 'failed', error_detail = 'Interrupted at the lifetime send cap',
                    end_time = UTC_TIMESTAMP()
              WHERE campaign_id = :id AND status = 'dialing' AND total_dials >= :cap`,
            { id: this.id, cap: this.maxTotalDials }
          );
        }
        await db.execute(
          "UPDATE call_logs SET status = 'queued', dial_start = NULL WHERE campaign_id = :id AND status = 'dialing'",
          { id: this.id }
        );
        // Count with the SAME lifetime-cap filter takeNext uses — a 'queued'
        // row already at the cap can never be sent, and counting it here would
        // pin the campaign 'running' forever.
        const capSql = this.maxTotalDials > 0 ? 'AND total_dials < :cap' : '';
        const [agg] = await db.query(
          `SELECT COUNT(*) AS queued, MIN(next_attempt_at) AS nextAt
             FROM call_logs WHERE campaign_id = :id AND status = 'queued' ${capSql}`,
          { id: this.id, cap: this.maxTotalDials }
        );
        if (Number(agg.queued) === 0) {
          await finalizeCampaign(this.id, 'completed');
        } else {
          this.nextRetryAt = agg.nextAt ? new Date(agg.nextAt).getTime() : Date.now();
        }
      }
    } catch (err) {
      logger.error(`SMS runner ${this.id} pump error:`, err.message);
    } finally {
      this._busy = false;
    }
  }

  async takeNext() {
    if (this.buffer.length === 0) {
      const capSql = this.maxTotalDials > 0 ? 'AND total_dials < :cap' : '';
      this.buffer = await db.query(
        `SELECT id, name, phone, amount, attempts, total_dials FROM call_logs
           WHERE campaign_id = :id AND status = 'queued' ${capSql}
             AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP())
           ORDER BY id LIMIT 200`,
        { id: this.id, cap: this.maxTotalDials }
      );
    }
    return this.buffer.shift() || null;
  }

  // Mark the row in-flight and announce it on the monitor.
  async reserve(row) {
    await db.execute(
      `UPDATE call_logs
          SET status = 'dialing', dial_start = UTC_TIMESTAMP(),
              attempts = attempts + 1, total_dials = total_dials + 1
        WHERE id = :id`,
      { id: row.id }
    );
    monitor.publish(this.id, {
      type: 'call',
      callLogId: row.id,
      name: row.name,
      phone: row.phone,
      status: 'dialing',
      attempt: (row.attempts || 0) + 1,
      at: new Date().toISOString(),
    });
  }

  // Send the message and record the outcome. Runs concurrently with other
  // deliveries; frees its slot and nudges the pump when done.
  async deliver(row) {
    const attempt = (row.attempts || 0) + 1;
    const totalDials = (row.total_dials || 0) + 1;
    // Credits already debited at reserve time; keep them only if the gateway
    // accepts the message, otherwise refund in the finally.
    const charged = this.walletGated ? row._credits || 0 : 0;
    let keepCharge = false;
    try {
      // Content was rendered (with the "DCA: "/prepend identifier) at reserve
      // time; reuse it so the billed segments match what's actually sent.
      const content =
        row._content || config.sms.prepend + renderTemplate(this.template, { name: row.name, amount: row.amount });
      const result = await smsProvider.sendSms({ to: row.phone, content });
      if (result.ok) keepCharge = true; // gateway accepted → the credit is real

      // Every outcome write is guarded by `status = 'dialing'` so it only lands
      // on the row THIS run reserved. If a stop+rerun (or restart) has since
      // reset the row to 'queued', the write matches nothing (affectedRows 0)
      // and we skip it — the new run owns that recipient now.
      if (result.ok) {
        this.consecutiveFailures = 0; // a good send clears the safety brake
        const r = await db.execute(
          `UPDATE call_logs
              SET status = 'sent', hangup_cause = :code, provider_msgid = :msgid, error_detail = NULL,
                  end_time = UTC_TIMESTAMP(),
                  duration_sec = TIMESTAMPDIFF(SECOND, dial_start, UTC_TIMESTAMP())
            WHERE id = :id AND status = 'dialing'`,
          { code: result.code, msgid: result.msgid || null, id: row.id }
        );
        if (r.affectedRows > 0) this.publishOutcome(row, 'sent', attempt);
        return;
      }

      // Failed. Feed the auto-stop safety brake: an account-level error (bad
      // auth key / no credit) dooms every send, so stop the campaign at once;
      // other systemic errors stop it once they pile up N in a row. Only the
      // live runner for this campaign can trigger the stop (guards against a
      // stale send from a stopped/rerun run tripping the new one).
      this.consecutiveFailures += 1;
      const fatal = smsProvider.isFatal(result.code);
      const tooMany =
        this.autoStopThreshold > 0 && this.consecutiveFailures >= this.autoStopThreshold;
      if (!this.aborted && this.running && runners.get(this.id) === this && (fatal || tooMany)) {
        this.aborted = true;
        this.pause(); // stop the pump at once so no further sends fire mid-abort
        const rr = await db.execute(
          `UPDATE call_logs
              SET status = 'failed', hangup_cause = :code, error_detail = :detail,
                  end_time = UTC_TIMESTAMP(),
                  duration_sec = TIMESTAMPDIFF(SECOND, dial_start, UTC_TIMESTAMP())
            WHERE id = :id AND status = 'dialing'`,
          { code: result.code, detail: result.detail, id: row.id }
        );
        if (rr.affectedRows > 0) this.publishOutcome(row, 'failed', attempt);
        const reason = fatal
          ? `SMS gateway rejected the account — ${result.detail}. Campaign auto-stopped.`
          : `SMS gateway failed ${this.consecutiveFailures} sends in a row (last error: ${result.detail}). Campaign auto-stopped.`;
        abortCampaign(this.id, reason).catch((e) =>
          logger.error(`SMS auto-stop ${this.id} failed:`, e.message)
        );
        return;
      }

      // Retry only transient errors, within limits.
      if (shouldRetry(result.code, attempt, this.maxAttempts, this.retryOn, totalDials, this.maxTotalDials)) {
        const r = await db.execute(
          `UPDATE call_logs
              SET status = 'queued', hangup_cause = :code, error_detail = :detail,
                  end_time = UTC_TIMESTAMP(),
                  next_attempt_at = CASE WHEN :delay > 0
                                         THEN DATE_ADD(UTC_TIMESTAMP(), INTERVAL :delay MINUTE)
                                         ELSE NULL END
            WHERE id = :id AND status = 'dialing'`,
          { code: result.code, detail: result.detail, delay: this.retryDelayMin, id: row.id }
        );
        if (r.affectedRows > 0) {
          this.publishOutcome(row, 'failed', attempt, { retrying: true });
          this.nextRetryAt = null; // a new (maybe sooner) retry exists — recompute
        }
        return;
      }

      const r = await db.execute(
        `UPDATE call_logs
            SET status = 'failed', hangup_cause = :code, error_detail = :detail,
                end_time = UTC_TIMESTAMP(),
                duration_sec = TIMESTAMPDIFF(SECOND, dial_start, UTC_TIMESTAMP())
          WHERE id = :id AND status = 'dialing'`,
        { code: result.code, detail: result.detail, id: row.id }
      );
      if (r.affectedRows > 0) this.publishOutcome(row, 'failed', attempt);
    } finally {
      // Message wasn't accepted → the gateway didn't charge, so return the
      // credits we optimistically debited at reserve time.
      if (charged && !keepCharge) {
        creditService.refund(this.ownerId, charged).catch(() => {});
        this.creditsSpent -= charged;
      }
      this.inFlight -= 1;
      globalInFlight = Math.max(0, globalInFlight - 1);
      this.pump();
    }
  }

  publishOutcome(row, status, attempt, extra = {}) {
    monitor.publish(this.id, {
      type: 'call',
      callLogId: row.id,
      name: row.name,
      phone: row.phone,
      status,
      attempt,
      at: new Date().toISOString(),
      ...extra,
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Campaign lifecycle (same shape as dialer.js)
// ───────────────────────────────────────────────────────────────────────────
async function loadCampaignRow(campaignId) {
  const rows = await db.query(
    `SELECT c.*, u.role AS owner_role
       FROM campaigns c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.id = :id`,
    { id: campaignId }
  );
  return rows[0] || null;
}

// Estimated credits a user-owned campaign needs: the still-to-send recipients ×
// this message's credit cost (using a representative recipient). Used to block
// a campaign the wallet clearly can't afford before it starts; the per-message
// charge is the exact, authoritative enforcement.
async function estimateCredits(campaign) {
  const [{ n }] = await db.query(
    "SELECT COUNT(*) AS n FROM call_logs WHERE campaign_id = :id AND status = 'queued'",
    { id: campaign.id }
  );
  const recipients = Number(n);
  if (recipients === 0) return 0;
  const [sample] = await db.query(
    "SELECT name, amount FROM call_logs WHERE campaign_id = :id AND status = 'queued' LIMIT 1",
    { id: campaign.id }
  );
  const perMsg = messageFor(campaign.message_template || '', sample || {}).credits;
  return recipients * perMsg;
}

// Seed call_logs from contacts the first time a campaign runs. Carries the
// contact's amount so the template can be rendered per-recipient at send time.
async function ensureSendLogs(campaignId) {
  const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM call_logs WHERE campaign_id = :id', {
    id: campaignId,
  });
  if (n > 0) return;
  await db.execute(
    `INSERT INTO call_logs (campaign_id, contact_id, name, phone, amount, status)
       SELECT campaign_id, id, name, phone, amount, 'queued' FROM contacts WHERE campaign_id = :id`,
    { id: campaignId }
  );
}

async function startCampaign(campaignId) {
  if (!config.sms.authKey) {
    throw new Error('SMS gateway is not configured (set SMS_AUTH_KEY in the server .env)');
  }
  const campaign = await loadCampaignRow(campaignId);
  if (!campaign) throw new Error('Campaign not found');
  if (!campaign.message_template || !campaign.message_template.trim()) {
    throw new Error('SMS campaign has no message text');
  }

  await ensureSendLogs(campaignId);

  // Prepaid gate: a user-owned campaign can't start unless the owner's wallet
  // can (roughly) cover it. Admin-owned campaigns are not gated.
  if ((campaign.owner_role || 'user') === 'user' && campaign.user_id) {
    const need = await estimateCredits(campaign);
    const have = await creditService.getUserBalance(campaign.user_id);
    if (need > have) {
      const err = new Error(
        `Not enough SMS credits: this campaign needs about ${need.toLocaleString()} credit(s) but the account has ${have.toLocaleString()}. Ask the administrator to top up the balance.`
      );
      err.status = 400;
      throw err;
    }
  }

  await db.execute(
    `UPDATE campaigns
        SET status = 'running', stop_reason = NULL,
            started_at = COALESCE(started_at, UTC_TIMESTAMP())
      WHERE id = :id`,
    { id: campaignId }
  );

  let runner = runners.get(campaignId);
  if (!runner) {
    runner = new SmsRunner(campaign);
    runners.set(campaignId, runner);
  }
  runner.start();
  monitor.publish(campaignId, { type: 'campaign', status: 'running' });
  logger.info(`SMS campaign ${campaignId} started`);
}

const RERUN_UNREACHED = ['failed', 'queued'];

async function rerunCampaign(campaignId, scope, statuses) {
  const existing = runners.get(campaignId);
  if (existing) {
    existing.pause();
    runners.delete(campaignId);
  }

  const reset = `status = 'queued', channel = NULL, hangup_cause = NULL, error_detail = NULL,
                 attempts = 0, next_attempt_at = NULL, dial_start = NULL, answer_time = NULL,
                 end_time = NULL, duration_sec = NULL`;
  const cap = config.calls.maxTotalDials;
  const capSql = cap > 0 ? 'AND total_dials < :cap' : '';
  if (scope === 'unreached') {
    const chosen =
      Array.isArray(statuses) && statuses.length
        ? statuses.filter((s) => RERUN_UNREACHED.includes(s))
        : RERUN_UNREACHED;
    if (chosen.length === 0) return;
    const placeholders = chosen.map((_, i) => `:st${i}`).join(',');
    const params = { id: campaignId, cap };
    chosen.forEach((s, i) => (params[`st${i}`] = s));
    await db.execute('UPDATE call_logs SET in_run = 0 WHERE campaign_id = :id', { id: campaignId });
    await db.execute(
      `UPDATE call_logs SET ${reset}, in_run = 1
        WHERE campaign_id = :id AND status IN (${placeholders}) ${capSql}`,
      params
    );
  } else {
    await db.execute('UPDATE call_logs SET in_run = 0 WHERE campaign_id = :id', { id: campaignId });
    await db.execute(`UPDATE call_logs SET ${reset}, in_run = 1 WHERE campaign_id = :id ${capSql}`, {
      id: campaignId,
      cap,
    });
  }

  const [{ n: runCount }] = await db.query(
    'SELECT COUNT(*) AS n FROM call_logs WHERE campaign_id = :id AND in_run = 1',
    { id: campaignId }
  );
  const pace = config.smsPace(Math.max(1, Number(runCount)));

  await db.execute(
    `UPDATE campaigns
        SET status = 'draft', started_at = NULL, completed_at = NULL,
            rerun_scope = :scope, cps = :cps, max_concurrent = :max
      WHERE id = :id`,
    { id: campaignId, scope, cps: pace.cps, max: pace.maxConcurrent }
  );

  await startCampaign(campaignId);
}

async function pauseCampaign(campaignId) {
  const runner = runners.get(campaignId);
  if (runner) runner.pause();
  await db.execute("UPDATE campaigns SET status = 'paused' WHERE id = :id", { id: campaignId });
  monitor.publish(campaignId, { type: 'campaign', status: 'paused' });
}

// Apply a live edit (message changed while running/paused) to the in-memory
// runner so not-yet-sent messages use the new text. No-op if no runner.
async function refreshCampaign(campaignId) {
  const runner = runners.get(campaignId);
  if (!runner) return;
  const c = await loadCampaignRow(campaignId);
  if (!c) return;
  runner.template = c.message_template || '';
  logger.info(`SMS campaign ${campaignId} runner refreshed (message updated)`);
}

// Write one summary 'spend' ledger row for what this run charged (the wallet
// was already debited per-message; this is the audit trail). Resets the tally.
function flushSpend(runner, campaignId, note) {
  if (runner && runner.walletGated && runner.creditsSpent > 0) {
    creditService.recordSpend(runner.ownerId, campaignId, runner.creditsSpent, note);
    runner.creditsSpent = 0;
  }
}

async function stopCampaign(campaignId) {
  const runner = runners.get(campaignId);
  if (runner) {
    runner.pause();
    flushSpend(runner, campaignId, 'Campaign stopped');
    runners.delete(campaignId);
  }
  await db.execute(
    "UPDATE campaigns SET status = 'stopped', completed_at = UTC_TIMESTAMP() WHERE id = :id",
    { id: campaignId }
  );
  monitor.publish(campaignId, { type: 'campaign', status: 'stopped' });
}

// Stop a running campaign because the gateway is systemically failing (auth
// rejected, no credit, or too many errors in a row). Like stopCampaign but it
// records WHY, so the user sees the reason in the UI and knows to act.
async function abortCampaign(campaignId, reason) {
  const runner = runners.get(campaignId);
  if (runner) {
    runner.pause();
    flushSpend(runner, campaignId, 'Campaign auto-stopped');
    runners.delete(campaignId);
  }
  const msg = String(reason || 'Gateway error').slice(0, 255);
  await db.execute(
    "UPDATE campaigns SET status = 'stopped', stop_reason = :reason, completed_at = UTC_TIMESTAMP() WHERE id = :id",
    { reason: msg, id: campaignId }
  );
  monitor.publish(campaignId, { type: 'campaign', status: 'stopped', reason: msg });
  logger.warn(`SMS campaign ${campaignId} auto-stopped: ${msg}`);
}

async function finalizeCampaign(campaignId, status) {
  // Write the terminal status FIRST: if this update fails transiently, the
  // runner is still alive and its next pump tick retries the finalize — the
  // old order (runner torn down, then update) left the campaign 'running'
  // forever with no runner when this one write failed.
  await db.execute(
    'UPDATE campaigns SET status = :status, completed_at = UTC_TIMESTAMP() WHERE id = :id',
    { status, id: campaignId }
  );
  const runner = runners.get(campaignId);
  if (runner) {
    runner.pause();
    flushSpend(runner, campaignId, `Campaign ${status}`);
    runners.delete(campaignId);
  }
  monitor.publish(campaignId, { type: 'campaign', status });
  logger.info(`SMS campaign ${campaignId} ${status}`);
}

// ───────────────────────────────────────────────────────────────────────────
// Scheduler + boot resume (independent of Asterisk/ARI).
// ───────────────────────────────────────────────────────────────────────────
async function checkScheduled() {
  try {
    const due = await db.query(
      "SELECT id FROM campaigns WHERE channel = 'sms' AND status = 'scheduled' AND scheduled_at <= UTC_TIMESTAMP()"
    );
    for (const c of due) {
      logger.info(`Scheduled SMS campaign ${c.id} is due, starting`);
      await startCampaign(c.id).catch((e) =>
        logger.error(`Failed to start scheduled SMS campaign ${c.id}:`, e.message)
      );
    }
  } catch (e) {
    logger.error('SMS scheduler error:', e.message);
  }
}

async function start() {
  // A restart orphans any in-flight sends; reset them so they get resent.
  // Rows already AT the lifetime cap can't be requeued (the send queue filters
  // capped rows — they'd sit 'queued' forever) — close them out instead.
  if (config.calls.maxTotalDials > 0) {
    await db.execute(
      `UPDATE call_logs
          SET status = 'failed', error_detail = 'Interrupted at the lifetime send cap',
              end_time = UTC_TIMESTAMP()
        WHERE status = 'dialing' AND total_dials >= :cap
          AND campaign_id IN (SELECT id FROM campaigns WHERE channel = 'sms')`,
      { cap: config.calls.maxTotalDials }
    );
  }
  await db.execute(
    `UPDATE call_logs SET status = 'queued', channel = NULL
      WHERE status = 'dialing'
        AND campaign_id IN (SELECT id FROM campaigns WHERE channel = 'sms')`
  );

  // Resume SMS campaigns that were running before the restart.
  const running = await db.query(
    "SELECT id FROM campaigns WHERE channel = 'sms' AND status = 'running'"
  );
  for (const c of running) {
    try {
      await startCampaign(c.id);
    } catch (e) {
      logger.error(`Could not resume SMS campaign ${c.id}:`, e.message);
      // Don't leave it stuck 'running' with no runner — stop it with the reason
      // (e.g. the owner's wallet was drained while it was down) so it's clear.
      await abortCampaign(c.id, `Could not resume: ${e.message}`).catch(() => {});
    }
  }

  schedulerTimer = setInterval(checkScheduled, 30000);
  logger.info('SMS sender started');
}

function stop() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  for (const runner of runners.values()) runner.pause();
}

module.exports = {
  start,
  stop,
  startCampaign,
  pauseCampaign,
  stopCampaign,
  rerunCampaign,
  refreshCampaign,
  // exported for unit tests
  _internal: { renderTemplate, shouldRetry },
};
