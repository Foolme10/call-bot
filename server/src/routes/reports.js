'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');
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
};

// Admins (the 'support' super-user) can report on any campaign; others only
// their own.
async function assertOwned(campaignId, user) {
  const isAdmin = user.role === 'admin';
  const rows = await db.query(
    `SELECT id, name, status, rerun_scope FROM campaigns WHERE id = :id ${isAdmin ? '' : 'AND user_id = :uid'}`,
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
      `SELECT id, name, phone, status, hangup_cause, attempts, total_dials,
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

    res.json({
      campaign,
      summary,
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
    res.write('Name,Number,Status,Attempts,Duration (s),Dialed At,Answered At,Ended At\n');

    // Keyset pagination keeps memory flat for very large lists.
    let lastId = 0;
    for (;;) {
      const batch = await db.query(
        `SELECT id, name, phone, status, attempts, duration_sec, dial_start, answer_time, end_time
           FROM call_logs
          WHERE campaign_id = :id AND id > :lastId
          ORDER BY id ASC LIMIT 5000`,
        { id: campaign.id, lastId }
      );
      if (batch.length === 0) break;
      for (const r of batch) {
        res.write(
          [
            esc(r.name),
            esc(r.phone),
            esc(STATUS_LABEL[r.status] || r.status),
            esc(r.attempts),
            esc(r.duration_sec),
            esc(r.dial_start),
            esc(r.answer_time),
            esc(r.end_time),
          ].join(',') + '\n'
        );
      }
      lastId = batch[batch.length - 1].id;
    }
    res.end();
  })
);

module.exports = router;
