#!/usr/bin/env bash
#
# call-bot one-shot provisioner for Debian 12 (bookworm) — also works on Debian 11.
# Run as root from the project root after copying the code to the server:
#
#   sudo bash deploy/provision-debian.sh
#
# Re-running is safe: it reuses an existing server/.env and skips work already done.
# It does NOT touch /etc/asterisk/pjsip.conf — your SIP trunk credentials are yours
# to fill in (see asterisk/pjsip.conf.sample).

set -euo pipefail

# ======================= EDIT THESE =======================
APP_USER=callbot                 # system user the backend runs as
DB_NAME=callbot
DB_USER=callbot
DOMAIN=""                        # your domain for HTTPS, e.g. callbot.example.com. Blank = use server IP, no TLS.
LE_EMAIL=""                      # email for Let's Encrypt (needed only if DOMAIN is set)
ADMIN_USER="admin"               # initial login to create
ADMIN_PASS=""                    # initial password. Blank = skip (create later with npm run create-user).
SIP_TRUNK_IPS=""                 # space-separated provider IPs allowed on UDP 5060, e.g. "1.2.3.4 5.6.7.8". Blank = open to all (less secure).
SIP_DRIVER=pjsip                 # "pjsip" (Asterisk 18/20) or "chan_sip" (Asterisk 16 / Debian 11)
NODE_MAJOR=20
# ==========================================================

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root (sudo bash deploy/provision-debian.sh)."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

