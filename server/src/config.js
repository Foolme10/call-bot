'use strict';

require('dotenv').config();
const path = require('path');

function req(name) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

// Trunk capacity — the ceilings an admin sets once. Auto-pacing never exceeds
// these, so campaigns can't over-dial the trunk (that caused SIP 503 storms).
const MAX_CONCURRENT_CALLS = Math.max(1, Number(process.env.MAX_CONCURRENT_CALLS || 10));
const MAX_CPS = Math.max(0.5, Number(process.env.MAX_CPS || 3));
// Trunk-wide channel budget shared across ALL running campaigns, so their
// combined live calls never oversubscribe the trunk (e.g. 400 channels).
// Defaults to the per-campaign ceiling.
const GLOBAL_MAX_CONCURRENT = Math.max(
  MAX_CONCURRENT_CALLS,
  Number(process.env.GLOBAL_MAX_CONCURRENT || MAX_CONCURRENT_CALLS)
);
// Optional lifetime cap: never dial one number more than this many times across
// all runs. Off by default (0) — the per-campaign redial limit (max 3) is the
// primary guard. Set MAX_TOTAL_DIALS>0 in .env to also cap per number.
const MAX_TOTAL_DIALS = Math.max(0, Number(process.env.MAX_TOTAL_DIALS || 0));

// Voice call billing (admin-only cost display). Carriers bill answered calls in
// fixed time blocks: each started block of VOICE_BLOCK_SECONDS costs
// VOICE_PRICE_PER_BLOCK_SEN sen, rounded UP per call. Default: 0.7 sen / 10 s.
// Only answered calls (talk time) are charged.
const VOICE_BLOCK_SECONDS = Math.max(1, Number(process.env.VOICE_BLOCK_SECONDS || 10));
const VOICE_PRICE_PER_BLOCK_SEN = Math.max(0, Number(process.env.VOICE_PRICE_PER_BLOCK_SEN || 0.7));

// SMS gateway (nxsip) pacing ceilings. SMS sends are quick HTTP GETs, so the
// only limits are how fast we fire requests (cps) and how many stay in flight.
const SMS_MAX_CPS = Math.max(1, Number(process.env.SMS_MAX_CPS || 10));
const SMS_MAX_CONCURRENT = Math.max(1, Number(process.env.SMS_MAX_CONCURRENT || 20));

// Hard cap on how many SMS segments a template/campaign message may use, prefix
// included. Default 1 — a single 160-char GSM message. Templates over the cap
// are blocked (warned in the composer, rejected by the API). Raise it in .env
// to allow longer (multi-segment) messages.
const SMS_MAX_SEGMENTS = Math.max(1, Number(process.env.SMS_MAX_SEGMENTS || 1));

// Safety brake: if the gateway keeps rejecting sends while a campaign runs,
// auto-stop the whole campaign instead of burning through the list. Some
// errors (bad auth key, no credit) stop it immediately; other systemic errors
// (gateway down, timeouts) stop it after this many failures in a row. Set
// SMS_AUTOSTOP_FAILURES=0 to disable the consecutive-failure brake (the
// immediate auth/credit stop still applies).
const SMS_AUTOSTOP_FAILURES = Math.max(0, Number(process.env.SMS_AUTOSTOP_FAILURES || 10));

// Delivery-report (DLR) polling. After a message is accepted ('sent') we ask
// the gateway's get-dlr endpoint whether it actually reached the handset. The
// poller runs every SMS_DLR_POLL_SECONDS, fetching up to SMS_DLR_BATCH msgids
// per request, and stops chasing a message once it's older than
// SMS_DLR_MAX_AGE_HOURS (carriers stop updating stale reports). 0 poll = off.
const SMS_DLR_POLL_SECONDS = Math.max(0, Number(process.env.SMS_DLR_POLL_SECONDS || 120));
const SMS_DLR_BATCH = Math.max(1, Number(process.env.SMS_DLR_BATCH || 100));
const SMS_DLR_MAX_AGE_HOURS = Math.max(1, Number(process.env.SMS_DLR_MAX_AGE_HOURS || 48));

