'use strict';

const express = require('express');
const fs = require('fs');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const { ApiError, asyncHandler } = require('../http');
const { requireAuth } = require('../middleware/auth');
const { resolveTmpUpload } = require('../middleware/upload');
const { extractContacts } = require('../services/fileParser');
const dialer = require('../services/dialer');

const router = express.Router();
router.use(requireAuth);

// Trunk capacity, so the UI can show the auto-pacing ceiling.
router.get('/meta/pacing', (_req, res) => {
  res.json({ maxConcurrent: config.calls.maxConcurrent, maxCps: config.calls.maxCps });
});

// Preview the pace a list of this size would get (speed + estimated finish
// time), so the New Campaign screen can show it before the campaign exists.
router.get('/meta/pace', (req, res) => {
  const count = Math.max(0, parseInt(req.query.count, 10) || 0);
  res.json(config.autoPace(count));
});

async function getOwnedCampaign(id, uid) {
  const rows = await db.query('SELECT * FROM campaigns WHERE id = :id AND user_id = :uid', {
    id,
    uid,
  });
  if (!rows[0]) throw new ApiError(404, 'Campaign not found');
  return rows[0];
}

// List campaigns with rolled-up call counts. Paginated (default 25/page);
// dropdown consumers (Monitor, Reports) pass a larger pageSize.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const offset = (page - 1) * pageSize;

    const [{ n: total }] = await db.query(
      'SELECT COUNT(*) AS n FROM campaigns WHERE user_id = :uid',
      { uid: req.user.id }
    );
    const rows = await db.query(
      `SELECT c.id, c.name, c.status, c.intensity_level, c.cps, c.max_concurrent,
              c.schedule_type, c.scheduled_at, c.total_contacts, c.created_at,
              c.started_at, c.completed_at,
              ci.label AS caller_label, ci.number AS caller_number, a.name AS audio_name,
              COALESCE(s.total, 0)    AS dialed,
              COALESCE(s.answered, 0) AS answered,
              COALESCE(s.completed, 0) AS completed
         FROM campaigns c
         LEFT JOIN caller_ids ci ON ci.id = c.caller_id_id
         LEFT JOIN audio_files a ON a.id = c.audio_file_id
         LEFT JOIN (
              SELECT campaign_id,
                     COUNT(*) AS total,
                     SUM(status = 'answered') AS answered,
                     SUM(status NOT IN ('queued','dialing')) AS completed
                FROM call_logs GROUP BY campaign_id
         ) s ON s.campaign_id = c.id
        WHERE c.user_id = :uid
        ORDER BY c.created_at DESC
        LIMIT :limit OFFSET :offset`,
      { uid: req.user.id, limit: pageSize, offset }
    );
    res.json({ campaigns: rows, total: Number(total), page, pageSize });
  })
);

const createSchema = z.object({
  name: z.string().min(1).max(128),
  callerIdId: z.coerce.number().int().positive().nullable().optional(),
  audioFileId: z.coerce.number().int().positive(),
  scheduleType: z.enum(['now', 'scheduled']),
  scheduledAt: z.string().datetime().optional(),
  maxAttempts: z.coerce.number().int().min(1).max(5).optional(),
  retryDelayMin: z.coerce.number().int().min(0).max(1440).optional(),
  retryOn: z.array(z.enum(['busy', 'no_answer', 'congestion', 'failed'])).optional(),
  amdEnabled: z.boolean().optional(),
  contacts: z.object({
    uploadId: z.string().min(1),
    nameColumn: z.string().optional(),
    numberColumn: z.string().min(1),
  }),
});

