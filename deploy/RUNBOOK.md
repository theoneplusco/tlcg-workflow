# Cutover runbook — workflow.tl-c.us

> **Retired (2026-10-10).** This describes the old GAS-backed app at workflow.tl-c.us on the Ubuntu server (chinhnguyenserver). The live system is wf.tl-c.us on the Mac Mini; see `docs/SESSION_LOG.md` › Where things run. Kept for history only.


Copy-paste steps for deploying to the Ubuntu server and pointing Cloudflare at
it. Assumes steps 1–2 (Apps Script `APP_BASE_URL` + `.gs` deployment) are done.

Two values to have ready:

- `SERVER_IP` — the server's **public** IP (not `192.168.1.223`, which is LAN-only)
- The env values from Vercel → tlcg-workflow → Settings → Environment Variables

---

## Step 3 — Ubuntu server

### 3.1 Install

```bash
ssh <you>@<SERVER_IP>

# Node 18+ (skip if already installed — check with: node -v)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

sudo mkdir -p /opt/tlcg-workflow
sudo chown $USER:$USER /opt/tlcg-workflow
git clone https://github.com/theoneplusco/tlcg-workflow.git /opt/tlcg-workflow
cd /opt/tlcg-workflow
bash deploy/setup.sh
```

`setup.sh` verifies Node ≥ 18, installs production deps, creates `.env`
(mode 600), warns on a port clash, and installs the systemd unit with your
user and paths substituted in.

### 3.2 Configure

```bash
nano /opt/tlcg-workflow/.env
```

Minimum to set:

```ini
PORT=3000
HOST=127.0.0.1
APP_BASE_URL=https://workflow.tl-c.us

TLCG_CASH_BACKEND_URL=<CASH /exec URL>
TLCG_CORE_BACKEND_URL=<CORE /exec URL>
TLCG_P2P_BACKEND_URL=<P2P /exec URL>

GOOGLE_SERVICE_ACCOUNT_KEY=<full service-account JSON on ONE line>
MASTER_SPREADSHEET_ID=<id>
DRIVE_VOUCHER_FOLDER_ID=<id>
PURCHASE_REQUEST_FOLDER_ID=<id>
PAYMENT_REQUEST_FOLDER_ID=<id>
ACCEPTANCE_MINUTES_FOLDER_ID=<id>
```

`GOOGLE_SERVICE_ACCOUNT_KEY` is a live credential — `.env` is gitignored and
mode 600; keep it that way.

```bash
sudo systemctl restart tlcg-workflow
sudo systemctl status tlcg-workflow --no-pager
```

### 3.3 Verify locally (before any DNS change)

```bash
curl -sS localhost:3000/api/config
curl -sS -o /dev/null -w '%{http_code}\n' localhost:3000/
curl -sS -X POST localhost:3000/api/voucher \
  -H 'Content-Type: application/json' \
  -d '{"action":"getEmployees","lang":"en"}' | head -c 200
```

Expect: JSON config, `200`, then real employee data. If the third one fails,
the Apps Script URLs in `.env` are wrong — fix before continuing.

### 3.4 Reverse proxy

Port 3000 may be taken (n8n uses 5678, but Grafana likes 3000). Check:

```bash
ss -ltnp | grep -E ':(3000|5678) '
```

**Caddy** (TLS automatic):

```bash
sudo tee -a /etc/caddy/Caddyfile < /opt/tlcg-workflow/deploy/Caddyfile
sudo systemctl reload caddy
```

**nginx**:

```bash
sudo cp /opt/tlcg-workflow/deploy/nginx-tlcg-workflow.conf \
        /etc/nginx/sites-available/tlcg-workflow
sudo ln -s /etc/nginx/sites-available/tlcg-workflow /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d workflow.tl-c.us
```

With Cloudflare proxy enabled, certbot's HTTP-01 challenge can fail. Either
turn the orange cloud **off** during issuance and back on after, or use
DNS-01. Caddy has the same constraint.

---

## Step 4 — Cloudflare

In the dashboard for `tl-c.us`:

### 4.1 DNS

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `workflow` | `<SERVER_IP>` | **Proxied** (orange cloud) |

### 4.2 SSL/TLS

Set encryption mode to **Full (strict)**.

Not "Flexible" — that leaves the Cloudflare→origin hop unencrypted, so
passwords and signatures would cross the internet in plaintext. Requires the
origin certificate from 3.4 to be valid.

### 4.3 Origin firewall

Only Cloudflare should reach the origin, otherwise the proxy can be bypassed:

```bash
# allow SSH from your network first, or you will lock yourself out
sudo ufw allow from <YOUR_IP> to any port 22

for ip in $(curl -s https://www.cloudflare.com/ips-v4); do
  sudo ufw allow from $ip to any port 443 proto tcp
  sudo ufw allow from $ip to any port 80  proto tcp
done
sudo ufw enable
```

### 4.4 Caching

Leave at default. The app sends `no-cache` for HTML and the API is POST, which
Cloudflare does not cache. **Do not** add a "Cache Everything" page rule — it
would serve stale approval screens to approvers.

### 4.5 Verify end to end

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://workflow.tl-c.us/
curl -sS https://workflow.tl-c.us/api/config
curl -sSI https://workflow.tl-c.us/ | grep -i '^cf-ray'   # proves it is proxied
```

Then in a browser:

1. Load the site; switch EN/VI; reload and confirm the language persisted.
2. Log in.
3. Submit a voucher **with an attachment** — this exercises the upload path,
   the one piece that needs `GOOGLE_SERVICE_ACCOUNT_KEY`.
4. Open the approval email and confirm the link points at
   `workflow.tl-c.us`, not the old domain.

---

## Rollback

Nothing is destructive until DNS changes. If something breaks:

- Point the DNS record back at Vercel, or
- `sudo systemctl stop tlcg-workflow` and investigate with
  `journalctl -u tlcg-workflow -n 100`

Google Sheets is the datastore, so the server holds no state — no data can be
lost by stopping or rebuilding it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 502 from Cloudflare | app not running (`systemctl status`) or proxy pointing at the wrong port |
| 521/522 | origin firewall blocking Cloudflare, or the reverse proxy is not listening |
| Site loads, API 500s | Apps Script URLs wrong in `.env` |
| Uploads fail, rest works | `GOOGLE_SERVICE_ACCOUNT_KEY` missing or malformed |
| Everyone rate-limited together | `CF-Connecting-IP` not forwarded — check the proxy config |
| Approval emails link to the old domain | `APP_BASE_URL` Script Property not set in CASH **and** P2P |
