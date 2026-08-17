'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');
const dlrPoller = require('../services/dlrPoller');
const { ApiError, asyncHandler } = require('../http');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const STATUS_LABEL = {
  // Reports only exist for finished campaigns, where a 'queued' row means the
  // campaign was stopped before this number's turn came up.
  queued: 'Not Dialed',
  dialing: 'Dialing',
  answered: 'Answered',
  busy: 'Busy',
  no_answer: 'No Answer',
  failed: 'Failed',
  congestion: 'Congestion',
  machine: 'Answering Machine',
  sent: 'Sent', // SMS: gateway accepted the message
};

// Admins (the 'support' super-user) can report on any campaign; others only
// their own.
async function assertOwned(campaignId, user) {
  const isAdmin = user.role === 'admin';
  const rows = await db.query(
    `SELECT id, name, status, rerun_scope, max_attempts, channel, stop_reason FROM campaigns WHERE id = :id ${isAdmin ? '' : 'AND user_id = :uid'}`,
    { id: campaignId, uid: user.id }
  );
  if (!rows[0]) throw new ApiError(404, 'Campaign not found');
  return rows[0];
}

// Reports are a final document: only meaningful once no more dialing will
// happen. Mid-run visibility belongs to the Live Monitor instead.
function assertFinished(campaign) {
  if (!['completed', 'stopped'].includes(campaign.status)) {
    throw new ApiError(
      409,
      'Reports are available once the campaign has finished. Use Live Monitor to follow it in real time.'
    );
  }
}

// Paginated report rows + summary counts.
router.get(
  '/campaigns/:id',
  asyncHandler(async (req, res) => {
    const campaign = await assertOwned(req.params.id, req.user);
    assertFinished(campaign);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const offset = (page - 1) * pageSize;
    const statusFilter = STATUS_LABEL[req.query.status] ? req.query.status : null;
    const search = (req.query.q || '').toString().trim();

    const where = ['campaign_id = :id'];
    const params = { id: campaign.id, limit: pageSize, offset };
    if (statusFilter) {
      where.push('status = :status');
      params.status = statusFilter;
    }
    if (search) {
      where.push('(name LIKE :q OR phone LIKE :q)');
      params.q = `%${search}%`;
    }
    const whereSql = where.join(' AND ');

    const rows = await db.query(
      `SELECT id, name, phone, status, hangup_cause, error_detail, provider_msgid, attempts, total_dials,
              dial_start, answer_time, end_time, duration_sec
         FROM call_logs WHERE ${whereSql}
        ORDER BY id ASC LIMIT :limit OFFSET :offset`,
      params
    );
    const [{ n: filteredTotal }] = await db.query(
      `SELECT COUNT(*) AS n FROM call_logs WHERE ${whereSql}`,
      params
    );
    const summaryRows = await db.query(
      'SELECT status, COUNT(*) AS n FROM call_logs WHERE campaign_id = :id GROUP BY status',
      { id: campaign.id }
    );
    const summary = {};
    summaryRows.forEach((r) => (summary[r.status] = Number(r.n)));

    // SMS usage: credits consumed (from delivery reports), shown as a count.
    let sms = null;
    if (campaign.channel === 'sms') {
      const [{ credits }] = await db.query(
        "SELECT COALESCE(SUM(dlr_credits), 0) AS credits FROM call_logs WHERE campaign_id = :id AND status = 'sent'",
        { id: campaign.id }
      );
      sms = { credits: Number(credits) };
    }

    res.json({
      campaign,
      summary,
      sms,
      labels: STATUS_LABEL,
      maxTotalDials: config.calls.maxTotalDials,
      page,
      pageSize,
      total: Number(filteredTotal),
      rows: rows.map((r) => ({ ...r, statusLabel: STATUS_LABEL[r.status] || r.status })),
    });
  })
);

