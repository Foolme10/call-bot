'use strict';

const { WebSocketServer } = require('ws');
const url = require('url');
const logger = require('../logger');
const { verifyToken } = require('../middleware/auth');

// Real-time fan-out for the monitoring tab.
// Clients connect to ws://host/ws/monitor?token=<JWT>, then send
//   { "type": "subscribe", "campaignId": 123 }
// and receive { type: 'call', campaignId, ... } / { type: 'campaign', ... } events.

let wss = null;
// Map<WebSocket, { userId, role, campaigns: Set<number> }>
const clients = new Map();

function attach(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    if (pathname !== '/ws/monitor') return; // let other upgrade handlers deal with it

    let user;
    try {
      user = verifyToken(query.token || '');
    } catch (_e) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, { userId: user.id, role: user.role, campaigns: new Set() });
      ws.on('message', (data) => onMessage(ws, data));
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
      ws.send(JSON.stringify({ type: 'hello', userId: user.id }));
    });
  });

  logger.info('WebSocket monitor attached at /ws/monitor');
}

function onMessage(ws, data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch (_e) {
    return;
  }
  const state = clients.get(ws);
  if (!state) return;
  if (msg.type === 'subscribe' && msg.campaignId != null) {
    state.campaigns.add(Number(msg.campaignId));
  } else if (msg.type === 'unsubscribe' && msg.campaignId != null) {
    state.campaigns.delete(Number(msg.campaignId));
  }
}

// Push an event to every client subscribed to that campaign.
function publish(campaignId, payload) {
  if (!wss) return;
  const cid = Number(campaignId);
  const message = JSON.stringify({ campaignId: cid, ...payload });
  for (const [ws, state] of clients) {
    if (state.campaigns.has(cid) && ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}

module.exports = { attach, publish };
