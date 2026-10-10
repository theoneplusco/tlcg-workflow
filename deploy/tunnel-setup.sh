#!/usr/bin/env bash
#
# TLCG Workflow — tunnel routes + systemd service.
# Run ON THE SERVER:   bash ~/tunnel-setup.sh
#
# What it does:
#   1. Installs the systemd unit for the app (port 3001) and takes over the
#      orphaned nohup process currently serving it.
#   2. Creates Cloudflare DNS CNAMEs for the new hostnames.
#   3. Rewrites /etc/cloudflared/config.yml with the new hostnames.
#   4. Validates the config, then restarts cloudflared.
#
# Every change is backed up and the config is validated BEFORE the restart,
# so a typo cannot take your tunnel down.
set -euo pipefail

# Retired 2026-10-10: this rewrites /etc/cloudflared/config.yml with the old workflow.tl-c.us route.
# The live system is wf.tl-c.us on the Mac Mini. Refuse to run unless forced.
if [ "${FORCE_RETIRED_SETUP:-}" != "1" ]; then
  echo "deploy/tunnel-setup.sh is retired (workflow.tl-c.us was replaced by wf.tl-c.us). Not running."; exit 1
fi

APP=/opt/tlcg-workflow
CFG=/etc/cloudflared/config.yml
TUNNEL=theoneplus-tunnel
STAMP=$(date +%Y%m%d-%H%M%S)

echo "════════════════════════════════════════════════════"
echo " TLCG Workflow — tunnel + service setup"
echo "════════════════════════════════════════════════════"
echo
echo "Hostname changes:"
echo "   n8nhp.wato.one        -> n8n.theoneplus.co      (:5678)"
echo "   crm.wato.com          -> crm.theoneplus.co      (:3000)"
echo "   oneplus.theoneplus.co -> unchanged              (:3100)"
echo "   NEW: workflow.tl-c.us                           (:3001)"
echo
echo "NOTE: crm.wato.com never resolved — wato.com is not a registered"
echo "      domain, so that route has been dead. This fixes it."
echo
read -rp "Proceed? [y/N] " ok
[[ "$ok" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# ── 1. systemd service for the app ──────────────────────────────
echo
echo "▶ 1/4  Installing the app service"
cd "$APP"
sudo cp deploy/tlcg-workflow.service /etc/systemd/system/
sudo sed -i "s|^User=.*|User=$(id -un)|"                       /etc/systemd/system/tlcg-workflow.service
sudo sed -i "s|^Group=.*|Group=$(id -gn)|"                     /etc/systemd/system/tlcg-workflow.service
sudo sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$APP|"    /etc/systemd/system/tlcg-workflow.service
sudo sed -i "s|^EnvironmentFile=.*|EnvironmentFile=$APP/.env|" /etc/systemd/system/tlcg-workflow.service
sudo sed -i "s|^ReadOnlyPaths=.*|ReadOnlyPaths=$APP|"          /etc/systemd/system/tlcg-workflow.service
sudo systemctl daemon-reload

# free port 3001 from any manually-started process
for pid in $(pgrep -f "node server.js" || true); do
  if [ "$(readlink -f /proc/$pid/cwd 2>/dev/null)" = "$APP" ]; then
    echo "   stopping orphaned process $pid"
    kill -TERM "$pid" 2>/dev/null || true
  fi
done
sleep 2

sudo systemctl enable --now tlcg-workflow
sleep 3
if systemctl is-active --quiet tlcg-workflow; then
  echo "   ✓ tlcg-workflow active"
else
  echo "   ✗ failed to start:"; sudo journalctl -u tlcg-workflow -n 20 --no-pager; exit 1
fi

# ── 2. DNS records ──────────────────────────────────────────────
echo
echo "▶ 2/4  Creating Cloudflare DNS records"
for h in n8n.theoneplus.co crm.theoneplus.co workflow.tl-c.us; do
  echo -n "   $h ... "
  if cloudflared tunnel route dns "$TUNNEL" "$h" 2>&1 | grep -qiE "added|already exists|updated"; then
    echo "ok"
  else
    echo "FAILED — is the zone in this Cloudflare account?"
    cloudflared tunnel route dns "$TUNNEL" "$h" 2>&1 | tail -3
  fi
done

# ── 3. Rewrite ingress ──────────────────────────────────────────
echo
echo "▶ 3/4  Updating $CFG"
sudo cp "$CFG" "$CFG.backup-$STAMP"
echo "   backup: $CFG.backup-$STAMP"

sudo tee "$CFG" > /dev/null <<'YAML'
tunnel: 01f7d3dd-bd98-4aa9-bc84-43ee178c9522
credentials-file: /home/chinhnguyen/.cloudflared/01f7d3dd-bd98-4aa9-bc84-43ee178c9522.json

ingress:
  - hostname: n8n.theoneplus.co
    service: http://localhost:5678

  - hostname: crm.theoneplus.co
    service: http://localhost:3000

  - hostname: oneplus.theoneplus.co
    service: http://localhost:3100

  # TLCG Workflow (BPM). Cloudflare terminates TLS; the app listens on
  # 127.0.0.1:3001 because 3000 is taken by twenty_crm.
  - hostname: workflow.tl-c.us
    service: http://localhost:3001
    originRequest:
      connectTimeout: 30s
      # Apps Script can be slow to respond.
      noTLSVerify: false

  - service: http_status:404
YAML

# ── 4. Validate, then restart ───────────────────────────────────
echo
echo "▶ 4/4  Validating config before restart"
if cloudflared --config "$CFG" tunnel ingress validate; then
  echo "   ✓ config valid"
else
  echo "   ✗ INVALID — restoring backup, tunnel untouched"
  sudo cp "$CFG.backup-$STAMP" "$CFG"
  exit 1
fi

echo "   restarting cloudflared (brief blip on all hostnames)..."
sudo systemctl restart cloudflared
sleep 6
systemctl is-active --quiet cloudflared && echo "   ✓ cloudflared active" || {
  echo "   ✗ cloudflared failed:"; sudo journalctl -u cloudflared -n 20 --no-pager; exit 1; }

# ── Verify ──────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════"
echo " Verify"
echo "════════════════════════════════════════════════════"
curl -sS -o /dev/null -w "   local  :3001            -> %{http_code}\n" localhost:3001/ || true
echo
echo "   DNS may take a minute. Then test:"
echo "     https://workflow.tl-c.us"
echo "     https://n8n.theoneplus.co"
echo "     https://crm.theoneplus.co"
echo
echo "   Logs:  journalctl -u tlcg-workflow -f"
echo "          journalctl -u cloudflared -f"
echo
echo "   Rollback tunnel config:"
echo "     sudo cp $CFG.backup-$STAMP $CFG && sudo systemctl restart cloudflared"
