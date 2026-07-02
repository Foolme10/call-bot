# Deploying call-bot (Debian 12)

This is the start-to-finish path for a fresh VPS. The provisioner targets
**Debian 12 (bookworm)** — Asterisk 20 from the repo — and also runs on Debian 11.

> **Which SIP driver?** Asterisk 20 (Debian 12) ships **PJSIP only**. If you need
> **chan_sip** (`sip.conf`), use **Debian 11** (Asterisk 16) and set
> `SIP_DRIVER=chan_sip` in the script — it switches the dial string to
> `SIP/{number}@trunk` and points you at `sip.conf.sample`. Note chan_sip is
> deprecated upstream (removed in Asterisk 21), so PJSIP is the longer-term path.

## 1. Provision a VPS

- **OS:** Debian 12 (bookworm), 64-bit
- **Virtualization:** KVM (not OpenVZ — it throttles CPU and blocks timing modules)
- **Specs:** see the table below
- **Network:** a static, public IPv4 with **no provider NAT**; a VoIP-friendly host

| Peak concurrent calls | vCPU | RAM | Disk | Transfer |
|---|---|---|---|---|
| ~20 (Level 1) | 2 | 2–4 GB | 40 GB | 1 TB |
| ~60 (Level 2) | 2–4 | 4 GB | 50 GB | 2–4 TB |
| ~150 (Level 3) | 4 | 8 GB | 80 GB SSD | 4–8 TB |

If you'll use AMD on most campaigns, take the higher CPU in your row.

## 2. DNS (optional but recommended)

Point an A record (e.g. `callbot.example.com`) at the server's IP. You need this
for HTTPS. Without a domain the app still works over `http://<server-ip>`.

## 3. Copy the code to the server

Put the project at **`/opt/call-bot`** (the systemd/nginx paths assume it).

From your Windows machine (PowerShell), using `scp`:

```powershell
# zip-free copy of the whole project (excludes node_modules)
scp -r C:\prod-broadcast root@SERVER_IP:/opt/call-bot
```

Or with `rsync` (Git Bash / WSL), which is better for re-deploys:

```bash
rsync -av --exclude node_modules --exclude .env --exclude client/dist \
  /c/prod-broadcast/ root@SERVER_IP:/opt/call-bot/
```

## 4. Configure the provisioner

Edit the **EDIT THESE** block at the top of `deploy/provision-debian.sh`:

```bash
nano /opt/call-bot/deploy/provision-debian.sh
```

| Variable | Set to |
|---|---|
| `DOMAIN` | your hostname (e.g. `callbot.example.com`), or leave blank to use the IP |
| `LE_EMAIL` | your email (needed only if `DOMAIN` is set, for the TLS cert) |
| `ADMIN_USER` / `ADMIN_PASS` | your first login (leave `ADMIN_PASS` blank to create it later) |
| `SIP_TRUNK_IPS` | your provider's SIP IPs, space-separated (locks down UDP 5060) |
| `SIP_DRIVER` | `pjsip` (default) or `chan_sip` (Debian 11 / Asterisk 16) |

DB / ARI / JWT secrets are generated automatically and written to `server/.env`.

## 5. Run it

```bash
cd /opt/call-bot
sudo bash deploy/provision-debian.sh
```

This installs everything (Asterisk, MariaDB, Node 20, ffmpeg, nginx, certbot,
fail2ban, ufw), creates the DB + app user, writes `server/.env`, applies the
schema, builds the UI, wires systemd + nginx + the firewall, and (if `DOMAIN` is
set) gets an HTTPS cert. Re-running is safe — it reuses the existing `.env`.

## 6. Configure your SIP trunk (the one manual step)

The script deliberately does **not** write your trunk config — those credentials
are yours to enter. The endpoint/peer must be named `trunk` (matches
`DIAL_ENDPOINT_TEMPLATE` in `.env`).

**PJSIP (Debian 12 / Asterisk 20):**
```bash
sudo cp /opt/call-bot/asterisk/pjsip.conf.sample /etc/asterisk/pjsip.conf
sudo nano /etc/asterisk/pjsip.conf           # provider host / user / pass
sudo asterisk -rx "pjsip reload"
sudo asterisk -rx "pjsip show registrations"  # should show Registered
```

**chan_sip (Debian 11 / Asterisk 16, `SIP_DRIVER=chan_sip`):**
```bash
sudo cp /opt/call-bot/asterisk/sip.conf.sample /etc/asterisk/sip.conf
sudo nano /etc/asterisk/sip.conf              # provider host / user / pass
sudo asterisk -rx "sip reload"
sudo asterisk -rx "sip show registry"         # should show Registered
sudo asterisk -rx "sip show peers"            # trunk should be reachable (OK)
```

## 7. Verify

```bash
curl -s localhost:4000/api/health            # {"status":"ok","db":"up","ari":"up"}
sudo asterisk -rx "ari show apps"            # lists: callbot
journalctl -u callbot-api -f                 # live backend logs
```

Then open the site, add a caller ID + a recording on **Audio & Caller IDs**, and
run a **2–3 contact test campaign** against numbers you own. Watch **Live Monitor**.
If you set up AMD, test once answering live and once letting it go to voicemail.

## 8. Re-deploying after code changes

```bash
# from your machine, push changes:
rsync -av --exclude node_modules --exclude .env --exclude client/dist \
  /c/prod-broadcast/ root@SERVER_IP:/opt/call-bot/

# on the server:
cd /opt/call-bot
sudo -u callbot -H bash -lc 'cd server && npm install --omit=dev && npm run migrate'
sudo -u callbot -H bash -lc 'cd client && npm install && npm run build'
sudo cp -r client/dist/. /var/www/callbot/
sudo systemctl restart callbot-api
```

`npm run migrate` is idempotent — safe to run on every deploy; it adds any new
columns/indexes without disturbing existing data.

## Troubleshooting first-run issues

| Symptom | Likely cause |
|---|---|
| `ari: "down"` in health, `ari show apps` empty | ARI password in `.env` ≠ `/etc/asterisk/ari.conf`; or Asterisk not restarted |
| Calls fail instantly | trunk not registered / wrong endpoint name (`pjsip show registrations` or `sip show registry`); endpoint must be named `trunk` |
| One-way or no audio | RTP UDP 10000–20000 blocked by firewall, or provider NAT |
| Caller ID ignored | carrier doesn't allow presenting that CLI on your account |
| Audio doesn't play | `AUDIO_DIR` not readable by the `asterisk` user (check group/perms) |

Backend logs: `journalctl -u callbot-api -f`. Asterisk: `sudo asterisk -rvvvvv`.
