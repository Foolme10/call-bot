# call-bot — Maintenance Guide

Everything you need to understand, operate, and modify this codebase.

---

## 1. What it is

call-bot is a **voice broadcaster**: it auto-dials a contact list, plays a
pre-recorded message when answered, and logs the outcome. It has a web UI, a
Node backend that drives **Asterisk** over **ARI**, and a **MySQL/MariaDB**
database.

```
Browser (React)
   │  HTTP /api  +  WebSocket /ws   (nginx reverse-proxies both)
   ▼
Node backend (Express + ws)  ──ARI (REST + WebSocket)──►  Asterisk  ──SIP trunk──►  phones
   │
   ▼
MySQL / MariaDB
```

Three processes run on the server:
- **callbot-api** — the Node backend (managed by PM2). Serves the API, holds the
  ARI connection, and runs the dialer.
- **asterisk** — the telephony engine (chan_sip → your trunk).
- **mariadb** + **nginx** — database and web server/reverse-proxy.

---

## 2. Tech stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite, plain CSS, react-router |
| Backend | Node.js + Express, `ws` (websocket), `mysql2`, `ari-client` |
| Auth | JWT (`jsonwebtoken`) + `bcryptjs` |
| Uploads/parsing | `multer`, `csv-parse`, `xlsx` (SheetJS), `ffmpeg` (external) |
| Telephony | Asterisk 16 (chan_sip) via ARI |
| DB | MariaDB (MySQL-compatible), InnoDB |
| Process mgr | PM2 (runs as the `callbot` user) |

---

## 3. Project layout

```
server/
  src/
    index.js            ← app bootstrap: middleware, routes, starts dialer + ws, graceful shutdown
    config.js           ← reads .env; defines autoPace() and the trunk caps
    db.js               ← mysql2 connection pool + query()/execute() helpers
    logger.js           ← timestamped console logger
    http.js             ← ApiError class + asyncHandler() wrapper
    middleware/
      auth.js           ← requireAuth (verifies JWT), verifyToken (for websocket)
      upload.js         ← multer config (audio + data uploads) + resolveTmpUpload()
    routes/
      auth.js           ← POST /login, GET /me
      callerids.js      ← CRUD for caller IDs
      audio.js          ← upload + convert + list + delete recordings
      contacts.js       ← POST /preview (parse file → columns + sample)
      campaigns.js      ← create/list/detail/control campaigns; /meta/pacing
      reports.js        ← per-campaign report rows + CSV export
    services/
      dialer.js         ← THE ENGINE: pacing loop, ARI originate, outcome mapping, retries, scheduler
      ari.js            ← ARI connection + auto-reconnect
      audioConvert.js   ← ffmpeg → 8kHz mono WAV
      fileParser.js     ← CSV/XLSX → columns/rows; extractContacts()
      phone.js          ← phone normalization
    ws/
      monitor.js        ← websocket server; publish() pushes call events to subscribers
  scripts/
    migrate.js          ← applies db/schema.sql (idempotent; adds new columns/indexes)
    create-user.js      ← creates/updates a login (hashes password)
db/schema.sql           ← the database schema
client/                 ← React app (src/pages/*.jsx are the 4 tabs + login + new-campaign)
asterisk/               ← sample Asterisk configs (sip.conf, ari.conf, http.conf, extensions.conf)
deploy/                 ← systemd unit, nginx config, provision-debian.sh
```

---

## 4. Data model (6 tables)

- **users** — `id, username, password_hash, full_name, role, is_active`. Logins.
- **caller_ids** — `id, user_id, label, number`. Caller IDs shown in the dropdown.
- **audio_files** — `id, user_id, name, original_filename, stored_filename, format,
  duration_sec, status`. `stored_filename` is the basename Asterisk plays as
  `sound:callbot/<stored_filename>`.
- **campaigns** — `id, user_id, name, caller_id_id, audio_file_id, cps,
  max_concurrent, max_attempts, retry_delay_min, retry_on, amd_enabled,
  schedule_type, scheduled_at, status, total_contacts, started_at, completed_at`.
  **`cps` and `max_concurrent` are snapshotted at creation** (the dialing speed).
  `status`: draft → running → (paused) → completed/stopped/failed.
- **contacts** — `id, campaign_id, name, phone`. The dial list (one per campaign).
- **call_logs** — `id, campaign_id, contact_id, name, phone, status, hangup_cause,
  channel, attempts, next_attempt_at, dial_start, answer_time, end_time,
  duration_sec`. **One row per number**; the source of truth for reports + monitor.
  `status`: queued → dialing → answered/busy/no_answer/failed/congestion/machine.

Relationships: a campaign has many contacts and many call_logs; call_logs is what
the dialer reads and writes as it works.