const DEFAULT_RETRY_ON = ['busy', 'no_answer', 'congestion', 'failed'];

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid campaign data', parsed.error.flatten());
    }
    const d = parsed.data;

    // Validate referenced audio (required) + caller ID (optional) belong to user.
    const audio = await db.query(
      "SELECT id FROM audio_files WHERE id = :id AND user_id = :uid AND status = 'ready'",
      { id: d.audioFileId, uid: req.user.id }
    );
    if (!audio[0]) throw new ApiError(400, 'Audio file not found or not ready');

    if (d.callerIdId) {
      const cid = await db.query('SELECT id FROM caller_ids WHERE id = :id AND user_id = :uid', {
        id: d.callerIdId,
        uid: req.user.id,
      });
      if (!cid[0]) throw new ApiError(400, 'Caller ID not found');
    }

    let scheduledAtSql = null;
    if (d.scheduleType === 'scheduled') {
      if (!d.scheduledAt) throw new ApiError(400, 'scheduledAt is required for scheduled campaigns');
      const when = new Date(d.scheduledAt);
      if (Number.isNaN(when.getTime())) throw new ApiError(400, 'Invalid scheduledAt');
      scheduledAtSql = when.toISOString().slice(0, 19).replace('T', ' '); // UTC DATETIME
    }

    // Read + normalize contacts before creating the campaign so a bad file fails fast.
    const filePath = resolveTmpUpload(d.contacts.uploadId);
    const { contacts, valid, invalid, total } = extractContacts(
      filePath,
      d.contacts.nameColumn,
      d.contacts.numberColumn
    );
    if (valid === 0) {
      throw new ApiError(400, 'No valid phone numbers found in the selected number column');
    }

    const maxAttempts = d.maxAttempts || 1;
    const retryDelayMin = d.retryDelayMin || 0;
    const retryOn = (d.retryOn && d.retryOn.length ? d.retryOn : DEFAULT_RETRY_ON).join(',');

    // Auto-pace from the list size, capped to the trunk's capacity. intensity_level
    // is kept as 0 to mark "auto" (the column stays for history/back-compat).
    const pace = config.autoPace(valid);

    const initialStatus = d.scheduleType === 'scheduled' ? 'scheduled' : 'draft';
    const result = await db.execute(
      `INSERT INTO campaigns
         (user_id, name, caller_id_id, audio_file_id, intensity_level, cps, max_concurrent,
          max_attempts, retry_delay_min, retry_on, amd_enabled,
          schedule_type, scheduled_at, status, total_contacts)
       VALUES
         (:uid, :name, :callerId, :audio, 0, :cps, :max,
          :maxAttempts, :retryDelay, :retryOn, :amd,
          :stype, :sched, :status, :total)`,
      {
        uid: req.user.id,
        name: d.name,
        callerId: d.callerIdId || null,
        audio: d.audioFileId,
        cps: pace.cps,
        max: pace.maxConcurrent,
        maxAttempts,
        retryDelay: retryDelayMin,
        retryOn,
        amd: d.amdEnabled ? 1 : 0,
        stype: d.scheduleType,
        sched: scheduledAtSql,
        status: initialStatus,
        total: valid,
      }
    );
    const campaignId = result.insertId;

    // Bulk-insert contacts in chunks. Built with named placeholders (the pool
    // runs in namedPlaceholders mode) rather than the `VALUES ?` array form.
    for (let i = 0; i < contacts.length; i += 1000) {
      const chunk = contacts.slice(i, i + 1000);
      const tuples = [];
      const params = { cid: campaignId };
      chunk.forEach((c, j) => {
        tuples.push(`(:cid, :name${j}, :phone${j})`);
        params[`name${j}`] = c.name;
        params[`phone${j}`] = c.phone;
      });
      await db.query(
        `INSERT INTO contacts (campaign_id, name, phone) VALUES ${tuples.join(',')}`,
        params
      );
    }
    fs.promises.unlink(filePath).catch(() => {});

    // Run-now: kick off the dialer immediately.
    let warning = null;
    if (d.scheduleType === 'now') {
      try {
        await dialer.startCampaign(campaignId);
      } catch (e) {
        warning = `Campaign created but could not start: ${e.message}`;
      }
    }

    const fresh = await getOwnedCampaign(campaignId, req.user.id);
    res.status(201).json({
      campaign: fresh,
      contactsSummary: { total, valid, invalid },
      pace,
      ...(warning ? { warning } : {}),
    });
  })
);

// Detail with per-status counts.
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const campaign = await getOwnedCampaign(req.params.id, req.user.id);
    const counts = await db.query(
      `SELECT status, COUNT(*) AS n FROM call_logs WHERE campaign_id = :id GROUP BY status`,
      { id: campaign.id }
    );
    const byStatus = {};
    counts.forEach((r) => (byStatus[r.status] = Number(r.n)));
    res.json({ campaign, counts: byStatus });
  })
);

