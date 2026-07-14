'use strict';

const config = require('../config');
const logger = require('../logger');

// ───────────────────────────────────────────────────────────────────────────
// nuavox SMS gateway client.
//
//   GET http://sms.nuavox.com/api?action=send-sms&auth-key=KEY&to=NUMBER&content=TEXT
//
// The response body is a single status code:
//   1      Queued For Sending (success)
//   0      Authentication failure
//   -1     Missing/invalid parameters
//   -2     Insufficient credit (prepaid)
//   -3     Message too long
//   -4     Unsupported destination country
//   -9999  Other/gateway error
// There is no delivery receipt, so "queued for sending" (1) is the best signal
// we get — it maps to our 'sent' status.
// ───────────────────────────────────────────────────────────────────────────

const CODE_MEANING = {
  1: 'Queued for sending',
  0: 'Authentication failure',
  '-1': 'Missing or invalid parameters',
  '-2': 'Insufficient credit',
  '-3': 'Message too long',
  '-4': 'Unsupported destination country',
  '-9999': 'Gateway error',
};

// Strip the auth key (and any auth-key=... param) from a string before it's
// persisted or logged, in case an upstream echoes the request back to us.
function redact(s) {
  let out = String(s);
  if (config.sms.authKey) out = out.split(config.sms.authKey).join('***');
  return out.replace(/(auth-key=)[^&\s]+/gi, '$1***');
}

// Codes worth retrying: transient gateway/network problems. Permanent rejects
// (bad auth, no credit, too long, unsupported country, invalid params) won't
// improve on a retry, so we don't waste sends on them.
function isTransient(code) {
  return code === -9999 || code === null;
}

// Send one SMS. Never throws — always resolves to a normalized result:
//   { ok, code, detail }  where ok === (code === 1).
async function sendSms({ to, content }) {
  if (!config.sms.authKey) {
    return { ok: false, code: null, detail: 'SMS gateway not configured (SMS_AUTH_KEY missing)' };
  }

  let url;
  try {
    url = new URL(config.sms.apiUrl);
  } catch (_e) {
    return { ok: false, code: null, detail: `Invalid SMS_API_URL: ${config.sms.apiUrl}` };
  }
  url.searchParams.set('action', 'send-sms');
  url.searchParams.set('auth-key', config.sms.authKey);
  url.searchParams.set('to', to);
  url.searchParams.set('content', content);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.sms.requestTimeout * 1000);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    const body = (await res.text()).trim();
    if (!res.ok) {
      // Transport-level HTTP error (5xx/4xx) before the gateway status code.
      // Deliberately drop the response body — an upstream that echoes the
      // request could include the auth-key (it travels in the query string),
      // and this detail is persisted + shown in reports.
      return { ok: false, code: null, detail: `HTTP ${res.status} from gateway` };
    }
    // The body is the status code; take the first integer token to be safe.
    const m = body.match(/-?\d+/);
    const code = m ? parseInt(m[0], 10) : NaN;
    if (Number.isNaN(code)) {
      return { ok: false, code: null, detail: redact(`Unexpected gateway response: ${body.slice(0, 120) || '(empty)'}`) };
    }
    const detail = CODE_MEANING[String(code)] || `Gateway status ${code}`;
    return { ok: code === 1, code, detail };
  } catch (err) {
    const detail = err.name === 'AbortError' ? 'Gateway request timed out' : `Network error: ${err.message}`;
    logger.warn(`SMS send failed: ${detail}`);
    return { ok: false, code: null, detail: redact(detail) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendSms, isTransient, CODE_MEANING };
