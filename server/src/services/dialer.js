'use strict';

const crypto = require('crypto');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const db = require('../db');
const ari = require('./ari');
const monitor = require('../ws/monitor');

// ───────────────────────────────────────────────────────────────────────────
// Module state
// ───────────────────────────────────────────────────────────────────────────
const runners = new Map(); // campaignId -> Runner
const activeCalls = new Map(); // channelId -> { campaignId, callLogId, answered, media, runner, playbackId }
const playbackIndex = new Map(); // playbackId -> channelId
let schedulerTimer = null;

const TICK_MS = 250;

// ───────────────────────────────────────────────────────────────────────────
// Q.850 hangup-cause → report status
// ───────────────────────────────────────────────────────────────────────────
function mapCause(cause, answered) {
  if (answered) return 'answered';
  switch (Number(cause)) {
    case 17:
      return 'busy';
    case 16: // normal clearing without answer (e.g. caller-side cancel)
    case 18: // no user responding
    case 19: // no answer (alerted, no pickup)
    case 20: // subscriber absent
    case 31: // normal, unspecified
      return 'no_answer';
    case 34: // no circuit/channel available
    case 38: // network out of order
    case 42: // switching equipment congestion
    case 44: // requested channel unavailable
      return 'congestion';
    default:
      // 1 unallocated, 21 rejected, 28 invalid number, etc.
      return 'failed';
  }
}

// Pure decision: should this finished call be re-queued for another attempt?
// Answered calls are never retried.
function shouldRetry(status, attempt, maxAttempts, retryOn) {
  return status !== 'answered' && retryOn.has(status) && attempt < maxAttempts;
}