// Live snapshot for the monitoring tab (calls currently in progress + counts).
router.get(
  '/:id/monitor',
  asyncHandler(async (req, res) => {
    const campaign = await getOwnedCampaign(req.params.id, req.user.id);
    // Only calls that are truly still up. 'answered' stays as the status after a
    // call ends, so without the end_time filter this returned every answered
    // number ever — that's what made the old monitor a firehose of stale rows.
    const active = await db.query(
      `SELECT id AS callLogId, name, phone, status, dial_start, answer_time
         FROM call_logs
        WHERE campaign_id = :id AND status IN ('dialing','answered') AND end_time IS NULL
        ORDER BY dial_start DESC LIMIT 200`,
      { id: campaign.id }
    );
    const counts = await db.query(
      `SELECT status, COUNT(*) AS n FROM call_logs WHERE campaign_id = :id GROUP BY status`,
      { id: campaign.id }
    );
    const byStatus = {};
    counts.forEach((r) => (byStatus[r.status] = Number(r.n)));
    res.json({ status: campaign.status, counts: byStatus, active });
  })
);

// Control endpoints.
router.post(
  '/:id/start',
  asyncHandler(async (req, res) => {
    const campaign = await getOwnedCampaign(req.params.id, req.user.id);
    if (['running', 'completed'].includes(campaign.status)) {
      throw new ApiError(409, `Campaign is already ${campaign.status}`);
    }
    await dialer.startCampaign(campaign.id);
    res.json({ ok: true, status: 'running' });
  })
);

router.post(
  '/:id/pause',
  asyncHandler(async (req, res) => {
    const campaign = await getOwnedCampaign(req.params.id, req.user.id);
    if (campaign.status !== 'running') throw new ApiError(409, 'Campaign is not running');
    await dialer.pauseCampaign(campaign.id);
    res.json({ ok: true, status: 'paused' });
  })
);

router.post(
  '/:id/stop',
  asyncHandler(async (req, res) => {
    const campaign = await getOwnedCampaign(req.params.id, req.user.id);
    await dialer.stopCampaign(campaign.id);
    res.json({ ok: true, status: 'stopped' });
  })
);

// Re-run a finished (completed/stopped) campaign. scope=all re-dials the whole
// list; scope=unreached re-dials only numbers that were never answered. The pace
// is re-computed from current settings, then the dialer resets the call logs and
// starts.
router.post(
  '/:id/rerun',
  asyncHandler(async (req, res) => {
    const campaign = await getOwnedCampaign(req.params.id, req.user.id);
    if (['running', 'paused', 'scheduled'].includes(campaign.status)) {
      throw new ApiError(409, 'Campaign is still active — stop it first');
    }
    const scope = req.body && req.body.scope === 'unreached' ? 'unreached' : 'all';

    const pace = config.autoPace(campaign.total_contacts);
    await db.execute('UPDATE campaigns SET cps = :cps, max_concurrent = :max WHERE id = :id', {
      cps: pace.cps,
      max: pace.maxConcurrent,
      id: campaign.id,
    });
    await dialer.rerunCampaign(campaign.id, scope);
    res.json({ ok: true, status: 'running', scope, pace });
  })
);