// Price of one SMS credit, in Ringgit (RM). The gateway charges 1 credit per
// message segment; a campaign's cost is (credits used × this). Default RM 0.15.
const SMS_CREDIT_PRICE = Math.max(0, Number(process.env.SMS_CREDIT_PRICE || 0.15));

// Text the app prepends to EVERY outgoing SMS (a compliance identifier, e.g. a
// debt-collection agency tag). Defaults to "DCA:" when unset; set SMS_PREPEND=
// (empty) to disable. A single trailing space is ensured so it doesn't run into
// the message ("DCA:" -> "DCA: "). Quote the value to keep custom spacing.
const SMS_PREPEND = (() => {
  const raw = process.env.SMS_PREPEND;
  const v = raw === undefined ? 'DCA:' : raw;
  if (!v) return '';
  return /\s$/.test(v) ? v : `${v} `;
})();

// Roughly how long an average call ties up a line (ring + message + hangup).
// Used only to estimate how many lines a list needs to finish in TARGET_MINUTES.
const AVG_CALL_SECONDS = Math.max(5, Number(process.env.AVG_CALL_SECONDS || 20));
// Target finish time for a campaign. The app sizes concurrency to hit this,
// capped by the trunk. Bigger list -> more lines -> higher cps, automatically.
const TARGET_MINUTES = Math.max(1, Number(process.env.TARGET_MINUTES || 30));

// Auto-pacing: choose a dial pace from the LIST SIZE so a campaign finishes in
// about TARGET_MINUTES, then clamp to the trunk ceiling.
//   lines needed = (list / targetSeconds) * avgCallSeconds
// Small lists get a gentle pace; huge lists ramp up to the full trunk capacity.
function autoPace(totalContacts) {
  const n = Math.max(1, Number(totalContacts) || 1);
  const targetSeconds = TARGET_MINUTES * 60;
  const needed = Math.ceil((n / targetSeconds) * AVG_CALL_SECONDS);

  // A modest floor keeps small lists snappy (not stretched to the full target
  // window) while huge lists ramp `needed` up toward the trunk cap. Never use
  // more lines than the trunk allows or than there are numbers to dial.
  const floor = Math.min(MAX_CONCURRENT_CALLS, 10, n);
  const maxConcurrent = Math.min(MAX_CONCURRENT_CALLS, n, Math.max(floor, needed));

  // Launch rate: fill those lines within a few seconds, capped at MAX_CPS.
  const cps = Math.max(1, Math.min(Math.ceil(maxConcurrent / 3), MAX_CPS));

  // Realistic finish time = list ÷ the slower of "how fast we launch" (cps) and
  // "how fast lines free up" (maxConcurrent / avg call). Shown in the UI so the
  // chosen pace is understandable rather than a black box.
  const throughput = Math.min(cps, maxConcurrent / AVG_CALL_SECONDS);
  const estMinutes = Math.max(1, Math.ceil(n / throughput / 60));

  return { cps, maxConcurrent, targetMinutes: TARGET_MINUTES, estMinutes };
}

