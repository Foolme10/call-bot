'use strict';

const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { ApiError, asyncHandler } = require('../http');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Saved SMS message templates, scoped to the requesting user (like caller IDs).

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await db.query(
      'SELECT id, name, body, created_at, updated_at FROM sms_templates WHERE user_id = :uid ORDER BY name ASC',
      { uid: req.user.id }
    );
    res.json({ templates: rows });
  })
);

const bodySchema = z.object({
  name: z.string().min(1).max(128),
  body: z.string().min(1).max(1600),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'A template needs a name and message text');
    const { name, body } = parsed.data;
    const result = await db.execute(
      'INSERT INTO sms_templates (user_id, name, body) VALUES (:uid, :name, :body)',
      { uid: req.user.id, name, body }
    );
    res.status(201).json({ id: result.insertId, name, body });
  })
);

const editSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  body: z.string().min(1).max(1600).optional(),
});

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Invalid template data');
    const d = parsed.data;
    const sets = [];
    const params = { id: req.params.id, uid: req.user.id };
    if (d.name !== undefined) {
      sets.push('name = :name');
      params.name = d.name;
    }
    if (d.body !== undefined) {
      sets.push('body = :body');
      params.body = d.body;
    }
    if (sets.length === 0) throw new ApiError(400, 'Nothing to update');
    // Check ownership explicitly rather than via affectedRows: MySQL reports
    // affectedRows as rows *changed*, so a save that sets the same values
    // (e.g. "Save" without editing) would be 0 and wrongly look "not found".
    const owned = await db.query(
      'SELECT id FROM sms_templates WHERE id = :id AND user_id = :uid',
      { id: req.params.id, uid: req.user.id }
    );
    if (!owned[0]) throw new ApiError(404, 'Template not found');
    await db.execute(
      `UPDATE sms_templates SET ${sets.join(', ')} WHERE id = :id AND user_id = :uid`,
      params
    );
    res.json({ ok: true });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const result = await db.execute(
      'DELETE FROM sms_templates WHERE id = :id AND user_id = :uid',
      { id: req.params.id, uid: req.user.id }
    );
    if (result.affectedRows === 0) throw new ApiError(404, 'Template not found');
    res.json({ ok: true });
  })
);

module.exports = router;