---

## 5. How the main flows work

### Login
`POST /api/auth/login` → bcrypt-compares password → returns a **JWT**. The frontend
stores it in localStorage and sends it as `Authorization: Bearer <token>` on every
request. `requireAuth` middleware verifies it. Create users with
`npm run create-user -- <user> <pass> <name> <role>`.

### Audio upload
`POST /api/audio` (multipart) → multer saves to a temp dir → `audioConvert.js` runs
**ffmpeg** to make an 8 kHz mono WAV in `AUDIO_DIR` → a row is inserted in
`audio_files`. The dialer later plays it as `sound:callbot/<stored_filename>`.
**`AUDIO_DIR` must be `<asterisk data dir>/sounds/callbot`** or playback fails.

### Contact upload (2-step)
1. `POST /api/contacts/preview` (multipart) → `fileParser.js` reads the CSV/XLSX,
   returns the **column names + a few sample rows + an `uploadId`** (the temp
   filename). The UI shows this so the user maps which column is name / number.
2. On campaign create, the chosen columns + `uploadId` are sent;
   `extractContacts()` re-reads the file, normalizes phones (`phone.js`), drops
   invalid ones, and the rows are bulk-inserted into `contacts`.

### Campaign creation + auto-pacing
`POST /api/campaigns` validates input, calls **`config.autoPace(validCount)`** to
pick `{cps, maxConcurrent}` (see §6), inserts the campaign (snapshotting those
values), bulk-inserts contacts, and — if "run now" — calls
`dialer.startCampaign(id)`. Scheduled campaigns get `status='scheduled'` and a
`scheduled_at`; a background scheduler starts them when due.

### The dialer engine (`services/dialer.js`) — the heart
On startup, `dialer.start()` connects to ARI (`ari.js`), registers event handlers,
resets any orphaned `dialing` rows back to `queued`, and resumes campaigns that
were `running`. A **`Runner`** object drives each active campaign:

- **Pacing loop** (`Runner.pump()`, runs every 250 ms): a token bucket refills at
  `cps` per second; while `tokens >= 1` AND `live < maxConcurrent` AND there are
  due `queued` rows, it launches a call.
- **Launching** (`dispatch()`): marks the row `dialing`, then
  `ariClient.channels.originate({ endpoint: SIP/<number>@trunk, app/context, ... })`.
  - **Non-AMD** campaigns originate straight into the Stasis app.
  - **AMD** campaigns originate into the `callbot-amd` dialplan context, which runs
    `AMD()` then `Stasis()`.
- **On answer** (`StasisStart` event): if AMD, read `AMDSTATUS` — `MACHINE` → log
  `machine` + hang up; otherwise mark `answered` and `channel.play()` the audio.
  When playback finishes → hang up.
- **On hangup** (`ChannelDestroyed` event → `finalizeCall()`): map the Q.850
  `hangup_cause` to a status via `mapCause()` (17→busy, 18/19→no_answer,
  34/38→congestion, etc.), write the outcome, free the slot, and nudge `pump()`.
- **Retries**: if the outcome is in the campaign's `retry_on` set and
  `attempts < max_attempts`, the row goes back to `queued` with a
  `next_attempt_at = now + retry_delay_min`. The loop only picks up rows whose
  retry time has arrived; the campaign isn't `completed` until all retries are
  exhausted.
- **Completion**: when no calls are live and no `queued` rows remain (and no future
  retries), the campaign is marked `completed`.

Every status change is also pushed to the **websocket monitor** (`ws/monitor.js`).

### Reports
`GET /api/reports/campaigns/:id` returns summary counts + paginated rows (name,
number, status, attempts, timings). `GET .../export` streams a CSV of all rows.

### Live monitor
The frontend opens `ws://host/ws/monitor?token=<JWT>` and subscribes to a campaign.
`monitor.publish(campaignId, event)` (called from the dialer) pushes `call` and
`campaign` events to subscribers. The Monitor page also polls
`GET /api/campaigns/:id/monitor` every few seconds for the summary counts.

---

## 6. Configuration — `server/.env`

| Var | What it does |
|---|---|
| `PORT` | API port (4000; nginx proxies to it) |
| `JWT_SECRET` | signs login tokens — keep secret |
| `DB_*` | database connection |
| `ARI_URL/USERNAME/PASSWORD/APP` | Asterisk ARI connection (must match `/etc/asterisk/ari.conf`) |
| `DIAL_ENDPOINT_TEMPLATE` | how a number becomes a channel. chan_sip = `SIP/{number}@trunk` |
| `ORIGINATE_TIMEOUT` | seconds to wait for answer before "no answer". Lower = free busy lines faster |
| `DIAL_AMD_CONTEXT` | the dialplan context for AMD campaigns (`callbot-amd`) |
| **`MAX_CONCURRENT_CALLS`** | **the main speed dial** — max simultaneous calls. Set to your trunk's channel limit |
| `MAX_CPS` | max new calls launched per second (mostly affects ramp-up) |
| `AUDIO_DIR` | where converted audio is written — **must equal `<astdatadir>/sounds/callbot`** |

