#!/usr/bin/env bash
#
# One-command deploy: pull the latest code from GitHub, rebuild, restart.
#
#   sudo bash /opt/call-bot/deploy/update.sh
#
# Safe to run any time; does nothing destructive. Note: restarting the backend
# mid-campaign re-queues in-flight calls (they get redialed on resume), so
# prefer updating while no campaign is running.

set -euo pipefail

APP_DIR=/opt/call-bot
APP_USER=callbot
WEB_ROOT=/var/www/callbot

log() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

cd "$APP_DIR"

log "Pulling latest code from GitHub…"
git pull --ff-only

# Pulls run as root, which leaves new/changed files root-owned; npm then runs
# as $APP_USER and needs to write here (package-lock, node_modules, dist).
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

log "Backend: dependencies + database migrations…"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR/server' && npm install --omit=dev && npm run migrate"

log "Frontend: build + publish…"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR/client' && npm install && npm run build"
cp -r "$APP_DIR/client/dist/." "$WEB_ROOT/"

log "Restarting backend…"
if systemctl list-unit-files 2>/dev/null | grep -q '^callbot-api'; then
  systemctl restart callbot-api
elif sudo -u "$APP_USER" -H pm2 describe callbot-api >/dev/null 2>&1; then
  sudo -u "$APP_USER" -H pm2 restart callbot-api
else
  echo "[warn] Could not find a callbot-api service (systemd or pm2) — restart it manually."
fi

sleep 2
log "Health check:"
curl -s localhost:4000/api/health || true
echo
log "Done. Current version: $(git log --oneline -1)"
