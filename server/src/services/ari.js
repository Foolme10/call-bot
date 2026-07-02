'use strict';

const ariClient = require('ari-client');
const config = require('../config');
const logger = require('../logger');

// Wraps the ARI connection with auto-reconnect. Consumers pass an onConnect
// callback that (re)registers event handlers and starts the Stasis app.

let client = null;
let connected = false;
let onConnectCb = null;
let reconnectTimer = null;

async function connect(onConnect) {
  onConnectCb = onConnect;
  await tryConnect();
}

async function tryConnect() {
  try {
    client = await ariClient.connect(config.ari.url, config.ari.username, config.ari.password);

    client.on('WebSocketError', (err) => logger.error('ARI websocket error:', err && err.message));
    // ari-client emits 'close' when the control websocket drops.
    client.on('close', () => {
      connected = false;
      logger.warn('ARI connection closed, will retry…');
      scheduleReconnect();
    });

    if (onConnectCb) await onConnectCb(client);

    // Start receiving Stasis events for our app.
    client.start(config.ari.app);
    connected = true;
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

function getClient() {
  return client;
}

function isConnected() {
  return connected;
}

function stop() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
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
