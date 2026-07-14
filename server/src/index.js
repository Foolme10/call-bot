'use strict';

const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const { ApiError } = require('./http');

const authRoutes = require('./routes/auth');
const callerIdRoutes = require('./routes/callerids');
const audioRoutes = require('./routes/audio');
const contactRoutes = require('./routes/contacts');
const campaignRoutes = require('./routes/campaigns');
const reportRoutes = require('./routes/reports');

const dialer = require('./services/dialer');
const smsSender = require('./services/smsSender');
const monitor = require('./ws/monitor');

const app = express();
app.set('trust proxy', 1); // behind nginx in production
app.use(helmet());
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Health check (no auth) — used by load balancers / systemd checks.
app.get('/api/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'up', ari: dialer.isConnected() ? 'up' : 'down' });
  } catch (_e) {
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/caller-ids', callerIdRoutes);
app.use('/api/audio', audioRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/reports', reportRoutes);

// 404 for unmatched API routes.
app.use('/api', (_req, _res, next) => next(new ApiError(404, 'Not found')));

// Central error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) logger.error(err);
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(err.details ? { details: err.details } : {}),
  });
});

const server = http.createServer(app);

// Attach the websocket monitor to the same HTTP server (path /ws/monitor).
monitor.attach(server);

async function start() {
  // Fail fast if the DB is unreachable.
  await db.query('SELECT 1');
  logger.info('Database connection OK');

  // Connect to Asterisk ARI and resume any campaigns that were running.
  // A failure here is non-fatal: the web app still runs, dialing is just paused.
  dialer.start().catch((e) => logger.error('Dialer failed to start:', e.message));

  // Start the SMS engine (scheduler + resume). Independent of ARI, so it runs
  // even when telephony is down. Non-fatal on failure.
  smsSender.start().catch((e) => logger.error('SMS sender failed to start:', e.message));

  server.listen(config.port, () => {
    logger.info(`call-bot API listening on :${config.port} (${config.env})`);
  });
}

function shutdown(signal) {
  logger.info(`${signal} received, shutting down…`);
  dialer.stop();
  smsSender.stop();
  server.close(() => {
    db.pool.end().finally(() => process.exit(0));
  });
  // Hard exit if graceful shutdown stalls.
  setTimeout(() => process.exit(1), 10000).unref();
}

// Only boot when run directly (`node src/index.js`), not when imported.
if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  start().catch((err) => {
    logger.error('Fatal startup error:', err.message);
    process.exit(1);
  });
}

module.exports = app;
