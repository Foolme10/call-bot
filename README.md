# call-bot

A self-hosted **voice broadcasting** platform. Upload a contact list, pick a
pre-recorded message and a caller ID, choose how fast to dial, and call-bot
auto-dials everyone, plays the message, and logs the outcome — with live
monitoring and reporting.

- **Engine:** Asterisk (via ARI) + your SIP trunk
- **Backend:** Node.js (Express) + MySQL
- **Frontend:** React (Vite)
- **Target server:** Linux (Ubuntu/Debian). You can develop the web app on
  Windows, but Asterisk only runs on Linux.

---

## Features

1. **Login** — username/password (bcrypt + JWT). Create accounts with a script.
2. **Campaigns** — run-now or scheduled, per-campaign caller ID, audio dropdown,
   automatic dialing speed (paced to list size + trunk capacity), configurable
   redial (multi-attempt), optional answering-machine detection, CSV/Excel
   contact upload with column mapping.
3. **Audio & Caller IDs** — upload recordings (auto-converted for Asterisk) and
   manage caller IDs; both feed the campaign dropdowns.
4. **Reports** — per-campaign call list (name, number, status) + summary + CSV
   export. Statuses: Answered / Busy / No Answer / Failed / Congestion.
5. **Live Monitor** — real-time view (WebSocket) of which number is dialing and
   its status.

---

## Architecture

```
Browser (React)
   │  /api  +  /ws  (via nginx)
   ▼
Node backend ───────────► MySQL          (users, campaigns, contacts, call_logs…)
   │  ARI (REST + events)
   ▼
Asterisk ───────────────► SIP trunk ────► phones
```

The **dialer** keeps each campaign dialing at its configured **CPS** while never
exceeding its **max concurrent** calls. When a callee answers, the channel enters
the Stasis app, the backend plays the campaign audio, then hangs up. Busy /
no-answer outcomes are derived from the SIP hangup cause.

### Dialing speed (automatic)

There's no per-campaign speed setting. Each campaign **paces itself from the
contact-list size** — a bigger list dials more calls at once — but never goes
above your **trunk capacity**, which you set once in `server/.env`:

```
MAX_CONCURRENT_CALLS=10    # max simultaneous live calls your trunk allows
MAX_CPS=3                  # max new calls launched per second
```

This is the single dialing knob to tune. Set it to what your SIP carrier
permits — a small/demo trunk might be `MAX_CONCURRENT_CALLS=2`, `MAX_CPS=1`.
Exceeding the trunk's real limit gets calls rejected (SIP 503). The resolved
speed is **snapshotted onto the campaign** at creation, so editing the caps later
never disturbs a running campaign.

### Retries (redial)

Each campaign can re-dial numbers that didn't connect:

- **Attempts per number** (1–5; 1 = no retry).
- **Wait between attempts** (minutes) — a number isn't re-dialed until this delay
  has passed, so a busy line gets time to clear.
- **Retry on** — which outcomes trigger a retry (Busy / No Answer / Failed /
  Congestion). **Answered calls are never retried.**

Mechanically, a retryable call is put back on the queue (its `call_logs` row
returns to `queued` with a `next_attempt_at` timestamp) rather than being marked
final. The dialer only picks up rows whose retry time has arrived, and the
campaign isn't marked **completed** until every number's attempts are exhausted.
The Reports tab shows an **Attempts** column so you can see how many tries each
number took.

### Answering machine detection (AMD)

A per-campaign toggle:

- **Off** (default) — the message plays to whoever/whatever answers. Best when
  you *want* to leave voicemails.
- **On** — Asterisk's `AMD()` classifies the answer; **live people hear the
  message, machines are logged as "Answering Machine" and hung up** without
  playing. The "only reach humans" mode.

AMD-enabled calls are routed through the `callbot-amd` dialplan context (see
`asterisk/extensions.conf.sample`) which runs `AMD()` before handing the call to
the app; the backend reads `AMDSTATUS` to decide. Detection adds a few seconds of
analysis before the message starts. Tune sensitivity in `/etc/asterisk/amd.conf`
(Asterisk ships working defaults). Note AMD is heuristic — no detector is 100%
accurate.

---

## Deploying

For a fresh Debian 12 (or 11) VPS, the fastest path is the automated provisioner —
it installs everything, creates the DB, writes config, builds the UI, and wires
systemd + nginx + firewall + HTTPS in one run. See **[DEPLOY.md](DEPLOY.md)** and
[deploy/provision-debian.sh](deploy/provision-debian.sh).

The manual steps below explain what that script does, if you'd rather do it by hand.

## Prerequisites (manual install)