# The backend runs as a non-root service user, which can't traverse /root (700).
case "$APP_DIR" in
  /root|/root/*)
    die "Project is under /root, which the '$APP_USER' user can't access. Move it to /opt and re-run:
       sudo mv $APP_DIR /opt/call-bot && cd /opt/call-bot && sudo bash deploy/provision-debian.sh" ;;
esac

ENV_FILE="$APP_DIR/server/.env"
WEB_ROOT="/var/www/callbot"
# AUDIO_DIR is derived after Asterisk is installed — its sounds dir is
# distro-specific (Debian: /usr/share/asterisk/sounds; others: /var/lib/asterisk/sounds).
AUDIO_DIR="/var/lib/asterisk/sounds/callbot"  # fallback; overwritten below

envget() { grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2-; }
rand()   { openssl rand -hex 24; }

# ---- Secrets: reuse from existing .env, otherwise generate ----
if [ -f "$ENV_FILE" ]; then
  log "Existing server/.env found — reusing its secrets."
  DB_PASS="$(envget DB_PASSWORD)"
  ARI_USER="$(envget ARI_USERNAME)"
  ARI_PASS="$(envget ARI_PASSWORD)"
  ARI_APP="$(envget ARI_APP)"
  JWT_SECRET="$(envget JWT_SECRET)"
else
  DB_PASS="$(rand)"; ARI_PASS="$(rand)"; JWT_SECRET="$(rand)$(rand)"
  ARI_USER=callbot; ARI_APP=callbot
fi

# ---- Resolve the public-facing name for nginx / CORS ----
SERVER_IP="$(hostname -I | awk '{print $1}')"
SERVER_NAME="${DOMAIN:-$SERVER_IP}"

# The SIP driver shapes the dial string and which config file / reload commands apply.
if [ "$SIP_DRIVER" = "chan_sip" ]; then
  DIAL_TEMPLATE="SIP/{number}@trunk"
  SIP_SAMPLE="sip.conf.sample"; SIP_CONF="sip.conf"; SIP_RELOAD="sip reload"; SIP_SHOW="sip show registry"
else
  DIAL_TEMPLATE="PJSIP/{number}@trunk"
  SIP_SAMPLE="pjsip.conf.sample"; SIP_CONF="pjsip.conf"; SIP_RELOAD="pjsip reload"; SIP_SHOW="pjsip show registrations"
fi

log "Installing system packages…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg openssl git \
  asterisk asterisk-modules mariadb-server ffmpeg nginx certbot python3-certbot-nginx fail2ban ufw

# Asterisk resolves sound:... under <astdatadir>/sounds, and astdatadir differs
# by distro (Debian uses /usr/share/asterisk). Read it so our audio lands where
# Asterisk will actually look.
ASTDATADIR="$(awk -F'=>' '/^[[:space:]]*astdatadir/{gsub(/[ \t]/,"",$2);print $2}' /etc/asterisk/asterisk.conf 2>/dev/null)"
AUDIO_DIR="${ASTDATADIR:-/var/lib/asterisk}/sounds/callbot"
log "Audio will be stored in: $AUDIO_DIR"

# ---- Node.js (from NodeSource if missing or too old) ----
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] && NODE_OK=1
fi
if [ "$NODE_OK" -eq 0 ]; then
  log "Installing Node.js ${NODE_MAJOR}.x from NodeSource…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  log "Node $(node -v) already present — keeping it."
fi

# ---- App user + directories ----
log "Setting up app user '$APP_USER' and directories…"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
usermod -aG asterisk "$APP_USER"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
mkdir -p "$AUDIO_DIR"
chown "$APP_USER":asterisk "$AUDIO_DIR"
chmod 775 "$AUDIO_DIR"

# ---- MariaDB database + user ----
log "Creating MariaDB database and user…"
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

DIAL_ENDPOINT_TEMPLATE=$DIAL_TEMPLATE
DIAL_PREFIX=
DEFAULT_COUNTRY_CODE=
ORIGINATE_TIMEOUT=30
DIAL_AMD_CONTEXT=callbot-amd

# Trunk capacity — auto-pacing never exceeds these. Lower them for a small/demo trunk.
MAX_CONCURRENT_CALLS=50
MAX_CPS=100

AUDIO_DIR=$AUDIO_DIR
UPLOAD_TMP_DIR=$APP_DIR/server/uploads/tmp
FFMPEG_PATH=ffmpeg
ENV
  chown "$APP_USER":"$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  warn "server/.env already exists — leaving it untouched."
fi

# ---- Backend deps + schema + admin user ----
log "Installing backend dependencies…"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR/server' && npm install --omit=dev"
log "Applying database schema…"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR/server' && npm run migrate"
if [ -n "$ADMIN_PASS" ]; then
  log "Creating admin user '$ADMIN_USER'…"
  sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR/server' && npm run create-user -- '$ADMIN_USER' '$ADMIN_PASS' 'Administrator' admin"
else
  warn "ADMIN_PASS not set — create a login later: cd $APP_DIR/server && npm run create-user -- <user> <pass> <name> admin"
fi

# ---- Build frontend → web root ----
log "Building the frontend…"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR/client' && npm install && npm run build"
mkdir -p "$WEB_ROOT"
cp -r "$APP_DIR/client/dist/." "$WEB_ROOT/"

# ---- Asterisk: HTTP + ARI + AMD dialplan context (pjsip is left to you) ----
log "Configuring Asterisk HTTP/ARI…"
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

# Append the AMD Stasis context once (used by AMD-enabled campaigns).
if ! grep -q '^\[callbot-amd\]' /etc/asterisk/extensions.conf 2>/dev/null; then
  log "Adding [callbot-amd] dialplan context…"
  cat >> /etc/asterisk/extensions.conf <<'DIALPLAN'

; ---- call-bot answering-machine-detection context ----
[callbot-amd]
exten => _.,1,Answer()
 same => n,AMD()
 same => n,Stasis(callbot)
 same => n,Hangup()
DIALPLAN
fi

systemctl enable asterisk >/dev/null 2>&1 || true
systemctl restart asterisk

# ---- systemd service for the backend ----
log "Installing systemd service…"
sed "s#/opt/call-bot#$APP_DIR#g; s#^User=.*#User=$APP_USER#" \
  "$APP_DIR/deploy/callbot-api.service" > /etc/systemd/system/callbot-api.service
systemctl daemon-reload
systemctl enable --now callbot-api

# ---- nginx ----
log "Configuring nginx…"
sed "s/callbot.example.com/$SERVER_NAME/" \
  "$APP_DIR/deploy/nginx-callbot.conf" > /etc/nginx/sites-available/callbot
ln -sf /etc/nginx/sites-available/callbot /etc/nginx/sites-enabled/callbot
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ---- Firewall ----
log "Configuring UFW firewall…"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 10000:20000/udp                       # RTP audio
if [ -n "$SIP_TRUNK_IPS" ]; then
  added=0
  for ip in $SIP_TRUNK_IPS; do
    if ufw allow from "$ip" to any port 5060 proto udp >/dev/null 2>&1; then
      added=$((added + 1))
    else
      warn "Skipping invalid SIP source '$ip' — must be an IP or CIDR, not a hostname."
    fi
  done
  if [ "$added" -eq 0 ]; then
    warn "No valid SIP_TRUNK_IPS — opening UDP 5060 to all (restrict it later)."
    ufw allow 5060/udp
  fi
else
  warn "SIP_TRUNK_IPS empty — opening UDP 5060 to the world. Restrict this to your trunk ASAP."
  ufw allow 5060/udp
fi
ufw --force enable

# ---- HTTPS (only with a real domain + email) ----
if [ -n "$DOMAIN" ] && [ -n "$LE_EMAIL" ]; then
  log "Requesting Let's Encrypt certificate for $DOMAIN…"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect || \
    warn "certbot failed — check DNS points to this server, then re-run: certbot --nginx -d $DOMAIN"
else
  warn "No DOMAIN+LE_EMAIL set — skipping HTTPS. Strongly recommended before going live."
fi

# ---- Summary ----
if [ -n "$ADMIN_PASS" ]; then ADMIN_NOTE="$ADMIN_USER (password as you set)"; else ADMIN_NOTE="none yet — create with: cd $APP_DIR/server && npm run create-user -- <user> <pass> <name> admin"; fi
printf '\n\033[1;32m============================================================\033[0m\n'
cat <<SUMMARY
 call-bot is provisioned.

   URL            : http${DOMAIN:+s}://$SERVER_NAME
   App directory  : $APP_DIR
   Audio dir      : $AUDIO_DIR
   DB             : $DB_NAME (user $DB_USER)
   ARI user/pass  : $ARI_USER / $ARI_PASS
   Admin login    : $ADMIN_NOTE

 NEXT STEPS  (SIP driver: $SIP_DRIVER)
   1. Configure your SIP trunk in /etc/asterisk/$SIP_CONF
      (copy asterisk/$SIP_SAMPLE, fill provider creds), then:
         sudo asterisk -rx "$SIP_RELOAD"
         sudo asterisk -rx "$SIP_SHOW"
   2. Confirm the app connected to Asterisk:
         sudo asterisk -rx "ari show apps"     # should list: callbot
         curl -s localhost:4000/api/health
   3. Log in, add a caller ID + audio, and run a tiny test campaign.

 Service logs:  journalctl -u callbot-api -f
SUMMARY
printf '\033[1;32m============================================================\033[0m\n'
