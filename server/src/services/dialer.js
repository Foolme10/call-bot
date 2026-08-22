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
let reaperTimer = null;
let reconcileTimer = null;
// Live calls across ALL campaigns right now — the shared trunk budget. Kept in
// sync one-for-one with activeCalls (++ on dispatch, -- on finalize).
let globalLive = 0;

const TICK_MS = 250;
// A pump pass doing real work finishes in well under a second; this long means
// it is hung on something that will never settle.
const STUCK_PUMP_MS = 120000;
// A reserved slot older than this cannot belong to a live call: it covers the
// full ring, the longest message, and the guard's own grace on top.
function liveSlotStaleMs() {
  return (config.dial.originateTimeout + config.dial.maxCallSeconds + 180) * 1000;
}

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
// Answered calls are never retried; the lifetime dial cap also stops retries.
function shouldRetry(status, attempt, maxAttempts, retryOn, totalDials, maxTotalDials) {
  if (status === 'answered' || !retryOn.has(status) || attempt >= maxAttempts) return false;
  if (maxTotalDials > 0 && totalDials >= maxTotalDials) return false; // hit lifetime cap
  return true;
}

// ari-client issues its REST calls with no request timeout, so ANY await on it
// can hang forever if Asterisk stops answering (busy SIP stack, half-open
// socket). One such hang inside the pump pins the runner's _busy flag and the
// campaign silently stops dialing for good. Every ARI call the dial path makes
// is therefore bounded.
function withTimeout(promise, seconds, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`ARI ${label} timed out after ${seconds}s`);
      err.ariTimeout = true;
      reject(err);
    }, seconds * 1000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ARI errors from a restarting Asterisk carry a whole HTML error page as their
