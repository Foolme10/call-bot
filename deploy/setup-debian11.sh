#!/usr/bin/env bash
#
# call-bot — clean Debian 11 (bullseye) setup + troubleshooter.
# Installs EVERYTHING on a bare server: Asterisk 16 (chan_sip), MariaDB, Node 20,
# ffmpeg, nginx, the app itself, systemd service, firewall — then runs a health
# check. SIP driver is chan_sip (dial string SIP/{number}@trunk), which is the
# right choice for Debian 11 / Asterisk 16.
#
# USAGE (run as root, from the project root, e.g. /opt/call-bot):
#   sudo bash deploy/setup-debian11.sh              # full install (idempotent)
#   sudo bash deploy/setup-debian11.sh troubleshoot # diagnostics only, changes nothing
#
# Re-running the installer is safe: it reuses an existing server/.env and skips
# work already done.

set -euo pipefail

# ============================ EDIT THESE ============================
APP_USER=callbot                 # system user the backend runs as
DB_NAME=callbot
DB_USER=callbot

DOMAIN=""                        # e.g. callbot.example.com for HTTPS. Blank = use server IP over HTTP.
LE_EMAIL=""                      # email for Let's Encrypt (only used if DOMAIN is set)

ADMIN_USER="admin"               # first login to create
ADMIN_PASS="admin"               # first password (CHANGE after logging in). Blank = create later.

# ---- Trunk capacity (auto-pacing never exceeds these — set to what YOUR trunk allows) ----
MAX_CONCURRENT_CALLS=30          # max simultaneous live calls
MAX_CPS=10                       # max new calls launched per second

# ---- SIP trunk: how outbound calls leave this box ----
# TRUNK_MODE=netbird : reach a home/office SBC over NetBird (IP auth, no register).
# TRUNK_MODE=provider: a SIP provider with host + username/password (uses register).
# TRUNK_MODE=skip    : don't write sip.conf now (configure it yourself later).
TRUNK_MODE=netbird

# For TRUNK_MODE=netbird:
SBC_IP="100.87.152.55"           # the SBC's NetBird IP that Asterisk peers with
NETBIRD_SETUP_KEY=""             # NetBird setup key. Blank = install NetBird but skip `netbird up` (join manually).

# For TRUNK_MODE=provider:
SIP_HOST="sip.yourprovider.com"  # provider SIP host/IP
SIP_USERNAME="YOUR_SIP_USERNAME"
SIP_PASSWORD="YOUR_SIP_PASSWORD"

# Firewall: space-separated IPs/CIDRs allowed to send SIP to us on UDP 5060.
# For netbird mode this is typically the SBC's NetBird IP. Blank = open 5060 to all (less secure).
SIP_TRUNK_IPS=""

NODE_MAJOR=20
# ===================================================================

# ---------- pretty output ----------
log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '  \033[1;32m[ OK ]\033[0m %s\n' "$*"; }
bad()  { printf '  \033[1;31m[FAIL]\033[0m %s\n' "$*"; }
note() { printf '  \033[1;33m[ .. ]\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash deploy/setup-debian11.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$APP_DIR/server/.env"
WEB_ROOT="/var/www/callbot"

envget() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true; }

