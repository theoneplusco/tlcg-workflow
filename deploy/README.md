# Self-hosting TLCG Workflow on Ubuntu

> **Retired (2026-10-10).** This describes the old GAS-backed app at workflow.tl-c.us on the Ubuntu server (chinhnguyenserver). The live system is wf.tl-c.us on the Mac Mini; see `docs/SESSION_LOG.md` › Where things run. Kept for history only.


Runs the app as one Node process alongside n8n. The `api/` handlers are plain
`(req, res)` functions with no Vercel-specific imports, so `server.js` mounts
them on Express unchanged.

## What runs where

```
Browser
   │  https://workflow.tl-c.us
   ▼
Cloudflare edge  (TLS terminated here)
   │  encrypted tunnel, outbound-only — no exposed IP, no open ports
   ▼
cloudflared on the Ubuntu server
   ├── n8n.theoneplus.co       → :5678   n8n
   ├── crm.theoneplus.co       → :3000   twenty_crm
   ├── oneplus.theoneplus.co   → :3100   oneplus-web
   └── workflow.tl-c.us        → :3001   this app
                                            │
                                            ▼
                            Google Apps Script ×3  →  Sheets / Drive
```

The frontend and the API share one origin: the pages call relative
`/api/voucher`, so there is no cross-origin request and CORS never engages
in normal use.

There is **no database**. Google Sheets is the datastore, so the server is
stateless — if it dies, redeploy and nothing is lost.

## Install

```bash
sudo mkdir -p /opt/tlcg-workflow && sudo chown $USER:$USER /opt/tlcg-workflow
git clone https://github.com/theoneplusco/tlcg-workflow.git /opt/tlcg-workflow
cd /opt/tlcg-workflow
bash deploy/setup.sh
```

`setup.sh` checks Node ≥ 18, installs production deps, creates `.env` from the
template (mode 600), warns on a port clash, and installs + enables the systemd
unit with the correct user and paths.

## Configure

```bash
nano /opt/tlcg-workflow/.env      # values from Vercel → Settings → Environment Variables
sudo systemctl restart tlcg-workflow
```

Required for Drive uploads: `GOOGLE_SERVICE_ACCOUNT_KEY` (full service-account
JSON on one line) and `MASTER_SPREADSHEET_ID`. The `TLCG_*_BACKEND_URL` vars
each have a hardcoded fallback, so the app runs without them — set them anyway
so Apps Script URLs can be rotated without editing source.

**`.env` holds a live Google credential.** It is gitignored and `chmod 600`;
keep it that way.

## Reverse proxy

Pick one and add it next to the existing n8n config:

- **Caddy** — append `deploy/Caddyfile`, `sudo systemctl reload caddy`.
  TLS is automatic.
- **nginx** — copy `deploy/nginx-tlcg-workflow.conf` to `sites-available`,
  symlink into `sites-enabled`, `nginx -t && systemctl reload nginx`, then
  `sudo certbot --nginx -d workflow.tl-c.us`.

Both set a 12 MB body limit (the app declares 10 MB) and a 120 s read timeout,
because Apps Script can be slow to respond.

## Verify

```bash
curl -sS localhost:3000/api/config                 # JSON of non-secret config
curl -sS -o /dev/null -w '%{http_code}\n' localhost:3000/     # 200
journalctl -u tlcg-workflow -f
```

Then in a browser: load the site, switch EN/VI, reload and confirm the language
persisted, and submit a voucher with an attachment to exercise the upload path.

## Update

```bash
cd /opt/tlcg-workflow && bash deploy/update.sh
```

Pulls `main`, syncs prod deps, restarts the service.

## Cloudflare Tunnel

This server reaches Cloudflare through **cloudflared** (tunnel
`theoneplus-tunnel`), not a public IP. That means:

- no ports open to the internet, and the origin IP is never exposed
- no certbot and no origin certificate — Cloudflare terminates TLS
- no origin firewall rules, because there is no inbound path to firewall
- SSL/TLS mode and "Full (strict)" are irrelevant here

Routing lives in `/etc/cloudflared/config.yml` as ingress rules, one per
hostname, each pointing at a localhost port. A DNS CNAME per hostname is
created with:

```bash
cloudflared tunnel route dns theoneplus-tunnel <hostname>
```

Always validate before restarting — a bad rule takes down every hostname
on the tunnel, not just the new one:

```bash
cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
sudo systemctl restart cloudflared
```

**Caching** — leave at default. The app sends `no-cache` for HTML and the API
is POST, which Cloudflare does not cache. Do not add a "Cache Everything"
rule; it would serve stale approval screens.

**Port note** — the app listens on **3001**, not 3000: `twenty_crm` already
owns 3000 on this host.

**Client IP** — with a tunnel, `CF-Connecting-IP` arrives from the edge and
the app's `trust proxy` setting picks it up, so the per-IP rate limit sees
real visitors.

## Cutover from Vercel

1. Deploy here and test via the server IP or a temporary hostname.
2. Copy every env var out of Vercel **before** touching DNS.
3. Set `APP_BASE_URL=https://workflow.tl-c.us` in `.env`, and set the
   matching `APP_BASE_URL` Script Property in **both** the CASH and P2P
   Apps Script projects — approval emails embed it, so a stale value sends
   approvers to a dead link.
4. Point `workflow.tl-c.us` at the server in Cloudflare.
5. Keep the Vercel project up for a day or two as a rollback path.

Apps Script deployment is unchanged and independent — `.gs` files are still
pasted into `script.google.com` and deployed there.

## Notes and gotchas

- **Route order in `server.js` matters.** `/api/drive-upload` is mounted before
  `express.json()` because it parses multipart itself with busboy. Moving it
  below the body parser makes uploads hang. Do not reorder.
- **`trust proxy` is on**, so the per-IP rate limit in `api/voucher.js`
  (30 req/min) sees the real client IP rather than the proxy's.
- **Port 3000** may clash with other apps (Grafana likes it too). n8n's 5678 is
  clear. Change `PORT` in `.env` if needed.
- **`/api/voucher/<action>`** is mounted for compatibility but no frontend code
  calls it; the live path is `POST /api/voucher`.
- **systemd unit is hardened** (`ProtectSystem=strict`, read-only app dir). The
  app writes nothing to disk, so this is safe.
