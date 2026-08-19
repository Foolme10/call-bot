'use strict';

const express = require('express');
const { z } = require('zod');
const { ApiError, asyncHandler } = require('../http');
const { requireAuth, requireRole } = require('../middleware/auth');
const credits = require('../services/creditService');

const router = express.Router();
router.use(requireAuth);

// Any logged-in user can see their own wallet balance (for the header badge).
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    res.json({ balance: await credits.getUserBalance(req.user.id), role: req.user.role });
  })
);

// Everything below is admin-only (the vendor manages the pool + wallets).
router.use(requireRole('admin'));

router.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const [pool, users] = await Promise.all([credits.getPool(), credits.listUsers()]);
    res.json({ pool, users });
  })
);

router.get(
  '/transactions',
  asyncHandler(async (req, res) => {
    res.json({ transactions: await credits.listTransactions(req.query.limit) });
  })
);

const amountSchema = z.object({
  amount: z.number().int().positive(),
  note: z.string().max(255).optional(),
});
const userAmountSchema = amountSchema.extend({ userId: z.coerce.number().int().positive() });

router.post(
  '/topup',
  asyncHandler(async (req, res) => {
    const p = amountSchema.safeParse(req.body);
    if (!p.success) throw new ApiError(400, 'Enter a positive whole number of credits');
    res.json(await credits.topUp(p.data.amount, req.user.id, p.data.note));
  })
);

router.post(
  '/allocate',
  asyncHandler(async (req, res) => {
    const p = userAmountSchema.safeParse(req.body);
    if (!p.success) throw new ApiError(400, 'Choose a user and a positive number of credits');
    res.json(await credits.allocate(p.data.userId, p.data.amount, req.user.id, p.data.note));
  })
);

router.post(
  '/deallocate',
  asyncHandler(async (req, res) => {
    const p = userAmountSchema.safeParse(req.body);
    if (!p.success) throw new ApiError(400, 'Choose a user and a positive number of credits');
    res.json(await credits.deallocate(p.data.userId, p.data.amount, req.user.id, p.data.note));
  })
);

module.exports = router;