# ==========================================================================
# TROUBLESHOOTER — checks each layer and prints OK / FAIL with a hint. Never
# changes anything, so it's safe to run any time.
# ==========================================================================
diagnose() {
  printf '\n\033[1;36m======== call-bot diagnostics ========\033[0m\n'
  set +e

  # --- OS / tooling ---
  log "System & tools"
  . /etc/os-release 2>/dev/null
  printf '  OS: %s %s\n' "${NAME:-?}" "${VERSION_ID:-?}"
  [ "${VERSION_ID:-}" = "11" ] || warn "Not Debian 11 — this script targets bullseye/Asterisk 16."
  for bin in node npm asterisk mysql nginx ffmpeg ufw; do
    if command -v "$bin" >/dev/null 2>&1; then ok "$bin present ($($bin --version 2>/dev/null | head -n1))"; else bad "$bin missing"; fi
  done

  # --- services ---
  log "Services"
  for svc in mariadb asterisk nginx callbot-api; do
    if systemctl is-active --quiet "$svc"; then ok "$svc active"; else bad "$svc not active  → journalctl -u $svc -n 40"; fi
  done
  if command -v netbird >/dev/null 2>&1; then
    if netbird status >/dev/null 2>&1; then ok "netbird running"; else note "netbird installed but not connected → netbird up --setup-key <KEY>"; fi
  fi

  # --- listening ports ---
  log "Listening ports"
  ports_out="$(ss -lntup 2>/dev/null)"
  check_port() { echo "$ports_out" | grep -q ":$1\b" && ok "port $1 listening ($2)" || bad "port $1 NOT listening ($2)"; }
  check_port 4000 "node API"
  check_port 8088 "Asterisk ARI (localhost)"
  check_port 80   "nginx"
  # 5060 is UDP:
  if ss -lnu 2>/dev/null | grep -q ':5060'; then ok "UDP 5060 bound (SIP)"; else bad "UDP 5060 not bound → is chan_sip loaded? asterisk -rx 'sip show peer trunk'"; fi

  # --- database ---
  log "Database"
  local dpass duser dname
  duser="$(envget DB_USER)"; dpass="$(envget DB_PASSWORD)"; dname="$(envget DB_NAME)"
  if [ -z "$duser" ]; then bad "server/.env not found or DB_USER unset ($ENV_FILE)"; else
    if mysql -u"$duser" -p"$dpass" -e "USE \`$dname\`; SELECT 1;" >/dev/null 2>&1; then
      local nt; nt="$(mysql -N -u"$duser" -p"$dpass" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$dname';" 2>/dev/null)"
      ok "DB login works — $dname has ${nt:-?} tables"
      [ "${nt:-0}" -ge 5 ] || warn "Few tables — did 'npm run migrate' run? cd $APP_DIR/server && npm run migrate"
    else
      bad "cannot log in to DB as $duser → check DB_PASSWORD in .env / MariaDB is up"
    fi
  fi

  # --- app health endpoint ---
  log "App health (localhost:4000/api/health)"
  local health; health="$(curl -s --max-time 5 localhost:4000/api/health)"
  if [ -n "$health" ]; then
    echo "  $health"
    echo "$health" | grep -q '"db":"up"'  && ok "API ↔ DB up"  || bad "API can't reach DB"
    echo "$health" | grep -q '"ari":"up"' && ok "API ↔ Asterisk (ARI) up" || bad "API not connected to Asterisk ARI → check ari.conf user/pass matches .env, and 'asterisk -rx \"ari show apps\"'"
  else
    bad "no response from API → systemctl status callbot-api ; journalctl -u callbot-api -n 40"
  fi

  # --- Asterisk / ARI / SIP ---
  log "Asterisk"
  if asterisk -rx "core show version" >/dev/null 2>&1; then
    ok "$(asterisk -rx 'core show version' 2>/dev/null | head -n1)"
    asterisk -rx "ari show apps" 2>/dev/null | grep -qi callbot && ok "ARI Stasis app 'callbot' registered" || bad "Stasis app 'callbot' not registered → is callbot-api running & ARI creds correct?"
    if asterisk -rx "sip show peer trunk" >/dev/null 2>&1; then
      asterisk -rx "sip show peer trunk" 2>/dev/null | grep -E 'Addr->IP|Status' | sed 's/^/  /'
      asterisk -rx "sip show peer trunk" 2>/dev/null | grep -q 'Status: OK' && ok "trunk reachable (Status: OK)" || bad "trunk not OK → check SBC/provider reachable & allows this IP; sip.conf host correct"
    else
      bad "chan_sip has no 'trunk' peer → /etc/asterisk/sip.conf missing/invalid; asterisk -rx 'sip reload'"
    fi
  else
    bad "can't talk to Asterisk CLI → systemctl status asterisk"
  fi

  # --- audio dir ---
  log "Audio directory"
  local adir; adir="$(envget AUDIO_DIR)"
  if [ -n "$adir" ] && [ -d "$adir" ]; then
    ok "$adir exists ($(stat -c '%U:%G %a' "$adir" 2>/dev/null))"
  else
    bad "AUDIO_DIR '$adir' missing → Asterisk won't find recordings"
  fi

  # --- netbird reachability (netbird mode) ---
  if command -v netbird >/dev/null 2>&1 && [ -n "${SBC_IP:-}" ]; then
    log "NetBird → SBC"
    ping -c1 -W2 "$SBC_IP" >/dev/null 2>&1 && ok "SBC $SBC_IP reachable" || bad "cannot ping SBC $SBC_IP → netbird status; allow this peer on the SBC"
  fi

  # --- firewall ---
  log "Firewall"
  ufw status 2>/dev/null | grep -q "Status: active" && ok "UFW active" || warn "UFW inactive"

  printf '\n\033[1;36mTip:\033[0m live logs → \033[1mjournalctl -u callbot-api -f\033[0m   |   SIP trace → \033[1msngrep\033[0m\n'
  printf '\033[1;36m======================================\033[0m\n'
}