// Edit a campaign that hasn't run yet (draft/scheduled): name, audio, caller
// ID, retry settings, AMD, and schedule. The contact list itself can't change —
// create a new campaign for a different list. Pace isn't recomputed (it depends
// only on list size and trunk caps, neither of which changes here).
const editSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  callerIdId: z.coerce.number().int().positive().nullable().optional(),
  audioFileId: z.coerce.number().int().positive().optional(),
  maxAttempts: z.coerce.number().int().min(1).max(5).optional(),
  retryDelayMin: z.coerce.number().int().min(0).max(1440).optional(),
  retryOn: z.array(z.enum(['busy', 'no_answer', 'congestion', 'failed'])).optional(),
  amdEnabled: z.boolean().optional(),
  scheduleType: z.enum(['now', 'scheduled']).optional(),
  scheduledAt: z.string().datetime().optional(),
});
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const campaign = await getOwnedCampaign(req.params.id, req.user.id);
    if (!['draft', 'scheduled'].includes(campaign.status)) {
      throw new ApiError(409, 'Only campaigns that have not started can be edited');
    }
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Invalid campaign data', parsed.error.flatten());
    const d = parsed.data;

    if (d.audioFileId !== undefined) {
      const audio = await db.query(
        "SELECT id FROM audio_files WHERE id = :id AND user_id = :uid AND status = 'ready'",
        { id: d.audioFileId, uid: req.user.id }
      );
      if (!audio[0]) throw new ApiError(400, 'Audio file not found or not ready');
    }
    if (d.callerIdId) {
      const cid = await db.query('SELECT id FROM caller_ids WHERE id = :id AND user_id = :uid', {
        id: d.callerIdId,
        uid: req.user.id,
      });
      if (!cid[0]) throw new ApiError(400, 'Caller ID not found');
    }

    const sets = [];
    const params = { id: campaign.id };
    if (d.name !== undefined) {
      sets.push('name = :name');
      params.name = d.name;
    }
    if (d.callerIdId !== undefined) {
      sets.push('caller_id_id = :callerId');
      params.callerId = d.callerIdId || null;
    }
    if (d.audioFileId !== undefined) {
      sets.push('audio_file_id = :audio');
      params.audio = d.audioFileId;
    }
    if (d.maxAttempts !== undefined) {
      sets.push('max_attempts = :maxAttempts');
      params.maxAttempts = d.maxAttempts;
    }
    if (d.retryDelayMin !== undefined) {
      sets.push('retry_delay_min = :retryDelay');
      params.retryDelay = d.retryDelayMin;
    }
    if (d.retryOn !== undefined) {
      // An empty selection means "never retry" — coherent with maxAttempts = 1.
      sets.push('retry_on = :retryOn');
      params.retryOn = d.retryOn.join(',');
    }
    if (d.amdEnabled !== undefined) {
      sets.push('amd_enabled = :amd');
      params.amd = d.amdEnabled ? 1 : 0;
    }
    if (d.scheduleType === 'scheduled') {
      if (!d.scheduledAt) throw new ApiError(400, 'scheduledAt is required');
      const when = new Date(d.scheduledAt);
      if (Number.isNaN(when.getTime())) throw new ApiError(400, 'Invalid scheduledAt');
      sets.push("schedule_type = 'scheduled'", 'scheduled_at = :sched', "status = 'scheduled'");
      params.sched = when.toISOString().slice(0, 19).replace('T', ' ');
    } else if (d.scheduleType === 'now') {
      // Back to manual: cleared schedule, waits for the Start button.
      sets.push("schedule_type = 'now'", 'scheduled_at = NULL', "status = 'draft'");
    }
    if (sets.length === 0) throw new ApiError(400, 'Nothing to update');

    await db.execute(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = :id`, params);
    const fresh = await getOwnedCampaign(campaign.id, req.user.id);
    res.json({ ok: true, campaign: fresh });
  })
);

// Change the schedule of a campaign that hasn't run yet (draft/scheduled).
const scheduleSchema = z.object({
  scheduleType: z.enum(['now', 'scheduled']),
  scheduledAt: z.string().datetime().optional(),
});
router.patch(
  '/:id/schedule',
  asyncHandler(async (req, res) => {
    const campaign = await getOwnedCampaign(req.params.id, req.user.id);
    if (!['draft', 'scheduled'].includes(campaign.status)) {
      throw new ApiError(409, 'Can only change the schedule before a campaign runs — use Re-run for finished ones');
    }
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Invalid schedule');
    const d = parsed.data;

    if (d.scheduleType === 'now') {
      await db.execute(
        "UPDATE campaigns SET schedule_type = 'now', scheduled_at = NULL WHERE id = :id",
        { id: campaign.id }
      );
      await dialer.startCampaign(campaign.id);
      return res.json({ ok: true, status: 'running' });
    }
    if (!d.scheduledAt) throw new ApiError(400, 'scheduledAt is required');
    const when = new Date(d.scheduledAt);
    if (Number.isNaN(when.getTime())) throw new ApiError(400, 'Invalid scheduledAt');
    const sql = when.toISOString().slice(0, 19).replace('T', ' ');
    await db.execute(
      "UPDATE campaigns SET schedule_type = 'scheduled', scheduled_at = :sched, status = 'scheduled' WHERE id = :id",
      { sched: sql, id: campaign.id }
    );
    res.json({ ok: true, status: 'scheduled', scheduledAt: sql });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const campaign = await getOwnedCampaign(req.params.id, req.user.id);
    if (campaign.status === 'running') throw new ApiError(409, 'Stop the campaign before deleting');
    await db.execute('DELETE FROM campaigns WHERE id = :id', { id: campaign.id });
    res.json({ ok: true });
  })
);

module.exports = router;
