'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const db = require('../db');
const config = require('../config');
const { ApiError, asyncHandler } = require('../http');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Throttle login attempts per IP to slow credential stuffing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later.' },
});

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'username and password are required');
    const { username, password } = parsed.data;

    const rows = await db.query(
      'SELECT id, username, password_hash, full_name, role, is_active FROM users WHERE username = :username LIMIT 1',
      { username }
    );
    const user = rows[0];

    // Constant-ish failure: same generic message whether user exists or not.
    if (!user || !user.is_active) throw new ApiError(401, 'Invalid credentials');

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw new ApiError(401, 'Invalid credentials');

    const token = jwt.sign(
      { sub: user.id, username: user.username, role: user.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role },
    });
  })
);

// Lets the frontend confirm the stored token is still valid on load.
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.query(
      'SELECT id, username, full_name, role FROM users WHERE id = :id LIMIT 1',
      { id: req.user.id }
    );
    if (!rows[0]) throw new ApiError(401, 'User no longer exists');
    const u = rows[0];
    res.json({ user: { id: u.id, username: u.username, fullName: u.full_name, role: u.role } });
  })
);

module.exports = router;
