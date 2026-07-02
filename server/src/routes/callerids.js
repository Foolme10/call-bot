'use strict';

const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { ApiError, asyncHandler } = require('../http');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await db.query(
      'SELECT id, label, number, created_at FROM caller_ids WHERE user_id = :uid ORDER BY created_at DESC',
      { uid: req.user.id }
    );
    res.json({ callerIds: rows });
  })
);

const createSchema = z.object({
  label: z.string().min(1).max(128),
  number: z.string().min(3).max(32),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'label and number are required');
    const number = parsed.data.number.replace(/[^\d+]/g, '');
    const result = await db.execute(
      'INSERT INTO caller_ids (user_id, label, number) VALUES (:uid, :label, :number)',
      { uid: req.user.id, label: parsed.data.label, number }
    );
    res.status(201).json({ id: result.insertId, label: parsed.data.label, number });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const result = await db.execute(
      'DELETE FROM caller_ids WHERE id = :id AND user_id = :uid',
      { id: req.params.id, uid: req.user.id }
    );
    if (result.affectedRows === 0) throw new ApiError(404, 'Caller ID not found');
    res.json({ ok: true });
  })
);

module.exports = router;
