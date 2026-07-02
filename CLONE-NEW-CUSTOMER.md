# call-bot — New Customer Setup (Level 1 Cheat Sheet)

You cloned the master VHD onto a new server for a new customer. Follow these steps
**in order**. Every step is copy-paste. Run as `root`.

> ⚠️ The clone contains the PREVIOUS customer's data and trunk. You MUST wipe the
> data (Step 2) and change the trunk (Step 4) before handing it over.

---

## Step 1 — Boot & note the IP
```
hostname -I
```
Write down the first IP — that's the web address: `http://<that-ip>`.
(Optional) name the box: `sudo hostnamectl set-hostname customername`

## Step 2 — ⚠️ WIPE the old customer's data (DO NOT SKIP)
This clears all old campaigns, contacts, call logs, users, audio, and caller IDs:
```
sudo mysql callbot -e "DELETE FROM users;"
sudo rm -f /usr/share/asterisk/sounds/callbot/*.wav
```
(Deleting users auto-removes everything they owned.)

## Step 3 — Create the customer's login
```
cd /opt/call-bot/server && sudo -u callbot -H npm run create-user -- 'admin' 'GiveThemAPassword' 'Administrator' admin
```
They log in with `admin` and that password. (Repeat for more logins, changing the name/password.)

## Step 4 — Plug in the customer's SIP trunk
```
sudo nano /etc/asterisk/sip.conf
```
In the `[trunk]` block change **host / username / secret** to the customer's trunk
details (and the `register =>` line if they use register auth). Save: `Ctrl+O`,
`Enter`, `Ctrl+X`. Then:
```
sudo systemctl restart asterisk
sudo asterisk -rx "sip show peer trunk"
sudo asterisk -rx "sip show registry"
```
Check: `Addr->IP` shows the customer's trunk, and (if register-based) it says
`Registered`. IP-auth trunks show `0 registrations` — that's normal.

## Step 5 — Set the trunk's call limit
Ask the customer how many **simultaneous calls** their trunk allows, put that number in:
```
sudo sed -i 's/^MAX_CONCURRENT_CALLS=.*/MAX_CONCURRENT_CALLS=30/' /opt/call-bot/server/.env
sudo -u callbot -H pm2 restart callbot-api
```
(Replace `30` with their real limit. Too high = `503` errors.)

## Step 6 — Point the web app at the new IP
```
IP=$(hostname -I | awk '{print $1}'); sudo sed -i "s#^CORS_ORIGIN=.*#CORS_ORIGIN=http://$IP#" /opt/call-bot/server/.env && sudo -u callbot -H pm2 restart callbot-api
```

## Step 7 — VERIFY it works
```
curl -s localhost:4000/api/health
sudo asterisk -rx "ari show apps"
```
Want `{"status":"ok","db":"up","ari":"up"}` and `callbot` listed.

Then open `http://<ip>` in a browser, log in, go to **Audio & Caller IDs**, upload a
test recording + add a caller ID, then **Campaigns → New** with ONE number (your own
phone), Run now, and confirm your phone rings and plays the audio. ✅ Done.

---

## Everyday commands

| Task | Command |
|---|---|
| Restart the app | `sudo -u callbot -H pm2 restart callbot-api` |
| App status | `sudo -u callbot -H pm2 status` |
| App logs (live) | `sudo -u callbot -H pm2 logs callbot-api` |
| Watch calls live | `sudo asterisk -rvvv` |
| Add a user | `cd /opt/call-bot/server && sudo -u callbot -H npm run create-user -- '<email>' '<pass>' '<name>' user` |
| Disable a user | `sudo mysql callbot -e "UPDATE users SET is_active=0 WHERE username='<email>';"` |
| Change dial speed | edit `MAX_CONCURRENT_CALLS` in `/opt/call-bot/server/.env` → `pm2 restart` → **make a new campaign** |
| Check trunk | `sudo asterisk -rx "sip show peer trunk"` |

After a server reboot everything auto-starts — just confirm with the health check.

---

## Troubleshooting (quick)

| Problem | Do this |
|---|---|
| Web page won't load | `sudo -u callbot -H pm2 status` (online?); `sudo systemctl status nginx` |
| `health` shows `ari: down` | `sudo systemctl restart asterisk` then `sudo -u callbot -H pm2 restart callbot-api` |
| Calls fail instantly | `sudo asterisk -rx "sip show peer trunk"` — is the trunk there and reachable? Re-check Step 4. |
| Flood of `503` / busy | Dialing faster than the trunk allows → lower `MAX_CONCURRENT_CALLS` (Step 5), make a new campaign |
| Audio: "does not exist in any format" | File path/permissions — escalate to L2 |
| Rings but no sound | Add `directmedia=no` and `nat=force_rport,comedia` to the `[trunk]`, restart asterisk |
| Campaign too slow | Raise `MAX_CONCURRENT_CALLS` (Step 5) and make a **new** campaign (speed locks at creation) |

---

## 3 golden rules
1. **Wipe data (Step 2) on every clone** — never hand a customer the previous one's data.
2. **After any `.env` change → `pm2 restart callbot-api`.**
3. **Dial-speed changes only apply to NEW campaigns**, never one that's already running.

Anything not on this sheet → escalate to L2 with: output of `pm2 logs callbot-api`
and `sudo asterisk -rvvv` during the problem.
