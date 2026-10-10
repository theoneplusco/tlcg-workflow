#!/usr/bin/env bash
# Retired 2026-10-10: for the old workflow.tl-c.us app on Ubuntu. The live system is wf.tl-c.us (Mac Mini).
# First-time setup for TLCG Workflow on Ubuntu.
# Run ON THE SERVER as a user with sudo.
#
#   git clone https://github.com/theoneplusco/tlcg-workflow.git /opt/tlcg-workflow
#   cd /opt/tlcg-workflow && bash deploy/setup.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tlcg-workflow}"
SERVICE=tlcg-workflow

echo "▶ TLCG Workflow setup — $APP_DIR"

if [ ! -f "$APP_DIR/server.js" ]; then
  echo "✗ server.js not found in $APP_DIR. Clone the repo there first." >&2
  exit 1
fi
cd "$APP_DIR"

# ── Node ──────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not installed. Install Node 18+ first:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs" >&2
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node $NODE_MAJOR too old; need >= 18 (package.json engines)." >&2
  exit 1
fi
echo "✓ Node $(node -v)"

# ── Dependencies (production only) ────────────────────────────
echo "▶ Installing production dependencies..."
npm install --omit=dev --no-audit --no-fund

# ── Env file ──────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "⚠ Created .env from template — FILL IT IN before starting:"
  echo "    nano $APP_DIR/.env"
  echo "  Copy values from Vercel → tlcg-workflow → Settings → Environment Variables"
  NEEDS_ENV=1
else
  chmod 600 .env
  echo "✓ .env present"
  NEEDS_ENV=0
fi

# ── Port check ────────────────────────────────────────────────
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo 3000)"
PORT="${PORT:-3000}"
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "⚠ Port $PORT is already in use (n8n? grafana?). Change PORT in .env."
fi

# ── systemd ───────────────────────────────────────────────────
echo "▶ Installing systemd unit..."
sudo cp deploy/$SERVICE.service /etc/systemd/system/
# Point the unit at the real user + directory
sudo sed -i "s|^User=.*|User=$(id -un)|"          /etc/systemd/system/$SERVICE.service
sudo sed -i "s|^Group=.*|Group=$(id -gn)|"        /etc/systemd/system/$SERVICE.service
sudo sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" /etc/systemd/system/$SERVICE.service
sudo sed -i "s|^EnvironmentFile=.*|EnvironmentFile=$APP_DIR/.env|" /etc/systemd/system/$SERVICE.service
sudo sed -i "s|^ReadOnlyPaths=.*|ReadOnlyPaths=$APP_DIR|" /etc/systemd/system/$SERVICE.service
sudo systemctl daemon-reload

if [ "$NEEDS_ENV" = "1" ]; then
  echo
  echo "▶ Setup complete, but .env is EMPTY. Fill it in, then:"
  echo "    sudo systemctl enable --now $SERVICE"
else
  sudo systemctl enable --now $SERVICE
  sleep 2
  sudo systemctl --no-pager --lines=15 status $SERVICE || true
fi

cat <<TXT

────────────────────────────────────────────────────────────
Next steps
  1. Fill in  $APP_DIR/.env       (if not already)
  2. sudo systemctl restart $SERVICE
  3. Verify:  curl -sS localhost:$PORT/api/config
  4. Reverse proxy — pick one:
       Caddy: append deploy/Caddyfile to /etc/caddy/Caddyfile
       nginx: see deploy/nginx-tlcg-workflow.conf
  5. Point workflow.tl-c.us DNS at this server
Logs: journalctl -u $SERVICE -f
────────────────────────────────────────────────────────────
TXT