// ───────────────────────────────────────────────────────────────────────────
// Runner: paces a single campaign's dialing.
// ───────────────────────────────────────────────────────────────────────────
class Runner {
  constructor(campaign) {
    this.id = campaign.id;
    this.cps = Number(campaign.cps);
    this.maxConcurrent = Number(campaign.max_concurrent);
    this.callerId = campaign.caller_number || null;
    this.media = campaign.audio_stored
      ? `sound:${path.posix.join('callbot', campaign.audio_stored)}`
      : null;
    // Redial / multi-attempt settings (snapshotted on the campaign).
    this.maxAttempts = Number(campaign.max_attempts) || 1;
    this.retryDelayMin = Number(campaign.retry_delay_min) || 0;
    this.retryOn = new Set(
      String(campaign.retry_on || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    this.nextRetryAt = null; // epoch ms — set while idling until a future retry is due
    this.amdEnabled = !!campaign.amd_enabled; // answering-machine detection on?
    this.live = new Set(); // channelIds currently up for this campaign
    this.buffer = []; // prefetched queued call_log rows
    this.tokens = 0;
    this.running = false;
    this.timer = null;
    this._busy = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tokens = 0;
    this.timer = setInterval(() => this.pump(), TICK_MS);
    logger.info(`Campaign ${this.id} runner started (cps=${this.cps}, max=${this.maxConcurrent})`);
  }

  pause() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Hang up everything still in progress.
  async hangupAll() {
    const client = ari.getClient();
    for (const channelId of [...this.live]) {
      try {
        await client.channels.hangup({ channelId });
      } catch (_e) {
        /* already gone */
      }
    }
  }

  async pump() {
    if (!this.running || this._busy) return;
    // While idling between retry batches, skip cheaply (no DB) until due.
    if (this.nextRetryAt && this.live.size === 0 && Date.now() < this.nextRetryAt) return;
    this._busy = true;
    try {
      // Replenish the token bucket (burst capped at ~1 second of cps).
      this.tokens = Math.min(this.tokens + this.cps * (TICK_MS / 1000), Math.max(this.cps, 1));

      // ranDry = we actually asked for a row and got none (no due rows right
      // now). If the loop instead stopped for pacing/concurrency, due rows may
      // still exist, so we must NOT idle/complete — the next tick will dial them.
      let ranDry = false;
      while (this.running && this.tokens >= 1 && this.live.size < this.maxConcurrent) {
        const row = await this.takeNext();
        if (!row) {
          ranDry = true;
          break;
        }
        this.tokens -= 1;
        await this.dispatch(row);
      }

      // No due rows left and nothing in progress: either finished, or just
      // waiting for pending retries to come due.
      if (this.running && ranDry && this.live.size === 0) {
        const [agg] = await db.query(
          `SELECT COUNT(*) AS queued, MIN(next_attempt_at) AS nextAt
             FROM call_logs WHERE campaign_id = :id AND status = 'queued'`,
          { id: this.id }
        );
        if (Number(agg.queued) === 0) {
          await finalizeCampaign(this.id, 'completed');
        } else {
          // Only future-dated retries remain (none were due, or takeNext would
          // have returned one). Idle until the earliest is due.
          this.nextRetryAt = agg.nextAt ? new Date(agg.nextAt).getTime() : Date.now();
        }
      }
    } catch (err) {
      logger.error(`Runner ${this.id} pump error:`, err.message);
    } finally {
      this._busy = false;
    }
  }

  async takeNext() {
    if (this.buffer.length === 0) {
      this.buffer = await db.query(
        `SELECT id, name, phone, attempts FROM call_logs
           WHERE campaign_id = :id AND status = 'queued'
             AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP())
           ORDER BY id LIMIT 200`,
        { id: this.id }
      );
    }
    return this.buffer.shift() || null;
  }

  async dispatch(row) {
    const client = ari.getClient();
    const channelId = `cb-${this.id}-${row.id}-${crypto.randomBytes(4).toString('hex')}`;
    const endpoint = config.dial.endpointTemplate.replace('{number}', row.phone);

    // Reserve the row + slot before the async originate so a concurrent pump
    // can't grab it again.
    this.live.add(channelId);
    await db.execute(
      `UPDATE call_logs
          SET status = 'dialing', channel = :channel, dial_start = UTC_TIMESTAMP(),
              attempts = attempts + 1
        WHERE id = :id`,
      { channel: channelId, id: row.id }
    );
    activeCalls.set(channelId, {
      campaignId: this.id,
      callLogId: row.id,
      // Carried on every monitor event so the UI never shows a blank number,
      // even when it subscribed mid-campaign and missed the 'dialing' event.
      name: row.name,
      phone: row.phone,
      answered: false,
      media: this.media,
      runner: this,
      finalized: false,
      attempt: (row.attempts || 0) + 1, // this dial is attempt N
      amd: this.amdEnabled,
    });
    monitor.publish(this.id, {
      type: 'call',
      callLogId: row.id,
      name: row.name,
      phone: row.phone,
      status: 'dialing',
      attempt: (row.attempts || 0) + 1, // >1 means this is a redial
      at: new Date().toISOString(),
    });

    const opts = { endpoint, timeout: config.dial.originateTimeout, channelId };
    if (this.callerId) opts.callerId = this.callerId;
    if (this.amdEnabled) {
      // Route through a dialplan context that runs AMD() then hands to Stasis,
      // so the AMDSTATUS variable is set by the time StasisStart fires.
      opts.context = config.dial.amdContext;
      opts.extension = row.phone;
      opts.priority = 1;
    } else {
      // Straight into the Stasis app on answer.
      opts.app = config.ari.app;
      opts.appArgs = String(this.id);
    }

    try {
      await client.channels.originate(opts);
      // Make sure we get this channel's lifecycle events even if it never
      // enters Stasis (busy / no-answer are reported via ChannelDestroyed).
      client.applications
        .subscribe({ applicationName: config.ari.app, eventSource: `channel:${channelId}` })
        .catch(() => {});
    } catch (err) {
      logger.warn(`Originate failed for ${row.phone}: ${err.message}`);
      await finalizeCall(channelId, null, 'failed');
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ARI event handlers (registered on every (re)connect)
// ───────────────────────────────────────────────────────────────────────────
function registerHandlers(client) {
  client.removeAllListeners('StasisStart');
  client.removeAllListeners('StasisEnd');
  client.removeAllListeners('PlaybackFinished');
  client.removeAllListeners('ChannelDestroyed');

  client.on('StasisStart', async (_event, channel) => {
    const call = activeCalls.get(channel.id);
    if (!call) return; // not one of ours

    // Answering-machine detection: for AMD campaigns the channel ran AMD() in
    // the dialplan before entering Stasis, so AMDSTATUS is set. Machines are
    // logged as 'machine' and dropped without playing; humans hear the message.
    if (call.amd) {
      let amdStatus = 'HUMAN';
      try {
        const v = await client.channels.getChannelVar({
          channelId: channel.id,
          variable: 'AMDSTATUS',
        });
        amdStatus = (v && v.value) || 'HUMAN';
      } catch (_e) {
        // Variable missing → fail open and treat as a human (never drop a real
        // person just because detection didn't report).
      }
      if (amdStatus === 'MACHINE') {
        call.outcome = 'machine';
        monitor.publish(call.campaignId, {
          type: 'call',
          callLogId: call.callLogId,
          name: call.name,
          phone: call.phone,
          status: 'machine',
          at: new Date().toISOString(),
        });
        try {
          await channel.hangup();
        } catch (_e) {}
        return; // ChannelDestroyed → finalizeCall records 'machine'
      }
    }

    call.answered = true;
    await db.execute(
      "UPDATE call_logs SET status = 'answered', answer_time = UTC_TIMESTAMP() WHERE id = :id",
      { id: call.callLogId }
    );
    monitor.publish(call.campaignId, {
      type: 'call',
      callLogId: call.callLogId,
      name: call.name,
      phone: call.phone,
      status: 'answered',
      at: new Date().toISOString(),
    });

    if (!call.media) {
      // No audio configured — just hang up.
      try {
        await channel.hangup();
      } catch (_e) {}
      return;
    }
    try {
      const playback = await channel.play({ media: call.media });
      call.playbackId = playback.id;
      playbackIndex.set(playback.id, channel.id);
    } catch (err) {
      logger.warn(`Playback failed on ${channel.id}: ${err.message}`);
      try {
        await channel.hangup();
      } catch (_e) {}
    }
  });

  // When the message finishes, hang up — that's the whole call for a broadcast.
  client.on('PlaybackFinished', async (_event, playback) => {
    const channelId = playbackIndex.get(playback.id);
    if (!channelId) return;
    playbackIndex.delete(playback.id);
    try {
      await client.channels.hangup({ channelId });
    } catch (_e) {}
  });

  client.on('ChannelDestroyed', async (event, channel) => {
    const id = channel.id || (event.channel && event.channel.id);
    await finalizeCall(id, event.cause, null);
  });
}

// Finalize a single call: write outcome, free the slot, nudge the runner.
async function finalizeCall(channelId, cause, forcedStatus) {
  const call = activeCalls.get(channelId);
  if (!call || call.finalized) return;
  call.finalized = true;
  activeCalls.delete(channelId);
  if (call.playbackId) playbackIndex.delete(call.playbackId);

  const status = forcedStatus || call.outcome || mapCause(cause, call.answered);
  const runner = runners.get(call.campaignId);
  const causeVal = cause == null ? null : Number(cause);

  // Retry? Requeue instead of finalizing when the outcome is retryable and this
  // number still has attempts left. Answered calls are never retried.
  const willRetry =
    runner && shouldRetry(status, call.attempt, runner.maxAttempts, runner.retryOn);

  if (willRetry) {
    await db.execute(
      `UPDATE call_logs
          SET status = 'queued',
              channel = NULL,
              hangup_cause = :cause,
              end_time = UTC_TIMESTAMP(),
              duration_sec = TIMESTAMPDIFF(SECOND, COALESCE(answer_time, dial_start), UTC_TIMESTAMP()),
              next_attempt_at = CASE WHEN :delay > 0
                                     THEN DATE_ADD(UTC_TIMESTAMP(), INTERVAL :delay MINUTE)
                                     ELSE NULL END
        WHERE id = :id`,
      { cause: causeVal, delay: runner.retryDelayMin, id: call.callLogId }
    );
    monitor.publish(call.campaignId, {
      type: 'call',
      callLogId: call.callLogId,
      name: call.name,
      phone: call.phone,
      status,
      retrying: true,
      attempt: call.attempt,
      at: new Date().toISOString(),
    });
    runner.live.delete(channelId);
    runner.nextRetryAt = null; // a new (possibly sooner) retry exists — recompute
    runner.pump();
    return;
  }

  await db.execute(
    `UPDATE call_logs
        SET status = :status,
            hangup_cause = :cause,
            end_time = UTC_TIMESTAMP(),
            duration_sec = TIMESTAMPDIFF(SECOND, COALESCE(answer_time, dial_start), UTC_TIMESTAMP())
      WHERE id = :id`,
    { status, cause: causeVal, id: call.callLogId }
  );
  monitor.publish(call.campaignId, {
    type: 'call',
    callLogId: call.callLogId,
    name: call.name,
    phone: call.phone,
    status,
    attempt: call.attempt,
    at: new Date().toISOString(),
  });

  if (runner) {
    runner.live.delete(channelId);
    runner.pump(); // fill the freed slot / check completion
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Campaign lifecycle
// ───────────────────────────────────────────────────────────────────────────
async function loadCampaignRow(campaignId) {
  const rows = await db.query(
    `SELECT c.*, ci.number AS caller_number, a.stored_filename AS audio_stored
       FROM campaigns c
       LEFT JOIN caller_ids  ci ON ci.id = c.caller_id_id
       LEFT JOIN audio_files a  ON a.id = c.audio_file_id
      WHERE c.id = :id`,
    { id: campaignId }
  );
  return rows[0] || null;
}

// Seed call_logs from contacts the first time a campaign runs.
async function ensureCallLogs(campaignId) {
  const [{ n }] = await db.query(
    'SELECT COUNT(*) AS n FROM call_logs WHERE campaign_id = :id',
    { id: campaignId }
  );
  if (n > 0) return;
  await db.execute(
    `INSERT INTO call_logs (campaign_id, contact_id, name, phone, status)
       SELECT campaign_id, id, name, phone, 'queued' FROM contacts WHERE campaign_id = :id`,
    { id: campaignId }
  );
}

async function startCampaign(campaignId) {
  if (!ari.isConnected()) throw new Error('Telephony engine (ARI) is not connected');
  const campaign = await loadCampaignRow(campaignId);
  if (!campaign) throw new Error('Campaign not found');

  await ensureCallLogs(campaignId);
  await db.execute(
    `UPDATE campaigns
        SET status = 'running', started_at = COALESCE(started_at, UTC_TIMESTAMP())
      WHERE id = :id`,
    { id: campaignId }
  );

  let runner = runners.get(campaignId);
  if (!runner) {
    runner = new Runner(campaign);
    runners.set(campaignId, runner);
  }
  runner.start();
  monitor.publish(campaignId, { type: 'campaign', status: 'running' });
  logger.info(`Campaign ${campaignId} started`);
}

// Re-dial a finished (completed/stopped) campaign. scope:
//   'all'       — reset every number and dial the whole list again from scratch
//   'unreached' — reset only numbers that were never answered (busy / no answer /
//                 failed / congestion) and dial just those
async function rerunCampaign(campaignId, scope) {
  // Clear any lingering runner so we start from a clean slate.
  const existing = runners.get(campaignId);
  if (existing) {
    existing.pause();
    await existing.hangupAll();
    runners.delete(campaignId);
  }

  // Wipe the per-attempt state so the number is eligible to dial again and the
  // retry logic (max_attempts) applies afresh.
  const reset = `status = 'queued', channel = NULL, hangup_cause = NULL, attempts = 0,
                 next_attempt_at = NULL, dial_start = NULL, answer_time = NULL,
                 end_time = NULL, duration_sec = NULL`;
  if (scope === 'unreached') {
    await db.execute(
      `UPDATE call_logs SET ${reset}
        WHERE campaign_id = :id AND status NOT IN ('answered', 'machine')`,
      { id: campaignId }
    );
  } else {
    await db.execute(`UPDATE call_logs SET ${reset} WHERE campaign_id = :id`, { id: campaignId });
  }

  // Fresh run: drop the previous status/timestamps so started_at reflects this run.
  await db.execute(
    "UPDATE campaigns SET status = 'draft', started_at = NULL, completed_at = NULL WHERE id = :id",
    { id: campaignId }
  );

  await startCampaign(campaignId);
}

async function pauseCampaign(campaignId) {
  const runner = runners.get(campaignId);
  if (runner) runner.pause();
  await db.execute("UPDATE campaigns SET status = 'paused' WHERE id = :id", { id: campaignId });
  monitor.publish(campaignId, { type: 'campaign', status: 'paused' });
}

async function stopCampaign(campaignId) {
  const runner = runners.get(campaignId);
  if (runner) {
    runner.pause();
    await runner.hangupAll();
    runners.delete(campaignId);
  }
  await db.execute(
    "UPDATE campaigns SET status = 'stopped', completed_at = UTC_TIMESTAMP() WHERE id = :id",
    { id: campaignId }
  );
  monitor.publish(campaignId, { type: 'campaign', status: 'stopped' });
}

async function finalizeCampaign(campaignId, status) {
  const runner = runners.get(campaignId);
  if (runner) {
    runner.pause();
    runners.delete(campaignId);
  }
  await db.execute(
    'UPDATE campaigns SET status = :status, completed_at = UTC_TIMESTAMP() WHERE id = :id',
    { status, id: campaignId }
  );
  monitor.publish(campaignId, { type: 'campaign', status });
  logger.info(`Campaign ${campaignId} ${status}`);
}

// ───────────────────────────────────────────────────────────────────────────
// Scheduler + boot resume
// ───────────────────────────────────────────────────────────────────────────
async function onConnect(client) {
  registerHandlers(client);
  // A reconnect orphans any in-flight channels; reset them so they get redialed.
  await db.execute(
    "UPDATE call_logs SET status = 'queued', channel = NULL WHERE status = 'dialing'"
  );
  activeCalls.clear();
  playbackIndex.clear();

  // Resume campaigns that were running before a restart.
  const running = await db.query("SELECT id FROM campaigns WHERE status = 'running'");
  for (const c of running) {
    try {
      await startCampaign(c.id);
    } catch (e) {
      logger.error(`Could not resume campaign ${c.id}:`, e.message);
    }
  }
}

async function checkScheduled() {
  try {
    const due = await db.query(
      "SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= UTC_TIMESTAMP()"
    );
    for (const c of due) {
      logger.info(`Scheduled campaign ${c.id} is due, starting`);
      await startCampaign(c.id).catch((e) =>
        logger.error(`Failed to start scheduled campaign ${c.id}:`, e.message)
      );
    }
  } catch (e) {
    logger.error('Scheduler error:', e.message);
  }
}

async function start() {
  await ari.connect(onConnect);
  schedulerTimer = setInterval(checkScheduled, 30000);
}

function stop() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  for (const runner of runners.values()) runner.pause();
  ari.stop();
}

module.exports = {
  start,
  stop,
  isConnected: ari.isConnected,
  startCampaign,
  pauseCampaign,
  stopCampaign,
  rerunCampaign,
  // exported for unit tests
  _internal: { mapCause, shouldRetry },
};
