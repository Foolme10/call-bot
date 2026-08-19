'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { ApiError } = require('../http');

// Verifies the Bearer token and attaches { id, username, role } to req.user.
function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new ApiError(401, 'Missing authorization token'));

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = { id: payload.sub, username: payload.username, role: payload.role };
    return next();
  } catch (_e) {
    return next(new ApiError(401, 'Invalid or expired token'));
  }
}

// Verify a token string directly (used by the websocket handshake).
function verifyToken(token) {
  const payload = jwt.verify(token, config.jwt.secret);
  return { id: payload.sub, username: payload.username, role: payload.role };
}

function requireRole(role) {
  return (req, _res, next) => {
    if (!req.user || req.user.role !== role) {
      return next(new ApiError(403, 'Insufficient permissions'));
    }
    return next();
  };
}

// "Admin-level" = admin OR vendor. Both are staff: they see every user's
// campaigns/reports and manage wallets. Only vendor can additionally top up
// the pool (guard that with requireRole('vendor')).
function isAdminLevel(role) {
  return role === 'admin' || role === 'vendor';
}

function requireAdminLevel(req, _res, next) {
  if (!req.user || !isAdminLevel(req.user.role)) {
    return next(new ApiError(403, 'Insufficient permissions'));
  }
  return next();
}

module.exports = { requireAuth, requireRole, requireAdminLevel, isAdminLevel, verifyToken };
