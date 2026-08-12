'use strict';

const config = require('../config');
const logger = require('../logger');

// ───────────────────────────────────────────────────────────────────────────
// SMS gateway client (nxsip).
//
//   GET {SMS_API_URL}?action=send-sms&auth-key=KEY&to=NUMBER&content=TEXT
//
// nxsip responds with JSON: {"status":1,"msgid":"NX26…"}. (The older nuavox
// gateway returned a bare status code, which this client still parses as a
// fallback.) `status` uses the same codes:
//   1      Queued For Sending (success)
//   0      Authentication failure
//   -1     Missing/invalid parameters
//   -2     Insufficient credit (prepaid)
//   -3     Message too long
//   -4     Unsupported destination country
//   -9999  Other/gateway error
// `msgid` is stored so a later delivery report (DLR) can be matched back to the
// message. The synchronous status only means "accepted", not "delivered".
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

// Account-level errors that doom EVERY send in the campaign, not just this one
// recipient: a bad/rejected auth key (0) or an exhausted prepaid balance (-2).
// When one of these comes back mid-run there's no point continuing — the whole
// campaign is auto-stopped immediately so the operator can fix the account.
function isFatal(code) {
  return code === 0 || code === -2;
}

// Send one SMS. Never throws — always resolves to a normalized result:
//   { ok, code, msgid, detail }  where ok === (code === 1). `msgid` is the
//   gateway's message id (nxsip), kept for matching later delivery reports.
async function sendSms({ to, content }) {
  if (!config.sms.authKey) {
    return { ok: false, code: null, msgid: null, detail: 'SMS gateway not configured (SMS_AUTH_KEY missing)' };
  }

  let url;
  try {
    url = new URL(config.sms.apiUrl);
  } catch (_e) {
    return { ok: false, code: null, msgid: null, detail: `Invalid SMS_API_URL: ${config.sms.apiUrl}` };
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
      return { ok: false, code: null, msgid: null, detail: `HTTP ${res.status} from gateway` };
    }

    // nxsip responds with JSON: {"status":1,"msgid":"NX…"}. nuavox returned a
    // bare status code. Parse JSON first, then fall back to the first integer.
    let code = NaN;
    let msgid = null;
    let providerMsg = null;
    try {
      const j = JSON.parse(body);
      if (j && j.status !== undefined) {
        code = parseInt(j.status, 10);
        msgid = j.msgid || j.msgId || j.message_id || null;
        providerMsg = j.error || j.message || j.detail || null;
      }
    } catch (_e) {
      /* not JSON — fall through to bare-code parsing */
    }
    if (Number.isNaN(code)) {
      const m = body.match(/-?\d+/);
      code = m ? parseInt(m[0], 10) : NaN;
    }
    if (Number.isNaN(code)) {
      return {
        ok: false,
        code: null,
        msgid: null,
        detail: redact(`Unexpected gateway response: ${body.slice(0, 120) || '(empty)'}`),
      };
    }
    const detail = providerMsg ? redact(providerMsg) : CODE_MEANING[String(code)] || `Gateway status ${code}`;
    return { ok: code === 1, code, msgid: msgid || null, detail };
  } catch (err) {
    const detail = err.name === 'AbortError' ? 'Gateway request timed out' : `Network error: ${err.message}`;
    logger.warn(`SMS send failed: ${detail}`);
    return { ok: false, code: null, msgid: null, detail: redact(detail) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendSms, isTransient, isFatal, CODE_MEANING };