// CSV export of the full call list (name, number, status, timings).
router.get(
  '/campaigns/:id/export',
  asyncHandler(async (req, res) => {
    const campaign = await assertOwned(req.params.id, req.user);
    assertFinished(campaign);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="campaign-${campaign.id}-report.csv"`
    );

    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const isSms = campaign.channel === 'sms';
    // SMS reports carry the delivery-report columns; voice reports don't.
    res.write(
      isSms
        ? 'Name,Number,Status,Detail,Message ID,Delivery,Delivery Detail,Credits,Delivered/Updated At\n'
        : 'Name,Number,Status,Detail,Message ID,Attempts,Duration (s),Dialed At,Answered At,Ended At\n'
    );

    // Keyset pagination keeps memory flat for very large lists.
    let lastId = 0;
    for (;;) {
      const batch = await db.query(
        `SELECT id, name, phone, status, error_detail, provider_msgid, attempts, duration_sec,
                dial_start, answer_time, end_time,
                dlr_status, dlr_detail, dlr_credits, dlr_updated_at
           FROM call_logs
          WHERE campaign_id = :id AND id > :lastId
          ORDER BY id ASC LIMIT 5000`,
        { id: campaign.id, lastId }
      );
      if (batch.length === 0) break;
      for (const r of batch) {
        const cols = isSms
          ? [
              esc(r.name),
              esc(r.phone),
              esc(STATUS_LABEL[r.status] || r.status),
              esc(r.error_detail),
              esc(r.provider_msgid),
              esc(r.status === 'sent' ? r.dlr_status || 'pending' : ''),
              esc(r.dlr_detail),
              esc(r.dlr_credits),
              esc(r.dlr_updated_at),
            ]
          : [
              esc(r.name),
              esc(r.phone),
              esc(STATUS_LABEL[r.status] || r.status),
              esc(r.error_detail),
              esc(r.provider_msgid),
              esc(r.attempts),
              esc(r.duration_sec),
              esc(r.dial_start),
              esc(r.answer_time),
              esc(r.end_time),
            ];
        res.write(cols.join(',') + '\n');
      }
      lastId = batch[batch.length - 1].id;
    }
    res.end();
  })
);

// ───────────────────────────────────────────────────────────────────────────
// SMS delivery reports (DLR): whether each accepted message reached the handset.
// ───────────────────────────────────────────────────────────────────────────

// A message not yet polled (dlr_status NULL) reads as 'pending'.
const DLR_BUCKETS = ['delivered', 'pending', 'failed'];

async function dlrSummary(campaignId) {
  const [row] = await db.query(
    `SELECT
        COUNT(*) AS sent,
        COALESCE(SUM(dlr_status = 'delivered'), 0) AS delivered,
        COALESCE(SUM(dlr_status = 'failed'), 0)    AS failed,
        COALESCE(SUM(dlr_status = 'pending' OR dlr_status IS NULL), 0) AS pending,
        COALESCE(SUM(dlr_credits), 0) AS credits
       FROM call_logs
      WHERE campaign_id = :id AND status = 'sent'`,
    { id: campaignId }
  );
  return {
    sent: Number(row.sent),
    delivered: Number(row.delivered),
    failed: Number(row.failed),
    pending: Number(row.pending),
    credits: Number(row.credits),
  };
}

// Delivery report for one SMS campaign: summary + paginated per-recipient rows.
router.get(
  '/campaigns/:id/dlr',
  asyncHandler(async (req, res) => {
    const campaign = await assertOwned(req.params.id, req.user);
    if (campaign.channel !== 'sms') {
      throw new ApiError(400, 'Delivery reports are only available for SMS campaigns.');
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const offset = (page - 1) * pageSize;
    const bucket = DLR_BUCKETS.includes(req.query.state) ? req.query.state : null;
    const search = (req.query.q || '').toString().trim();

    const where = ["campaign_id = :id", "status = 'sent'"];
    const params = { id: campaign.id, limit: pageSize, offset };
    if (bucket === 'pending') {
      where.push("(dlr_status = 'pending' OR dlr_status IS NULL)");
    } else if (bucket) {
      where.push('dlr_status = :bucket');
      params.bucket = bucket;
    }
    if (search) {
      where.push('(name LIKE :q OR phone LIKE :q)');
      params.q = `%${search}%`;
    }
    const whereSql = where.join(' AND ');

    const rows = await db.query(
      `SELECT id, name, phone, provider_msgid, dlr_status, dlr_state, dlr_detail,
              dlr_credits, dlr_updated_at, end_time
         FROM call_logs WHERE ${whereSql}
        ORDER BY id ASC LIMIT :limit OFFSET :offset`,
      params
    );
    const [{ n: filteredTotal }] = await db.query(
      `SELECT COUNT(*) AS n FROM call_logs WHERE ${whereSql}`,
      params
    );

    res.json({
      campaign: { id: campaign.id, name: campaign.name, channel: campaign.channel, status: campaign.status },
      summary: await dlrSummary(campaign.id),
      pollSeconds: config.sms.dlrPollSeconds,
      page,
      pageSize,
      total: Number(filteredTotal),
      rows: rows.map((r) => ({ ...r, dlr_status: r.dlr_status || 'pending' })),
    });
  })
);

// Force an immediate DLR refresh for one campaign (the "Refresh now" button).
router.post(
  '/campaigns/:id/dlr/refresh',
  asyncHandler(async (req, res) => {
    const campaign = await assertOwned(req.params.id, req.user);
    if (campaign.channel !== 'sms') {
      throw new ApiError(400, 'Delivery reports are only available for SMS campaigns.');
    }
    const result = await dlrPoller.refreshCampaign(campaign.id);
    res.json({ ...result, summary: await dlrSummary(campaign.id) });
  })
);

module.exports = router;
