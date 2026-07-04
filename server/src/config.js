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

  storage: {
    // Always resolve to an absolute path so a relative AUDIO_DIR/UPLOAD_TMP_DIR
    // can't make multer (which writes relative to cwd) and the path checks
    // disagree — that mismatch is what surfaced as "Invalid uploadId".
    audioDir: path.resolve(process.env.AUDIO_DIR || '/var/lib/asterisk/sounds/callbot'),
    uploadTmpDir: path.resolve(process.env.UPLOAD_TMP_DIR || path.resolve(__dirname, '../uploads/tmp')),
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  },

  autoPace,
};

module.exports = config;