```bash
sudo apt update
sudo apt install -y asterisk mysql-server ffmpeg nginx
# Node 18+ (NodeSource):
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## Setup

### 1. Database

```bash
sudo mysql
```
```sql
CREATE DATABASE callbot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'callbot'@'localhost' IDENTIFIED BY 'a-strong-password';
GRANT ALL PRIVILEGES ON callbot.* TO 'callbot'@'localhost';
FLUSH PRIVILEGES;
```

### 2. Backend

```bash
cd server
cp .env.example .env        # then edit: DB creds, JWT_SECRET, ARI creds, trunk, AUDIO_DIR
npm install
npm run migrate             # creates tables
npm run create-user -- admin 'YourPassword123' 'Administrator' admin
```

`AUDIO_DIR` must be a folder **under Asterisk's sounds directory** so that
`sound:callbot/<file>` resolves — otherwise playback fails with *"does not exist
in any format"*. The sounds dir is `<astdatadir>/sounds`, and `astdatadir` is
**distro-specific**:

```bash
grep astdatadir /etc/asterisk/asterisk.conf   # Debian => /usr/share/asterisk
```

| Distro | AUDIO_DIR |
|---|---|
| **Debian** | `/usr/share/asterisk/sounds/callbot` |
| CentOS / source build | `/var/lib/asterisk/sounds/callbot` |

Create it and let both Asterisk and the backend user access it (Debian shown):

```bash
sudo mkdir -p /usr/share/asterisk/sounds/callbot
sudo chown callbot:asterisk /usr/share/asterisk/sounds/callbot
sudo chmod 775 /usr/share/asterisk/sounds/callbot
```

### 3. Asterisk

Copy the samples from `asterisk/` into `/etc/asterisk/`, fill in your trunk and
ARI credentials (the ARI password must match `.env`), then reload:

```bash
sudo cp asterisk/http.conf.sample        /etc/asterisk/http.conf
sudo cp asterisk/ari.conf.sample         /etc/asterisk/ari.conf
sudo cp asterisk/pjsip.conf.sample       /etc/asterisk/pjsip.conf
sudo cp asterisk/extensions.conf.sample  /etc/asterisk/extensions.conf
sudo systemctl restart asterisk
# verify:  sudo asterisk -rx "pjsip show registrations"
#          sudo asterisk -rx "ari show apps"   (after the backend connects)
```

### 4. Run (development)

```bash
# terminal 1
cd server && npm run dev
# terminal 2
cd client && npm install && npm run dev   # http://localhost:5173
```

The Vite dev server proxies `/api` and `/ws` to the backend on :4000.

### 5. Deploy (production)

```bash
cd client && npm run build
sudo cp -r dist /var/www/callbot
sudo cp ../deploy/nginx-callbot.conf /etc/nginx/sites-available/callbot
sudo ln -s /etc/nginx/sites-available/callbot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# backend as a service
sudo cp deploy/callbot-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now callbot-api
```

Then run **certbot** to add HTTPS — the JWT travels in the Authorization header
and should never go over plain HTTP in production.

---

## How a campaign flows

1. **Audio & Caller IDs** tab → upload a recording, add a caller ID.
2. **Campaigns → New** → name it, upload the contact list, map the *name* and
   *number* columns, pick the audio + caller ID, choose intensity, then **Run
   now** or **Schedule**.
3. **Live Monitor** → watch calls go out in real time.
4. **Reports** → review/export results once it finishes.

Contact files can be `.csv` or `.xlsx` with any number of columns — you choose
which column is the name and which is the number during upload.

---

## ⚠️ Compliance

Automated outbound calling is heavily regulated (e.g. TCPA in the US, plus local
robocall, consent, calling-hours, and Do-Not-Call rules). Before broadcasting:

- only call contacts who have **consented**,
- present a **caller ID you are authorized** to use,
- honor **opt-out / DNC** lists and lawful calling hours.

You are responsible for lawful use. This software ships no legal guarantees.

---

## Dependency security

`npm audit` on the backend is clean of high/critical issues. Notes:

- **xlsx (SheetJS)** is pinned to the vendor's patched CDN build
  (`xlsx-0.20.3.tgz`) — the npm copy is unmaintained and vulnerable, and this
  package parses untrusted uploaded files. `npm install` needs internet access
  to fetch it.
- A handful of **moderate** advisories remain in `ari-client`'s old transitive
  deps (`request`, `swagger-client`, etc.). `ari-client` only makes HTTP calls
  to your **local** Asterisk ARI (127.0.0.1) with your own data, so exposure is
  low. The criticals in that chain are already patched via `overrides` in
  `package.json`.

## Project layout

```
db/schema.sql            MySQL schema
server/                  Node API + dialer  (see server/.env.example)
  src/routes/            auth, campaigns, contacts, audio, callerids, reports
  src/services/          dialer (ARI pacing), ari, fileParser, audioConvert, phone
  src/ws/monitor.js      live WebSocket
  scripts/               migrate.js, create-user.js
client/                  React app (login + 4 tabs)
asterisk/                http/ari/pjsip/extensions config samples
deploy/                  systemd unit + nginx config
```
