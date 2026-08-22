'use strict';

const ariClient = require('ari-client');
const config = require('../config');
const logger = require('../logger');

// Wraps the ARI connection with auto-reconnect. Consumers pass an onConnect
// callback that (re)registers event handlers and resumes campaigns.
//
// ari-client (2.x) does NOT emit 'close' or 'WebSocketError' — listening for
// those is dead code. Its events websocket retries internally with a backoff
// (10 tries, ~42s total) and reports through three events instead:
//   WebSocketReconnecting — the socket dropped, an internal retry is scheduled
//   WebSocketConnected    — the socket (re)opened; the Stasis app registration
//                           in Asterisk is brand new (subscriptions are gone)
//   WebSocketMaxRetries   — it gave up for good; only a fresh client helps

let client = null;
let connected = false;
let onConnectCb = null;
let reconnectTimer = null;
let pingTimer = null;
let generation = 0; // ignore events from clients we've already replaced

async function connect(onConnect) {
  onConnectCb = onConnect;
  if (!pingTimer) startPinger();
  await tryConnect();
}

async function tryConnect() {
  const gen = ++generation;
  connected = false;
  // Drop any previous client so its websocket + handlers can't outlive it.
  if (client) {
    try {
      client.stop();
    } catch (_e) {
      /* never started / already closed */
    }
    client = null;
  }
  try {
    const c = await ariClient.connect(config.ari.url, config.ari.username, config.ari.password);
    client = c;

    let firstOpen = true;
    c.on('WebSocketReconnecting', () => {
      if (gen !== generation) return;
      connected = false; // events are NOT flowing — the dialer must not dial
      logger.warn('ARI events websocket lost, retrying…');
    });
    c.on('WebSocketConnected', () => {
      if (gen !== generation) return;
      if (firstOpen) {
        firstOpen = false; // the awaited start() below handles the first open
        return;
      }
      // Re-opened after an internal retry: events were missed while it was
      // down and Asterisk re-registered the app from scratch — run the same
      // recovery as a fresh connect (reset orphans, clear stale slots, resume).
      connected = true;
      logger.warn('ARI events websocket re-established, recovering…');
      Promise.resolve()
        .then(() => onConnectCb && onConnectCb(c))
        .catch((e) => {
          logger.error('ARI post-reconnect recovery failed:', e.message);
          connected = false;
          scheduleReconnect();
        });
    });
    c.on('WebSocketMaxRetries', (err) => {
      if (gen !== generation) return;
      connected = false;
      logger.error('ARI websocket gave up retrying:', (err && err.message) || 'unknown');
      scheduleReconnect(); // start over with a fresh client
    });

    // start() resolves once the events websocket is actually open (and rejects
    // if it never opens) — await it so `connected` is never true without a
    // live event stream behind it.
    await c.start(config.ari.app);
    connected = true;

    if (onConnectCb) await onConnectCb(c);
    logger.info(`Connected to Asterisk ARI, Stasis app "${config.ari.app}" started`);
  } catch (err) {
    connected = false;
    logger.error('ARI connect failed:', err.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    tryConnect();
  }, 5000);
}

// A half-open TCP connection delivers no events, no error, and no close — ping
// it regularly so a dead socket eventually errors out and takes the
// WebSocketReconnecting path instead of the app dialing blind forever.
function startPinger() {
  pingTimer = setInterval(() => {
    if (client && connected) {
      try {
        client.ping();
      } catch (_e) {
        /* socket already dead — the reconnect path will handle it */
      }
    }
  }, 20000);
}

function getClient() {
  return client;
}

function isConnected() {
  return connected;
}

function stop() {
  generation += 1; // silence any in-flight events from the old client
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  if (client) {
    try {
      client.stop();
    } catch (_e) {
      /* ignore */
    }
  }
  connected = false;
}

module.exports = { connect, getClient, isConnected, stop };