# ---- subcommand: diagnostics only ----
if [ "${1:-}" = "troubleshoot" ] || [ "${1:-}" = "check" ] || [ "${1:-}" = "diagnose" ]; then
  diagnose
  exit 0
fi

# ==========================================================================
# INSTALL
# ==========================================================================
case "$APP_DIR" in
  /root|/root/*) die "Project is under /root, which '$APP_USER' can't traverse. Move it:
       sudo mv $APP_DIR /opt/call-bot && cd /opt/call-bot && sudo bash deploy/setup-debian11.sh" ;;
esac

. /etc/os-release 2>/dev/null || true
[ "${VERSION_ID:-}" = "11" ] || warn "This targets Debian 11; you're on ${PRETTY_NAME:-unknown}. Continuing anyway."

SERVER_IP="$(hostname -I | awk '{print $1}')"
SERVER_NAME="${DOMAIN:-$SERVER_IP}"

# ---- secrets: reuse from an existing .env, else generate ----
rand() { openssl rand -hex 24; }
if [ -f "$ENV_FILE" ]; then
  log "Existing server/.env found — reusing its secrets."
  DB_PASS="$(envget DB_PASSWORD)"; ARI_USER="$(envget ARI_USERNAME)"
  ARI_PASS="$(envget ARI_PASSWORD)"; ARI_APP="$(envget ARI_APP)"; JWT_SECRET="$(envget JWT_SECRET)"
else
  DB_PASS="$(rand)"; ARI_PASS="$(rand)"; JWT_SECRET="$(rand)$(rand)"; ARI_USER=callbot; ARI_APP=callbot
fi

log "Installing system packages (this pulls in Asterisk, MariaDB, nginx, ffmpeg + troubleshooting tools)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  curl ca-certificates gnupg openssl git jq \
  asterisk asterisk-modules \
  mariadb-server \
  ffmpeg nginx certbot python3-certbot-nginx \
  ufw fail2ban \
  sngrep tcpdump dnsutils htop

# ---- Node.js from NodeSource if missing/old ----
NODE_OK=0
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then NODE_OK=1; fi
if [ "$NODE_OK" -eq 0 ]; then
  log "Installing Node.js ${NODE_MAJOR}.x…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  log "Node $(node -v) already present — keeping it."
fi

# Where Asterisk looks for sound: files (Debian: /usr/share/asterisk/sounds).
ASTDATADIR="$(awk -F'=>' '/^[[:space:]]*astdatadir/{gsub(/[ \t]/,"",$2);print $2}' /etc/asterisk/asterisk.conf 2>/dev/null)"
AUDIO_DIR="${ASTDATADIR:-/var/lib/asterisk}/sounds/callbot"
log "Audio will be stored in: $AUDIO_DIR"

# ---- app user + directories ----
log "Setting up app user '$APP_USER' and directories…"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
usermod -aG asterisk "$APP_USER"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
mkdir -p "$AUDIO_DIR" "$APP_DIR/server/uploads/tmp"
chown "$APP_USER":asterisk "$AUDIO_DIR"; chmod 775 "$AUDIO_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR/server/uploads"

# ---- MariaDB ----
log "Creating MariaDB database and user…"
systemctl enable --now mariadb >/dev/null 2>&1 || true
mariadb <<SQL
CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL

# ---- server/.env ----
if [ ! -f "$ENV_FILE" ]; then
  log "Writing server/.env…"
  cat > "$ENV_FILE" <<ENV
PORT=4000
CORS_ORIGIN=https://$SERVER_NAME,http://$SERVER_NAME
JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=12h

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
DB_NAME=$DB_NAME
DB_CONNECTION_LIMIT=15

ARI_URL=http://127.0.0.1:8088
ARI_USERNAME=$ARI_USER
ARI_PASSWORD=$ARI_PASS
ARI_APP=$ARI_APP

# chan_sip dial string (Debian 11 / Asterisk 16).
DIAL_ENDPOINT_TEMPLATE=SIP/{number}@trunk
DIAL_PREFIX=
DEFAULT_COUNTRY_CODE=
ORIGINATE_TIMEOUT=30
DIAL_AMD_CONTEXT=callbot-amd

# Trunk capacity — auto-pacing never exceeds these.
MAX_CONCURRENT_CALLS=$MAX_CONCURRENT_CALLS
MAX_CPS=$MAX_CPS
# Auto-pace sizing: avg seconds a call holds a line, and the finish-time window
# the app aims for (bigger list -> higher cps automatically, up to MAX_CPS).
AVG_CALL_SECONDS=20
TARGET_MINUTES=30

# ── SMS blasting (nuavox gateway) ──
# This customer's OWN gateway key goes here. Blank = SMS disabled (voice still works).
SMS_API_URL=http://sms.nuavox.com/api
SMS_AUTH_KEY=
SMS_MAX_CPS=10
SMS_MAX_CONCURRENT=20

AUDIO_DIR=$AUDIO_DIR
UPLOAD_TMP_DIR=$APP_DIR/server/uploads/tmp
FFMPEG_PATH=ffmpeg
ENV
  chown "$APP_USER":"$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"
else
  warn "server/.env already exists — leaving it untouched."
fi

# ---- backend deps + schema + admin ----
log "Installing backend dependencies…"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR/server' && npm install --omit=dev"
log "Applying database schema…"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR/server' && npm run migrate"
if [ -n "$ADMIN_PASS" ]; then
  log "Creating admin login '$ADMIN_USER'…"
  sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR/server' && npm run create-user -- '$ADMIN_USER' '$ADMIN_PASS' 'Administrator' admin" || \
    warn "create-user failed (maybe it already exists) — skipping."
else
  warn "ADMIN_PASS blank — create a login later: cd $APP_DIR/server && npm run create-user -- <user> <pass> <name> admin"
fi

# ---- frontend build → web root ----
log "Building the frontend…"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR/client' && npm install && npm run build"
mkdir -p "$WEB_ROOT"; cp -r "$APP_DIR/client/dist/." "$WEB_ROOT/"

# ---- Asterisk: HTTP + ARI + dialplan ----
log "Configuring Asterisk HTTP/ARI + dialplan…"
[ -f /etc/asterisk/http.conf ] && cp -n /etc/asterisk/http.conf /etc/asterisk/http.conf.bak
cat > /etc/asterisk/http.conf <<'HTTP'
[general]
enabled = yes
bindaddr = 127.0.0.1
bindport = 8088
HTTP

[ -f /etc/asterisk/ari.conf ] && cp -n /etc/asterisk/ari.conf /etc/asterisk/ari.conf.bak
cat > /etc/asterisk/ari.conf <<ARI
[general]
enabled = yes
pretty = yes

[$ARI_USER]
type = user
read_only = no
password = $ARI_PASS
ARI

# from-trunk (we don't take inbound calls) + AMD Stasis context.
if ! grep -q '^\[callbot-amd\]' /etc/asterisk/extensions.conf 2>/dev/null; then
  cat >> /etc/asterisk/extensions.conf <<'DIALPLAN'

; ---- call-bot ----
[from-trunk]
exten => _.,1,Hangup()          ; inbound not handled — broadcast is outbound only

[callbot-amd]
exten => _.,1,Answer()
 same => n,AMD()
 same => n,Stasis(callbot)
 same => n,Hangup()
DIALPLAN
fi

# ---- SIP trunk (chan_sip) ----
if [ "$TRUNK_MODE" != "skip" ]; then
  [ -f /etc/asterisk/sip.conf ] && cp -n /etc/asterisk/sip.conf /etc/asterisk/sip.conf.bak
  if [ "$TRUNK_MODE" = "netbird" ]; then
    log "Writing sip.conf (netbird → SBC $SBC_IP)…"
    cat > /etc/asterisk/sip.conf <<SIP
[general]
context=from-trunk
bindaddr=0.0.0.0
bindport=5060
allowguest=no
alwaysauthreject=yes
disallow=all
allow=ulaw
allow=alaw
nat=force_rport,comedia
localnet=100.87.0.0/16          ; NetBird range — media stays local to the tunnel

[trunk]
type=peer
host=$SBC_IP
port=5060
context=from-trunk
qualify=yes
insecure=invite,port           ; IP auth (no username/secret)
nat=force_rport,comedia
directmedia=no
disallow=all
allow=ulaw
allow=alaw
trustrpid=yes
sendrpid=yes
SIP
  else
    log "Writing sip.conf (provider $SIP_HOST with register)…"
    cat > /etc/asterisk/sip.conf <<SIP
[general]
context=from-trunk
bindaddr=0.0.0.0
bindport=5060
allowguest=no
alwaysauthreject=yes
disallow=all
allow=ulaw
allow=alaw

register => $SIP_USERNAME:$SIP_PASSWORD@$SIP_HOST

[trunk]
type=peer
host=$SIP_HOST
username=$SIP_USERNAME
defaultuser=$SIP_USERNAME
fromuser=$SIP_USERNAME
secret=$SIP_PASSWORD
fromdomain=$SIP_HOST
context=from-trunk
qualify=yes
insecure=invite,port
disallow=all
allow=ulaw
trustrpid=yes
sendrpid=yes
SIP
  fi
else
  warn "TRUNK_MODE=skip — configure /etc/asterisk/sip.conf yourself, then: asterisk -rx 'sip reload'"
fi

systemctl enable asterisk >/dev/null 2>&1 || true
systemctl restart asterisk

# ---- NetBird (netbird mode) ----
if [ "$TRUNK_MODE" = "netbird" ]; then
  if ! command -v netbird >/dev/null 2>&1; then
    log "Installing NetBird…"
    curl -fsSL https://pkgs.netbird.io/install.sh | sh
  fi
  if [ -n "$NETBIRD_SETUP_KEY" ]; then
    log "Joining NetBird network…"
    netbird up --setup-key "$NETBIRD_SETUP_KEY" || warn "netbird up failed — run it manually with your key."
  else
    warn "NETBIRD_SETUP_KEY blank — join later: netbird up --setup-key <KEY>  (SBC must be pingable for the trunk to work)"
  fi
fi

# ---- systemd service ----
log "Installing systemd service callbot-api…"
sed "s#/opt/call-bot#$APP_DIR#g; s#^User=.*#User=$APP_USER#" \
  "$APP_DIR/deploy/callbot-api.service" > /etc/systemd/system/callbot-api.service
systemctl daemon-reload
systemctl enable --now callbot-api
systemctl restart callbot-api

# ---- nginx ----
log "Configuring nginx…"
sed "s/callbot.example.com/$SERVER_NAME/" \
  "$APP_DIR/deploy/nginx-callbot.conf" > /etc/nginx/sites-available/callbot
ln -sf /etc/nginx/sites-available/callbot /etc/nginx/sites-enabled/callbot
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ---- firewall ----
log "Configuring UFW…"
# In netbird mode, SIP arrives over the tunnel — default the allow-list to the
# NetBird range so we don't expose UDP 5060 to internet scanners.
if [ -z "$SIP_TRUNK_IPS" ] && [ "$TRUNK_MODE" = "netbird" ]; then
  SIP_TRUNK_IPS="100.87.0.0/16"
fi
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 10000:20000/udp           # RTP audio
if [ -n "$SIP_TRUNK_IPS" ]; then
  for ip in $SIP_TRUNK_IPS; do
    ufw allow from "$ip" to any port 5060 proto udp >/dev/null 2>&1 && ok "allowed SIP from $ip" || warn "bad SIP source '$ip' (need IP/CIDR)"
  done
else
  warn "SIP_TRUNK_IPS empty — opening UDP 5060 to all. Restrict to your trunk ASAP."
  ufw allow 5060/udp
fi
ufw --force enable

# ---- HTTPS ----
if [ -n "$DOMAIN" ] && [ -n "$LE_EMAIL" ]; then
  log "Requesting Let's Encrypt cert for $DOMAIN…"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect || \
    warn "certbot failed — ensure DNS for $DOMAIN points here, then: certbot --nginx -d $DOMAIN"
else
  warn "No DOMAIN+LE_EMAIL — skipping HTTPS. Recommended before going live (login token is sent in a header)."
fi

# ---- summary + diagnostics ----
if [ -n "$ADMIN_PASS" ]; then
  ADMIN_NOTE="$ADMIN_USER  (log in, then CHANGE the password)"
else
  ADMIN_NOTE="none yet — create: cd $APP_DIR/server && npm run create-user -- <user> <pass> <name> admin"
fi
printf '\n\033[1;32m============================================================\033[0m\n'
cat <<SUMMARY
 call-bot is installed on Debian 11 (chan_sip).

   URL           : http${DOMAIN:+s}://$SERVER_NAME
   App dir       : $APP_DIR
   Audio dir     : $AUDIO_DIR
   DB            : $DB_NAME (user $DB_USER)
   ARI user/pass : $ARI_USER / $ARI_PASS
   Admin login   : $ADMIN_NOTE
   Trunk mode    : $TRUNK_MODE

 Re-run diagnostics any time:  sudo bash deploy/setup-debian11.sh troubleshoot
SUMMARY
printf '\033[1;32m============================================================\033[0m\n'

log "Running post-install diagnostics…"
diagnose