**Auto-pacing** (`config.js → autoPace()`): picks concurrency by list size, then
clamps to `MAX_CONCURRENT_CALLS`. `cps = round(concurrent / 5)`, clamped to
`MAX_CPS`. **Speed = `min(autoPace tier, MAX_CONCURRENT_CALLS)`.** Throughput ≈
`maxConcurrent ÷ average call length`; cps only sets how fast it ramps to full.

**After any `.env` or `config.js` change:** `sudo -u callbot -H pm2 restart
callbot-api`, and create a **new** campaign (existing ones keep their snapshot).

---

## 7. Common changes — how to

- **Change dialing speed** → edit `MAX_CONCURRENT_CALLS` in `.env` → pm2 restart →
  new campaign.
- **Change how speed scales with list size** → edit the tiers in `autoPace()` in
  `server/src/config.js` → pm2 restart.
- **Add a user** → `cd server && sudo -u callbot -H npm run create-user -- <user> <pass> <name> admin`.
- **Add a column to a table** → add it to `db/schema.sql` AND add an `ensureColumn`
  line in `scripts/migrate.js`, then `npm run migrate` (idempotent).
- **Change the UI** → edit `client/src/pages/*.jsx`, then rebuild:
  `cd client && sudo -u callbot -H npm run build && sudo cp -r dist/. /var/www/callbot/`.
- **Change call outcomes / cause mapping** → `mapCause()` in `services/dialer.js`.
- **Change audio format** → the ffmpeg args in `services/audioConvert.js`.

---

## 8. Operations

**Process management (PM2, as the `callbot` user):**
```
sudo -u callbot -H pm2 status
sudo -u callbot -H pm2 logs callbot-api
sudo -u callbot -H pm2 restart callbot-api
sudo -u callbot -H pm2 monit
```

**Deploy a code update** (from your dev machine):
```
rsync -av --exclude node_modules --exclude .env --exclude client/dist <local>/ root@SERVER:/opt/call-bot/
```
then on the server:
```
cd /opt/call-bot/server && sudo -u callbot -H npm install --omit=dev && sudo -u callbot -H npm run migrate
cd /opt/call-bot/client && rm -rf node_modules && sudo -u callbot -H npm install && sudo -u callbot -H npm run build && sudo cp -r dist/. /var/www/callbot/
sudo -u callbot -H pm2 restart callbot-api
```

**Health check:** `curl -s localhost:4000/api/health` → `{"status":"ok","db":"up","ari":"up"}`.

**Asterisk:** `sudo asterisk -rvvv` (live trace), `sudo asterisk -rx "sip show peer trunk"`,
`sudo asterisk -rx "ari show apps"` (should list `callbot`).

**Database backup:**
```
mysqldump callbot > /root/callbot-backup-$(date +%F).sql
```

**Reboot:** PM2 resurrects the app (if `pm2 startup` + `pm2 save` were done);
asterisk/mariadb/nginx auto-start via systemd. Verify with the health check.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `health` shows `ari: down` | ARI password mismatch (`.env` vs `/etc/asterisk/ari.conf`) or Asterisk not running. `sudo asterisk -rx "ari show apps"`. |
| Calls fail instantly, `Allocation failed` | SIP peer `trunk` doesn't exist / not loaded. `sip show peer trunk`. |
| `503 Service Unavailable` storm | Dialing more concurrent calls than the trunk allows. Lower `MAX_CONCURRENT_CALLS`, new campaign. |
| Audio: `does not exist in any format` | `AUDIO_DIR` ≠ `<astdatadir>/sounds/callbot`, or `format_wav.so` not loaded, or file not readable by the asterisk user. |
| One-way / no audio (but it "plays") | RTP/NAT. Add `directmedia=no` + `nat=force_rport,comedia` to the trunk; open UDP 10000–20000. |
| Campaign too slow | `max_concurrent` snapshot is low. Raise `MAX_CONCURRENT_CALLS` + new campaign (or `UPDATE campaigns SET max_concurrent=N WHERE id=...` then Stop→Start). |
| Config change had no effect | Didn't `pm2 restart`, or change applies only to **new** campaigns (speed is snapshotted). |
| App down after edit | Syntax error in a backend file. `pm2 logs callbot-api` shows it. |

Backend logs: `sudo -u callbot -H pm2 logs callbot-api`. Asterisk: `sudo asterisk -rvvv`.