// Auto-pacing for SMS. Unlike voice there's no line-holding to spread out, so
// there's nothing to gain by throttling below the gateway's rate — just send at
// the full configured ceiling (SMS_MAX_CPS). maxConcurrent bounds simultaneous
// in-flight HTTP sends.
function smsPace(totalContacts) {
  const n = Math.max(1, Number(totalContacts) || 1);
  const cps = SMS_MAX_CPS;
  const maxConcurrent = Math.min(SMS_MAX_CONCURRENT, n);
  const estMinutes = Math.max(1, Math.ceil(n / cps / 60));
  return { cps, maxConcurrent, targetMinutes: TARGET_MINUTES, estMinutes };
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  jwt: {
    secret: req('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: req('DB_USER'),
    password: process.env.DB_PASSWORD || '',
    database: req('DB_NAME'),
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 15),
  },

  ari: {
    url: process.env.ARI_URL || 'http://127.0.0.1:8088',
    username: process.env.ARI_USERNAME || 'callbot',
    password: process.env.ARI_PASSWORD || '',
    app: process.env.ARI_APP || 'callbot',
  },

  dial: {
    endpointTemplate: process.env.DIAL_ENDPOINT_TEMPLATE || 'PJSIP/{number}@trunk',
    prefix: process.env.DIAL_PREFIX || '',
    defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '',
    originateTimeout: Number(process.env.ORIGINATE_TIMEOUT || 30),
    // Dialplan context (extensions.conf) that runs AMD() then Stasis() for
    // answering-machine-detection campaigns.
    amdContext: process.env.DIAL_AMD_CONTEXT || 'callbot-amd',
  },

  calls: {
    maxConcurrent: MAX_CONCURRENT_CALLS,
    maxCps: MAX_CPS,
    maxTotalDials: MAX_TOTAL_DIALS,
    globalMaxConcurrent: GLOBAL_MAX_CONCURRENT,
  },

  // Voice call block-billing (admin-only cost display).
  voice: {
    blockSeconds: VOICE_BLOCK_SECONDS,
    pricePerBlockSen: VOICE_PRICE_PER_BLOCK_SEN,
    pricePerBlock: VOICE_PRICE_PER_BLOCK_SEN / 100, // RM per block
  },

  sms: {
    // nxsip HTTP API. Endpoint takes ?action=send-sms&auth-key=..&to=..&content=..
    // and responds with JSON {"status":1,"msgid":"NX…"}.
    apiUrl: process.env.SMS_API_URL || 'https://api.sms.nxsip.com/',
    authKey: process.env.SMS_AUTH_KEY || '', // blank = SMS not configured (sends fail with a clear error)
    maxCps: SMS_MAX_CPS,
    maxConcurrent: SMS_MAX_CONCURRENT,
    // Max SMS segments allowed per message (prefix included). Default 1.
    maxSegments: SMS_MAX_SEGMENTS,
    // Trunk-wide cap on simultaneous in-flight sends across ALL SMS campaigns.
    globalMaxConcurrent: Math.max(
      SMS_MAX_CONCURRENT,
      Number(process.env.SMS_GLOBAL_MAX_CONCURRENT || SMS_MAX_CONCURRENT)
    ),
    // Seconds before a single send HTTP request is aborted as a timeout.
    requestTimeout: Math.max(1, Number(process.env.SMS_REQUEST_TIMEOUT || 30)),
    // The gateway prepends a sender label (e.g. "RM0 BRAND: ") to every message,
    // which eats into the SMS length. Reserve this many characters in the
    // composer's count/segment estimate. SMS_PREFIX_LABEL is shown in the note.
    prefixChars: Math.max(0, Number(process.env.SMS_PREFIX_CHARS || 0)),
    prefixLabel: process.env.SMS_PREFIX_LABEL || '',
    // Extra characters always held back as a safety cushion on top of the
    // prefix/prepend, so a message never lands right on the 160 boundary and
    // spills into a 2nd segment. Default 3. Counted everywhere segments are.
    safetyChars: Math.max(0, Number(process.env.SMS_SAFETY_CHARS || 3)),
    // Prepended to every message the app sends (default "DCA: ").
    prepend: SMS_PREPEND,
    // Consecutive gateway failures that auto-stop a running campaign (0 = off).
    autoStopFailures: SMS_AUTOSTOP_FAILURES,
    // Delivery-report polling.
    dlrPollSeconds: SMS_DLR_POLL_SECONDS,
    dlrBatch: SMS_DLR_BATCH,
    dlrMaxAgeHours: SMS_DLR_MAX_AGE_HOURS,
    // RM per SMS credit (1 credit = 1 segment). For campaign cost display.
    creditPrice: SMS_CREDIT_PRICE,
  },

  storage: {
    // Always resolve to an absolute path so a relative AUDIO_DIR/UPLOAD_TMP_DIR
    // can't make multer (which writes relative to cwd) and the path checks
    // disagree — that mismatch is what surfaced as "Invalid uploadId".
    audioDir: path.resolve(process.env.AUDIO_DIR || '/var/lib/asterisk/sounds/callbot'),
    uploadTmpDir: path.resolve(process.env.UPLOAD_TMP_DIR || path.resolve(__dirname, '../uploads/tmp')),
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  },

  autoPace,
  smsPace,
};

module.exports = config;
