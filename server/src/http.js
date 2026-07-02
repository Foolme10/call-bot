'use strict';

// Small helpers shared by routes: a typed error + async wrapper so handlers
// can `throw new ApiError(400, 'msg')` and let one error middleware respond.

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Wrap an async route handler so rejected promises reach Express' error chain.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { ApiError, asyncHandler };
