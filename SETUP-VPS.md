# call-bot — Full VPS Setup (Debian 11, PM2, trunk → SBC over NetBird)

Run as `root`, in order. Each step is one paste. Assumes dependencies are already
installed (`asterisk asterisk-modules mariadb-server ffmpeg nginx git ufw curl`,
Node 20 via NodeSource, `pm2` via `npm i -g pm2`).

---

## Step 1 — Get the code to /opt/call-bot
From your dev machine or the working instance (run on the SOURCE machine):
```
rsync -av --exclude node_modules --exclude .env --exclude client/dist <source-path>/ root@NEW_VPS_IP:/opt/call-bot/
```
On the VPS, confirm it landed:
```
ls /opt/call-bot/server/package.json && echo OK
```

## Step 2 — App user + directories
```
sudo useradd --system --create-home --shell /bin/bash callbot 2>/dev/null; sudo usermod -aG asterisk callbot && sudo chown -R callbot:callbot /opt/call-bot && sudo mkdir -p /usr/share/asterisk/sounds/callbot && sudo chown callbot:asterisk /usr/share/asterisk/sounds/callbot && sudo chmod 775 /usr/share/asterisk/sounds/callbot
```

## Step 3 — Database + .env  (password = callbot123, change later if you want)
```
sudo mysql -e "CREATE DATABASE IF NOT EXISTS callbot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS 'callbot'@'localhost' IDENTIFIED BY 'callbot123'; ALTER USER 'callbot'@'localhost' IDENTIFIED BY 'callbot123'; GRANT ALL PRIVILEGES ON callbot.* TO 'callbot'@'localhost'; FLUSH PRIVILEGES;"
sudo -u callbot tee /opt/call-bot/server/.env >/dev/null <<'ENV'
PORT=4000
CORS_ORIGIN=http://SERVER_IP
JWT_SECRET=REPLACE_JWT
JWT_EXPIRES_IN=12h
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=callbot
DB_PASSWORD=callbot123
DB_NAME=callbot
DB_CONNECTION_LIMIT=15
ARI_URL=http://127.0.0.1:8088
ARI_USERNAME=callbot
ARI_PASSWORD=callbot123
ARI_APP=callbot
DIAL_ENDPOINT_TEMPLATE=SIP/{number}@trunk
ORIGINATE_TIMEOUT=30
DIAL_AMD_CONTEXT=callbot-amd
MAX_CONCURRENT_CALLS=30
MAX_CPS=10
AUDIO_DIR=/usr/share/asterisk/sounds/callbot
UPLOAD_TMP_DIR=/opt/call-bot/server/uploads/tmp
FFMPEG_PATH=ffmpeg
ENV
sudo sed -i "s#SERVER_IP#$(hostname -I | awk '{print $1}')#; s#REPLACE_JWT#$(openssl rand -hex 48)#" /opt/call-bot/server/.env
```

## Step 4 — Asterisk HTTP + ARI + AMD dialplan
```
sudo tee /etc/asterisk/http.conf >/dev/null <<'EOF'
[general]
enabled = yes
bindaddr = 127.0.0.1
bindport = 8088
EOF
sudo tee /etc/asterisk/ari.conf >/dev/null <<'EOF'
[general]
enabled = yes
pretty = yes
[callbot]
type = user
read_only = no
password = callbot123
EOF
grep -q '^\[callbot-amd\]' /etc/asterisk/extensions.conf || sudo tee -a /etc/asterisk/extensions.conf >/dev/null <<'EOF'

[callbot-amd]
exten => _.,1,Answer()
 same => n,AMD()
 same => n,Stasis(callbot)
 same => n,Hangup()
EOF
```

## Step 5 — NetBird (so the VPS can reach your home SBC)
```
curl -fsSL https://pkgs.netbird.io/install.sh | sudo sh
sudo netbird up --setup-key YOUR_SETUP_KEY
netbird status
ping -c3 100.87.152.55
```
Get the setup key from your NetBird dashboard. `ping` to the SBC must reply before the trunk will work.

## Step 6 — SIP trunk → the SBC
```
sudo tee /etc/asterisk/sip.conf >/dev/null <<'EOF'
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
localnet=100.87.0.0/16

[trunk]
type=peer
host=100.87.152.55
port=5060
context=from-trunk
qualify=yes
insecure=invite,port
nat=force_rport,comedia
directmedia=no
disallow=all
allow=ulaw
allow=alaw
EOF
sudo systemctl restart asterisk
sudo asterisk -rx "sip show peer trunk" | grep -E 'Addr->IP|Status'
```
Edit `host=` if your SBC's NetBird IP differs. Add `username`/`secret`/`register =>` only if the SBC requires auth (IP-auth needs none). **On the SBC itself, allow this VPS's NetBird IP.**

## Step 7 — Backend deps + DB tables + admin login
```
cd /opt/call-bot/server && sudo -u callbot -H npm install --omit=dev && sudo -u callbot -H npm run migrate && sudo -u callbot -H npm run create-user -- admin 'admin' Administrator admin
```

## Step 8 — Build the UI + nginx
```
cd /opt/call-bot/client && rm -rf node_modules && sudo -u callbot -H npm install && sudo -u callbot -H npm run build && sudo cp -r dist /var/www/callbot
sudo tee /etc/nginx/sites-available/callbot >/dev/null <<'EOF'
server {
  listen 80;
  server_name _;
  root /var/www/callbot;
  index index.html;
  location / { try_files $uri $uri/ /index.html; }
  location /api/ { proxy_pass http://127.0.0.1:4000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; client_max_body_size 30m; }
  location /ws/ { proxy_pass http://127.0.0.1:4000; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_set_header Host $host; proxy_read_timeout 3600s; }
}
EOF
sudo ln -sf /etc/nginx/sites-available/callbot /etc/nginx/sites-enabled/callbot && sudo rm -f /etc/nginx/sites-enabled/default && sudo nginx -t && sudo systemctl reload nginx
```

## Step 9 — Start the app with PM2 (+ boot startup)
```
cd /opt/call-bot/server && sudo -u callbot -H pm2 start src/index.js --name callbot-api && sudo -u callbot -H pm2 save && sudo env PATH=$PATH pm2 startup systemd -u callbot --hp /home/callbot
```

## Step 10 — Firewall
```
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 10000:20000/udp && sudo ufw allow 5060/udp && sudo ufw --force enable
```

## Step 11 — Verify
```
curl -s localhost:4000/api/health && echo && sudo asterisk -rx "ari show apps" && sudo asterisk -rx "sip show peer trunk" | grep -E 'Addr->IP|Status'
```
Want `{"status":"ok","db":"up","ari":"up"}`, `callbot` listed, and the trunk `Addr->IP`
= the SBC with `Status: OK`. Then open `http://<vps-ip>`, log in `admin`/`admin`,
upload a test audio + caller ID, and run a 1-number test campaign.

---

## After a reboot
Everything auto-starts (mariadb/asterisk/nginx via systemd, callbot-api via PM2,
netbird via its own service). Just verify with the health check above.

## Manage
`sudo -u callbot -H pm2 restart|logs|status callbot-api` · `sudo asterisk -rvvv`
