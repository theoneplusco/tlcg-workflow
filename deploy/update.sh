#!/usr/bin/env bash
# Retired 2026-10-10: for the old workflow.tl-c.us app on Ubuntu. The live system is wf.tl-c.us (Mac Mini).
# Deploy the latest main. Run ON THE SERVER.
#   cd /opt/tlcg-workflow && bash deploy/update.sh
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/tlcg-workflow}"
cd "$APP_DIR"
echo "▶ Pulling latest..."
git pull --ff-only origin main
echo "▶ Syncing dependencies..."
npm install --omit=dev --no-audit --no-fund
echo "▶ Restarting..."
sudo systemctl restart tlcg-workflow
sleep 2
sudo systemctl --no-pager --lines=12 status tlcg-workflow