// message. Collapse that to one readable line so a bounce doesn't dump hundreds
// of lines of markup into the log (and hide the warnings that matter).
function originateErrorText(err) {
  const raw = String((err && err.message) || err || '');
  if (!/<html|<!DOCTYPE/i.test(raw)) return raw.slice(0, 300);
  const title = raw.match(/<title>([^<]+)<\/title>/i);
  const body = raw.match(/<h1>([^<]+)<\/h1>\s*<p>([^<]+)<\/p>/i);
  if (title && body) return `${title[1].trim()} — ${body[2].trim()}`;
  if (title) return title[1].trim();
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
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
    this.mediaDuration = Number(campaign.audio_duration) || 0; // seconds, for the auto-hangup guard
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
    this.maxTotalDials = config.calls.maxTotalDials; // lifetime dial cap (0 = off)
    this.amdEnabled = !!campaign.amd_enabled; // answering-machine detection on?
    // channelId -> when the slot was reserved. A Map (not a Set) so the
    // watchdog can tell a slot mid-dispatch from one genuinely orphaned.
    this.live = new Map();
    this.buffer = []; // prefetched queued call_log rows
    this.tokens = 0;
    this.running = false;
    this.timer = null;
    this._busy = false;
    this._busySince = 0; // when the current pump pass started (0 = idle)
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
    for (const channelId of [...this.live.keys()]) {
      try {
        await withTimeout(
          client.channels.hangup({ channelId }),
          config.dial.ariRequestTimeout,
          'hangup'
        );
      } catch (_e) {
        /* already gone, or ARI not answering — the guard/reaper will finalize */
      }
    }
  }

  async pump() {
    if (!this.running || this._busy) return;
    // Engine down (ARI reconnecting): don't dispatch — every originate would
    // fail instantly and burn the number's attempts. Resume when it's back.
    if (!ari.isConnected()) return;
    // Recovery is resetting shared state right now; dispatching into that
    // window orphans the call and re-queues its row underneath us.
    if (recovering) return;
    // While idling between retry batches, skip cheaply (no DB) until due.
    if (this.nextRetryAt && this.live.size === 0 && Date.now() < this.nextRetryAt) return;
    this._busy = true;
    this._busySince = Date.now();
    try {
      // Replenish the token bucket (burst capped at ~1 second of cps).
      this.tokens = Math.min(this.tokens + this.cps * (TICK_MS / 1000), Math.max(this.cps, 1));

      // ranDry = we actually asked for a row and got none (no due rows right
      // now). If the loop instead stopped for pacing/concurrency, due rows may
      // still exist, so we must NOT idle/complete — the next tick will dial them.
      let ranDry = false;
      while (
        this.running &&
        this.tokens >= 1 &&
        this.live.size < this.maxConcurrent &&
        globalLive < config.calls.globalMaxConcurrent // shared trunk budget
      ) {
        const row = await this.takeNext();
        if (!row) {
          ranDry = true;
          break;
        }
        this.tokens -= 1;
        await this.dispatch(row);
      }

      // No due rows left and nothing in progress: either finished, or just
      // waiting for pending retries to come due. Count with the SAME lifetime-
      // cap filter takeNext uses — a 'queued' row already at the cap can never
      // be dialed, and counting it here pins the campaign 'running' forever.
      if (this.running && ranDry && this.live.size === 0) {
        const capSql = this.maxTotalDials > 0 ? 'AND total_dials < :cap' : '';
        const [agg] = await db.query(
          `SELECT COUNT(*) AS queued, MIN(next_attempt_at) AS nextAt
             FROM call_logs WHERE campaign_id = :id AND status = 'queued' ${capSql}`,
          { id: this.id, cap: this.maxTotalDials }
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
      this._busySince = 0;
    }
  }

  async takeNext() {
    if (this.buffer.length === 0) {
      // Never pick a number that has already hit the lifetime dial cap.
      const capSql = this.maxTotalDials > 0 ? 'AND total_dials < :cap' : '';
      this.buffer = await db.query(
        `SELECT id, name, phone, attempts, total_dials FROM call_logs
           WHERE campaign_id = :id AND status = 'queued' ${capSql}
             AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP())
           ORDER BY id LIMIT 200`,
        { id: this.id, cap: this.maxTotalDials }
      );
    }
    return this.buffer.shift() || null;
  }

  async dispatch(row) {
    const client = ari.getClient();
    const channelId = `cb-${this.id}-${row.id}-${crypto.randomBytes(4).toString('hex')}`;
    const endpoint = config.dial.endpointTemplate.replace('{number}', row.phone);

    // Reserve the row + slot before the async originate so a concurrent pump
    // can't grab it again. globalLive tracks the trunk-wide budget.
    this.live.set(channelId, Date.now());
    globalLive += 1;
    try {
      await db.execute(
        `UPDATE call_logs
            SET status = 'dialing', channel = :channel, dial_start = UTC_TIMESTAMP(),
                attempts = attempts + 1, total_dials = total_dials + 1
          WHERE id = :id`,
        { channel: channelId, id: row.id }
      );
    } catch (err) {
      // Roll the reservation back — without this a transient DB error here
      // burned a concurrency slot forever (no activeCalls entry means
      // finalizeCall could never free it). The row stays 'queued' for a retry.
      this.live.delete(channelId);
      globalLive = Math.max(0, globalLive - 1);
      throw err;
    }
    activeCalls.set(channelId, {
      campaignId: this.id,
      callLogId: row.id,
      // Carried on every monitor event so the UI never shows a blank number,
      // even when it subscribed mid-campaign and missed the 'dialing' event.
      name: row.name,
      phone: row.phone,
      answered: false,
      media: this.media,
      mediaDuration: this.mediaDuration,
      guardTimer: null, // event-loss safety timer (armed below, re-armed per phase)
      dispatchedAt: Date.now(), // for the reaper's stale-call sweep
      runner: this,
      finalized: false,
      attempt: (row.attempts || 0) + 1, // this dial is attempt N
      totalDials: (row.total_dials || 0) + 1, // lifetime dials incl. this one
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

    // Arm the event-loss guard BEFORE originating: if the originate call hangs,
    // or the channel dies before its event subscription lands (the AMD/context
    // path is only subscribed after originate, so a fast SIP reject can beat
    // it), no ChannelDestroyed ever arrives — the guard finalizes instead of
    // leaking the slot. Answering re-arms it; finalizeCall clears it.
    armCallGuard(channelId, config.dial.originateTimeout + 60);

    // Hand the ARI half off WITHOUT awaiting it. The pump is single-flight
    // (_busy), so awaiting here made the whole campaign's dial rate hostage to
    // one HTTP round-trip: ARI can block an originate for the length of the
    // ring, which would drop a 20-line campaign to one call every 30 seconds.
    // Pacing is already enforced by the token bucket and the concurrency caps,
    // so the launch itself belongs off the pump.
    this.originate(client, opts, row, channelId).catch((e) =>
      logger.error(`Originate handling for ${row.phone} failed:`, e.message)
    );
  }

  // Launch the channel and wire up its events. Runs detached from the pump.
  async originate(client, opts, row, channelId) {
    try {
      // Bounded generously: ARI can hold this open for the ring, so the ceiling
      // must sit above the ring timeout or every slow answer looks like a hang.
      await withTimeout(
        client.channels.originate(opts),
        config.dial.originateTimeout + config.dial.ariRequestTimeout,
        'originate'
      );
    } catch (err) {
      if (err && err.ariTimeout) {
        // Asterisk may well have created the channel before going quiet, so
        // neither requeue (double call) nor finalize (lost slot) here — the
        // guard armed above hangs it up by id and finalizes the row either way.
        logger.warn(`Originate for ${row.phone} timed out — leaving it to the call guard`);
        return;
      }
      const msg = originateErrorText(err);
      // "Engine down" is not just socket errors: a restarting Asterisk answers
      // ARI over HTTP with a 503 "Shutdown in progress" page, and its status
      // code / HTML body is what surfaces here. Those numbers were never
      // dialed, so they must go back on the queue — marking them 'failed'
      // burns the list at full cps every time Asterisk bounces.
      const status = Number((err && (err.status || err.statusCode)) || 0);
      const engineDown =
        !ari.isConnected() ||
        (status >= 500 && status <= 599) ||
        /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|socket hang up|EPIPE/i.test(msg) ||
        /Shutdown in progress|Service Unavailable|Bad Gateway|Gateway Time-?out|50[0234]\s/i.test(msg);
      if (engineDown) {
        // The ENGINE failed, not the number — undo the whole attempt so the
        // row is redialed when Asterisk is back, instead of terminally burning
        // through the list at full cps during an outage.
        logger.warn(`Originate failed for ${row.phone} (engine down, will redial): ${msg}`);
        const call = activeCalls.get(channelId);
        if (call) {
          call.finalized = true;
          if (call.guardTimer) clearTimeout(call.guardTimer);
        }
        activeCalls.delete(channelId);
        this.live.delete(channelId);
        globalLive = Math.max(0, globalLive - 1);
        await db.execute(
          `UPDATE call_logs
              SET status = 'queued', channel = NULL, dial_start = NULL,
                  attempts = GREATEST(attempts, 1) - 1,
                  total_dials = GREATEST(total_dials, 1) - 1
            WHERE id = :id AND channel = :channel`,
          { id: row.id, channel: channelId }
        );
        return;
      }
      logger.warn(`Originate failed for ${row.phone}: ${msg}`);
      await finalizeCall(channelId, null, 'failed');
      return;
    }

    // Make sure we get this channel's lifecycle events even if it never enters
    // Stasis (busy / no-answer are reported via ChannelDestroyed). App-mode
    // originates are auto-subscribed, so this is only load-bearing for the
    // AMD/context path — where a fast SIP reject can also destroy the channel
    // BEFORE the subscription lands, losing its ChannelDestroyed. Probe once
    // after subscribing: if the channel is already gone (or can't be
    // subscribed), finalize now instead of holding the slot for the guard.
    if (this.amdEnabled) {
      try {
        await withTimeout(
          client.applications.subscribe({
            applicationName: config.ari.app,
            eventSource: `channel:${channelId}`,
          }),
          config.dial.ariRequestTimeout,
          'subscribe'
        );
        await withTimeout(client.channels.get({ channelId }), config.dial.ariRequestTimeout, 'channel get');
      } catch (_e) {
        try {
          await client.channels.hangup({ channelId });
        } catch (_e2) {}
        await finalizeCall(channelId, null, 'failed');
      }
    } else {
      client.applications
        .subscribe({ applicationName: config.ari.app, eventSource: `channel:${channelId}` })
        .catch((err) =>
          logger.warn(`Event subscribe failed for ${channelId} (guard will finalize): ${err.message}`)
        );
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Per-call event-loss guard. Every call MUST end in finalizeCall or its
// concurrency slot (runner.live / activeCalls / globalLive) leaks forever and
// the campaign silently stops dialing while staying "running". finalizeCall
// normally runs off ChannelDestroyed, but that event can be lost (AMD calls are
// only subscribed after originate, the ARI websocket can drop, a hangup's event
// can go missing) — so a deadline timer rides along from dispatch onward,
// re-armed at each phase, and force-finalizes if no event ever arrives.
function armCallGuard(channelId, seconds) {
  const call = activeCalls.get(channelId);
  if (!call) return;
  if (call.guardTimer) clearTimeout(call.guardTimer);
  call.guardTimer = setTimeout(() => {
    callGuardFired(channelId).catch((e) => logger.error(`Call guard ${channelId}:`, e.message));
  }, seconds * 1000);
}

async function callGuardFired(channelId) {
  const call = activeCalls.get(channelId);
  if (!call || call.finalized) return;
  logger.warn(`Call ${channelId} got no final event in time — force-finalizing (auto-cut)`);
  const client = ari.getClient();
  try {
    if (client) await withTimeout(client.channels.hangup({ channelId }), config.dial.ariRequestTimeout, 'hangup');
  } catch (_e) {
    /* channel may already be gone (a missed event) — finalize the row anyway */
  }
  // Finalize directly so the slot frees and the row gets an end_time even when
  // the channel was already dead and no ChannelDestroyed will ever come.
  await finalizeCall(channelId, 16 /* normal clearing */, call.answered ? 'answered' : undefined);
}

// ───────────────────────────────────────────────────────────────────────────
// ARI event handlers (registered on every (re)connect)
// ───────────────────────────────────────────────────────────────────────────
function registerHandlers(client) {
  client.removeAllListeners('StasisStart');
  client.removeAllListeners('StasisEnd');
  client.removeAllListeners('PlaybackFinished');
  client.removeAllListeners('ChannelDestroyed');

  // NOTE: handler bodies are wrapped in try/catch — ari-client is a plain
  // EventEmitter, so a rejected async listener becomes an unhandled rejection
  // and kills the whole process on one transient DB error.
  client.on('StasisStart', async (_event, channel) => {
   try {
    const call = activeCalls.get(channel.id);
    if (!call) return; // not one of ours

    // Answered: from here the call should end within maxCallSeconds whatever
    // happens (machine hangup, missing media, playback failure) — re-arm the
    // guard so a lost hangup event can't leak the slot.
    armCallGuard(channel.id, config.dial.maxCallSeconds);

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
      call.playbackStartedAt = Date.now();
      playbackIndex.set(playback.id, channel.id);
      // Tighten the guard to the recording's own length + buffer, so a call
      // that outlives its message is force-cut without ever cutting one short.
      armCallGuard(
        channel.id,
        call.mediaDuration > 0 ? call.mediaDuration + config.dial.hangupBufferSec : config.dial.maxCallSeconds
      );
    } catch (err) {
      logger.warn(`Playback failed on ${channel.id}: ${err.message}`);
      try {
        await channel.hangup();
      } catch (_e) {}
    }
   } catch (err) {
    logger.error(`StasisStart handler error on ${channel && channel.id}:`, err.message);
   }
  });

  // When the message finishes, hang up — that's the whole call for a broadcast.
  client.on('PlaybackFinished', async (_event, playback) => {
   try {
    const channelId = playbackIndex.get(playback.id);
    if (!channelId) return;
    playbackIndex.delete(playback.id);
    // Asterisk reports state 'failed' for BOTH a media problem (missing or
    // unplayable file) and the ordinary case of the callee hanging up
    // mid-message — which is routine in a broadcast. Tell them apart by how
    // far the recording got: a media problem fails almost instantly, a hangup
    // happens seconds in. Only the former is worth alarming about.
    if (playback.state === 'failed') {
      const call = activeCalls.get(channelId);
      const playedMs = call && call.playbackStartedAt ? Date.now() - call.playbackStartedAt : null;
      if (playedMs !== null && playedMs < 1500) {
        logger.error(
          `Recording did NOT play on ${channelId} (${(call && call.media) || 'unknown media'}) — ` +
            `failed after ${playedMs}ms, so the callee heard silence. Check the file exists under ` +
            `AUDIO_DIR and is 8kHz 16-bit mono WAV that Asterisk can open.`
        );
      } else {
        logger.info(`Playback cut short on ${channelId} after ${playedMs}ms (callee hung up)`);
      }
    }
    // The recording finished normally — hang up now. Keep a short guard armed
    // instead of clearing it: if this hangup (or its ChannelDestroyed event) is
    // lost, the guard still finalizes the call rather than leaking its slot.
    armCallGuard(channelId, config.dial.hangupBufferSec);
    try {
      await client.channels.hangup({ channelId });
    } catch (_e) {}
   } catch (err) {
    logger.error(`PlaybackFinished handler error:`, err.message);
   }
  });

  client.on('ChannelDestroyed', async (event, channel) => {
   try {
    const id = channel.id || (event.channel && event.channel.id);
    await finalizeCall(id, event.cause, null);
   } catch (err) {
    logger.error(`ChannelDestroyed handler error:`, err.message);
   }
  });
}

// Finalize a single call: write outcome, free the slot, nudge the runner.
async function finalizeCall(channelId, cause, forcedStatus) {
  const call = activeCalls.get(channelId);
  if (!call || call.finalized) return;
  call.finalized = true;
  activeCalls.delete(channelId);
  globalLive = Math.max(0, globalLive - 1);
  if (call.guardTimer) clearTimeout(call.guardTimer);
  if (call.playbackId) playbackIndex.delete(call.playbackId);

  const runner = runners.get(call.campaignId);
  // Free the concurrency slot BEFORE any await: once the activeCalls entry is
  // gone, nothing could ever remove the channelId from runner.live again, and
  // a single zombie entry blocks the completion check forever. If a DB write
  // below fails, the row is left 'dialing' and the reaper finalizes it.
  if (runner) runner.live.delete(channelId);

  const status = forcedStatus || call.outcome || mapCause(cause, call.answered);
  const causeVal = cause == null ? null : Number(cause);

  // Retry? Requeue instead of finalizing when the outcome is retryable, the
  // number still has attempts left, and it's under the lifetime dial cap.
  const willRetry =
    runner &&
    shouldRetry(status, call.attempt, runner.maxAttempts, runner.retryOn, call.totalDials, runner.maxTotalDials);

  try {
    // Both writes are guarded by `channel = :channel` so a STALE finalize — a
    // guard timer firing after a stop/rerun already reset this row, or after
    // the row was re-dialed on a new channel — matches nothing instead of
    // clobbering (or double-queueing) the row out from under the new run.
    if (willRetry) {
      const res = await db.execute(
        `UPDATE call_logs
            SET status = 'queued',
                channel = NULL,
                hangup_cause = :cause,
                end_time = UTC_TIMESTAMP(),
                duration_sec = TIMESTAMPDIFF(SECOND, COALESCE(answer_time, dial_start), UTC_TIMESTAMP()),
                next_attempt_at = CASE WHEN :delay > 0
                                       THEN DATE_ADD(UTC_TIMESTAMP(), INTERVAL :delay MINUTE)
                                       ELSE NULL END
          WHERE id = :id AND channel = :channel`,
        { cause: causeVal, delay: runner.retryDelayMin, id: call.callLogId, channel: channelId }
      );
      if (res.affectedRows > 0) {
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
        runner.nextRetryAt = null; // a new (possibly sooner) retry exists — recompute
      }
      return;
    }

    const res = await db.execute(
      `UPDATE call_logs
          SET status = :status,
              hangup_cause = :cause,
              end_time = UTC_TIMESTAMP(),
              duration_sec = TIMESTAMPDIFF(SECOND, COALESCE(answer_time, dial_start), UTC_TIMESTAMP())
        WHERE id = :id AND channel = :channel`,
      { status, cause: causeVal, id: call.callLogId, channel: channelId }
    );
    if (res.affectedRows > 0) {
      monitor.publish(call.campaignId, {
        type: 'call',
        callLogId: call.callLogId,
        name: call.name,
        phone: call.phone,
        status,
        attempt: call.attempt,
        at: new Date().toISOString(),
      });
    }
  } finally {
    if (runner) runner.pump(); // fill the freed slot / check completion
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Campaign lifecycle
// ───────────────────────────────────────────────────────────────────────────
async function loadCampaignRow(campaignId) {
  const rows = await db.query(
    `SELECT c.*, ci.number AS caller_number,
            a.stored_filename AS audio_stored, a.duration_sec AS audio_duration
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
        SET status = 'running', stop_reason = NULL,
            started_at = COALESCE(started_at, UTC_TIMESTAMP())
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

// The non-answered outcomes a rerun can redial ('answered'/'machine' are the
// reached ones and are never included). 'queued' = never dialed (stopped).
const RERUN_UNREACHED = ['busy', 'no_answer', 'failed', 'congestion', 'queued'];

// Re-dial a finished (completed/stopped) campaign. scope:
//   'all'       — reset every number and dial the whole list again from scratch
//   'unreached' — reset only not-reached numbers; `statuses` optionally narrows
//                 to a chosen subset of RERUN_UNREACHED (defaults to all of them)
async function rerunCampaign(campaignId, scope, statuses) {
  // Clear any lingering runner so we start from a clean slate.
  const existing = runners.get(campaignId);
  if (existing) {
    existing.pause();
    await existing.hangupAll();
    runners.delete(campaignId);
  }

  // Wipe the per-attempt state so the number is eligible to dial again and the
  // retry logic (max_attempts) applies afresh. `total_dials` is deliberately NOT
  // reset. Numbers that already hit the lifetime cap are left out of the run.
  const reset = `status = 'queued', channel = NULL, hangup_cause = NULL, attempts = 0,
                 next_attempt_at = NULL, dial_start = NULL, answer_time = NULL,
                 end_time = NULL, duration_sec = NULL`;
  const cap = config.calls.maxTotalDials;
  const capSql = cap > 0 ? 'AND total_dials < :cap' : '';
  if (scope === 'unreached') {
    const chosen =
      Array.isArray(statuses) && statuses.length
        ? statuses.filter((s) => RERUN_UNREACHED.includes(s))
        : RERUN_UNREACHED;
    if (chosen.length === 0) return; // nothing selected — no-op, campaign stays finished
    const placeholders = chosen.map((_, i) => `:st${i}`).join(',');
    const params = { id: campaignId, cap };
    chosen.forEach((s, i) => (params[`st${i}`] = s));
    // Everything is out of this run except the chosen not-reached, under-cap numbers.
    await db.execute('UPDATE call_logs SET in_run = 0 WHERE campaign_id = :id', { id: campaignId });
    await db.execute(
      `UPDATE call_logs SET ${reset}, in_run = 1
        WHERE campaign_id = :id AND status IN (${placeholders}) ${capSql}`,
      params
    );
  } else {
    // Redial all under-cap numbers; capped ones stay finished and out of the run.
    await db.execute('UPDATE call_logs SET in_run = 0 WHERE campaign_id = :id', { id: campaignId });
    await db.execute(
      `UPDATE call_logs SET ${reset}, in_run = 1 WHERE campaign_id = :id ${capSql}`,
      { id: campaignId, cap }
    );
  }

  // Pace this run from how many numbers it actually dials (not the whole list),
  // so a small "redial unreached" run gets a sensibly small CPS.
  const [{ n: runCount }] = await db.query(
    'SELECT COUNT(*) AS n FROM call_logs WHERE campaign_id = :id AND in_run = 1',
    { id: campaignId }
  );
  const pace = config.autoPace(Math.max(1, Number(runCount)));

  // Fresh run: drop the previous status/timestamps so started_at reflects this
  // run, record the re-run scope, and apply the recomputed pace.
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

// Apply a live edit (caller ID / recording changed while running or paused) to
// the in-memory runner so numbers not yet dialed use the new values. Calls
// already in progress keep whatever they started with. No-op if no runner.
async function refreshCampaign(campaignId) {
  const runner = runners.get(campaignId);
  if (!runner) return;
  const c = await loadCampaignRow(campaignId);
  if (!c) return;
  runner.callerId = c.caller_number || null;
  runner.media = c.audio_stored ? `sound:${path.posix.join('callbot', c.audio_stored)}` : null;
  runner.mediaDuration = Number(c.audio_duration) || 0;
  logger.info(`Campaign ${campaignId} runner refreshed (callerId/media updated)`);
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
  // Write the terminal status FIRST: if this update fails transiently, the
  // runner is still alive and its next pump tick retries the finalize. The old
  // order (runner torn down, then update) left the campaign 'running' forever
  // with no runner when this one write failed.
  await db.execute(
    'UPDATE campaigns SET status = :status, completed_at = UTC_TIMESTAMP() WHERE id = :id',
    { status, id: campaignId }
  );
  const runner = runners.get(campaignId);
  if (runner) {
    runner.pause();
    runners.delete(campaignId);
  }
  monitor.publish(campaignId, { type: 'campaign', status });
  logger.info(`Campaign ${campaignId} ${status}`);
}

// ───────────────────────────────────────────────────────────────────────────
// Scheduler + boot resume
// ───────────────────────────────────────────────────────────────────────────
// A flapping ARI websocket can fire recovery again while the previous one is
// still running its awaited DB work. Two overlapping recoveries interleave
// badly (one requeues rows the other just dispatched, clears the slots the
// other just reserved), so they are serialized: a new one always runs AFTER
// the one in flight, never alongside it.
let recoveryChain = Promise.resolve();

// True only while recovery is resetting state. The pump checks it instead of
// recovery pausing the runners: a paused runner stays paused if recovery dies
// or hangs partway, which silently freezes EVERY campaign. A flag in a
// `finally` always clears, so the worst case is a brief pause in dialing.
let recovering = false;

function onConnect(client) {
  recoveryChain = recoveryChain.then(
    () => runRecovery(client),
    () => runRecovery(client) // a failed recovery must not block the next one
  );
  return recoveryChain;
}

async function runRecovery(client) {
  recovering = true;
  try {
    await recoverState(client);
  } finally {
    recovering = false;
  }
}

async function recoverState(client) {
  registerHandlers(client);

  // A reconnect orphans any in-flight channels; reset them so they get redialed.
  // Scope to voice campaigns so an ARI reconnect never touches an SMS campaign's
  // in-flight ('dialing') rows, which the SMS engine owns.
  // A row already AT the lifetime dial cap must not go (or stay) 'queued' — the
  // dial queue filters capped rows out, so it could never be dialed again and
  // would sit 'queued' forever. Close such rows out as failed instead ('queued'
  // ones are legacy strays from before this fix; this heals them at boot).
  if (config.calls.maxTotalDials > 0) {
    await db.execute(
      `UPDATE call_logs
          SET status = 'failed', channel = NULL, end_time = UTC_TIMESTAMP(),
              duration_sec = TIMESTAMPDIFF(SECOND, COALESCE(answer_time, dial_start), UTC_TIMESTAMP())
        WHERE status IN ('dialing', 'queued') AND total_dials >= :cap
          AND campaign_id IN (SELECT id FROM campaigns WHERE channel = 'voice')`,
      { cap: config.calls.maxTotalDials }
    );
  }
  // Those orphaned channels may still be UP in Asterisk (a websocket drop
  // doesn't hang up calls). Since their rows go back on the queue below, drop
  // the channels first — otherwise the number is redialed while the previous
  // call is still live, and the stray channel plays to nobody and holds a
  // trunk line no counter knows about. Best-effort: already-dead ids 404.
  const orphans = await db.query(
    `SELECT channel FROM call_logs
      WHERE status = 'dialing' AND channel IS NOT NULL
        AND campaign_id IN (SELECT id FROM campaigns WHERE channel = 'voice')
      LIMIT 500`
  );
  // Fire these off without awaiting: ari-client sets no request timeout, so a
  // single unresponsive hangup would stall recovery — and with it every
  // campaign — indefinitely. Best-effort is the right bar here; the rows are
  // requeued either way, and the reaper catches anything still live.
  for (const o of orphans) {
    Promise.resolve()
      .then(() => client.channels.hangup({ channelId: o.channel }))
      .catch(() => {
        /* already gone, or ARI busy — nothing to do */
      });
  }
  await db.execute(
    `UPDATE call_logs SET status = 'queued', channel = NULL
      WHERE status = 'dialing'
        AND campaign_id IN (SELECT id FROM campaigns WHERE channel = 'voice')`
  );
  // A call that had already ANSWERED before the reconnect/restart has lost its
  // channel — finalize it (it WAS reached) so it becomes terminal instead of
  // sitting 'answered' with no end_time, which freezes it on the Live Monitor
  // with a runaway timer.
  await db.execute(
    `UPDATE call_logs
        SET end_time = UTC_TIMESTAMP(),
            duration_sec = TIMESTAMPDIFF(SECOND, COALESCE(answer_time, dial_start), UTC_TIMESTAMP())
      WHERE status = 'answered' AND end_time IS NULL
        AND campaign_id IN (SELECT id FROM campaigns WHERE channel = 'voice')`
  );
  for (const call of activeCalls.values()) {
    if (call.guardTimer) clearTimeout(call.guardTimer);
  }
  activeCalls.clear();
  playbackIndex.clear();
  globalLive = 0;
  // Runners survive an ARI reconnect (only a full restart clears them). Their
  // live sets still hold the orphaned channels we just reset — and nothing can
  // ever remove those entries now that activeCalls is empty. Left in place they
  // permanently eat concurrency slots (and even ONE blocks the completion
  // check), so the campaign would silently stop dialing while stuck "running".
  for (const runner of runners.values()) {
    runner.live.clear();
    runner.buffer = [];
    runner.nextRetryAt = null;
  }

  // Resume voice campaigns that were running before a restart. SMS campaigns
  // are resumed independently by smsSender (they don't use ARI).
  const running = await db.query(
    "SELECT id FROM campaigns WHERE status = 'running' AND channel = 'voice'"
  );
  for (const c of running) {
    try {
      await startCampaign(c.id);
    } catch (e) {
      logger.error(`Could not resume campaign ${c.id}:`, e.message);
      // Kill any surviving runner FIRST — writing 'stopped' while a live
      // runner keeps ticking would let calls silently go out on a campaign
      // the operator sees as stopped.
      const r = runners.get(c.id);
      if (r) {
        r.pause();
        runners.delete(c.id);
      }
      // ARI dropped again mid-resume: leave the campaign 'running' — the next
      // reconnect runs this recovery again and resumes it then.
      if (!ari.isConnected()) continue;
      // Any other failure: never leave it stuck 'running' with no runner —
      // stop it with the reason so the operator sees it and can press Start.
      await db
        .execute(
          `UPDATE campaigns
              SET status = 'stopped', stop_reason = :reason, completed_at = UTC_TIMESTAMP()
            WHERE id = :id AND status = 'running'`,
          { reason: `Could not resume after restart: ${e.message}`.slice(0, 255), id: c.id }
        )
        .catch(() => {});
      monitor.publish(c.id, { type: 'campaign', status: 'stopped' });
    }
  }
}

// Belt for the per-call guard: finalize any voice call still 'dialing'/'answered'
// with no end_time long past when it could still be live — e.g. orphaned by a
// process crash mid-call, or an ARI event that was fully lost. Never touches a
// call we're still actively tracking, and only rows well older than any real
// call, so it can't cut a live one.
async function reapStuckCalls() {
  try {
    const cutoff = config.dial.maxCallSeconds + 120; // generous — beyond any real call

    // In-memory sweep first: a tracked call this old has lost its events AND
    // its guard timer (which fires well inside this threshold — including for a
    // recording longer than maxCallSeconds). finalizeCall frees its
    // runner/global slots properly — without this, one such call blocks its
    // campaign's completion forever and the row below is skipped as "tracked".
    for (const [channelId, call] of [...activeCalls]) {
      // Ring time + the longest legitimate talk phase + slack, so the sweep
      // can never beat a properly armed guard on a live call.
      const staleSec =
        config.dial.originateTimeout +
        Math.max(config.dial.maxCallSeconds, call.mediaDuration + config.dial.hangupBufferSec) +
        120;
      if (call.dispatchedAt && Date.now() - call.dispatchedAt > staleSec * 1000) {
        logger.warn(`Reaping stuck in-memory call ${channelId}`);
        await callGuardFired(channelId);
      }
    }

    const activeIds = new Set([...activeCalls.values()].map((c) => c.callLogId));
    const rows = await db.query(
      `SELECT id FROM call_logs
         WHERE status IN ('dialing','answered') AND end_time IS NULL
           AND dial_start < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :cutoff SECOND)
           AND campaign_id IN (SELECT id FROM campaigns WHERE channel = 'voice')`,
      { cutoff }
    );
    let reaped = 0;
    for (const r of rows) {
      if (activeIds.has(r.id)) continue; // still tracking this one — leave it
      const res = await db.execute(
        `UPDATE call_logs
            SET status = CASE WHEN answer_time IS NOT NULL THEN 'answered' ELSE 'failed' END,
                end_time = UTC_TIMESTAMP(),
                duration_sec = TIMESTAMPDIFF(SECOND, COALESCE(answer_time, dial_start), UTC_TIMESTAMP())
          WHERE id = :id AND end_time IS NULL`,
        { id: r.id }
      );
      reaped += res.affectedRows > 0 ? 1 : 0;
    }
    if (reaped) logger.warn(`Reaped ${reaped} stuck voice call row(s)`);
  } catch (e) {
    logger.error('Stuck-call reaper error:', e.message);
  }
}

// Self-heal: a campaign whose DB status is 'running' must have a live runner.
// If one is missing or sitting paused — a recovery that died partway, a
// finalize that half-completed, any future bug of that shape — the campaign
// silently stops dialing while looking healthy. Reconcile every minute so it
// resumes on its own instead of waiting for someone to restart the process.
async function reconcileRunners() {
  if (recovering || !ari.isConnected()) return;
  try {
    const running = await db.query(
      "SELECT id FROM campaigns WHERE status = 'running' AND channel = 'voice'"
    );
    for (const c of running) {
      const runner = runners.get(c.id);
      if (runner && runner.running) {
        // A "running" runner can still be wedged: an await that never settles
        // pins _busy, and stale live entries (whose calls are long gone) eat
        // the concurrency slots the dial loop checks. Neither logs anything,
        // so break both here rather than wait for a diagnosis of the next
        // unbounded call. This is the generic stall-breaker.
        if (runner._busySince && Date.now() - runner._busySince > STUCK_PUMP_MS) {
          logger.warn(
            `Campaign ${c.id} pump stuck for ${Math.round((Date.now() - runner._busySince) / 1000)}s — resetting it`
          );
          runner._busy = false;
          runner._busySince = 0;
          runner.buffer = [];
        }
        // Only prune slots that are BOTH untracked and older than any call
        // could be. A slot is reserved a moment before its activeCalls entry
        // exists, so pruning on "untracked" alone frees calls that are just
        // starting — which is worse than the leak it was meant to fix.
        const staleBefore = Date.now() - liveSlotStaleMs();
        for (const [channelId, addedAt] of [...runner.live]) {
          if (!activeCalls.has(channelId) && addedAt < staleBefore) {
            logger.warn(`Campaign ${c.id} holding a stale slot for ${channelId} — freeing it`);
            runner.live.delete(channelId);
            globalLive = Math.max(0, globalLive - 1);
          }
        }
        continue; // healthy (or just unwedged)
      }
      logger.warn(`Campaign ${c.id} is 'running' with ${runner ? 'a paused' : 'no'} runner — restarting it`);
      await startCampaign(c.id).catch((e) =>
        logger.error(`Could not restart campaign ${c.id}:`, e.message)
      );
    }
  } catch (e) {
    logger.error('Runner reconcile error:', e.message);
  }
}

async function checkScheduled() {
  try {
    const due = await db.query(
      "SELECT id FROM campaigns WHERE status = 'scheduled' AND channel = 'voice' AND scheduled_at <= UTC_TIMESTAMP()"
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
  reaperTimer = setInterval(reapStuckCalls, 60000);
  reconcileTimer = setInterval(reconcileRunners, 60000);
}

function stop() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (reaperTimer) clearInterval(reaperTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
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
  refreshCampaign,
  // exported for unit tests
  _internal: { mapCause, shouldRetry },
};
