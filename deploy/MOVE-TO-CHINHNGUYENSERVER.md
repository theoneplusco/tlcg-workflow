# Move wf.tl-c.us from the Mac Mini to chinhnguyenserver

The user decided on 2026-10-10 to move the Postgres system **wf.tl-c.us** from the Mac Mini "theoneplus" to the Ubuntu server **chinhnguyenserver** (192.168.1.223). It goes next to the old workflow.tl-c.us app, which stays untouched until it is retired.

Run **one command at a time** and check its output before the next (rule #1). Where each command runs:

- **[Mini]**: Terminal on the Mac Mini, `theoneplus_server@theoneplus-server`.
- **[Server]**: chinhnguyenserver, `chinhnguyen@chinhnguyenserver`.
- **[MacBook]**: your MacBook. It can reach both machines; the Mini cannot reach 192.168.1.223 directly.

## Facts checked on 2026-10-10

| | Mac Mini (now) | chinhnguyenserver (target) |
|---|---|---|
| PostgreSQL | 16.15 (Homebrew), DB `tlcg_workflow`, 57 MB | 16, no app databases yet |
| Node | (PM2, 8 workers) | v20.20.2 |
| Redis | yes | **not installed** |
| Free | | 4.9 GB RAM, 134 GB disk; ports 3002 and 6379 free |
| Tunnel | wf.tl-c.us → the Mini | `5b606ef2-3c7c-415a-8bbf-e0242476ab03`: n8n 5678, crm 3000, post 3100, workflow.tl-c.us 3001, ssh 22, tl-c.us 8080 |

Backups on the Mini: `~/tlcg_workflow-20261009-{2247,2258,2331}.dump` (14 MB each). The 23:31 file lists all 21 tables.

## Layout on chinhnguyenserver

| What | Value |
|---|---|
| Code | `/opt/tlcg-wf`, a git clone of branch `claude/gallant-heisenberg-mw8o7c` |
| Service | systemd `tlcg-wf` (`deploy/tlcg-wf.service`), one process |
| Port | `127.0.0.1:3002` |
| Database | `tlcg_workflow`, owned by OS user `chinhnguyen`. Login is by Unix socket ("peer"), so there is no database password. `DATABASE_URL=postgresql:///tlcg_workflow?host=/var/run/postgresql` |
| Redis | Ubuntu `redis-server`, localhost only, `REDIS_URL=redis://127.0.0.1:6379/0` |
| Settings | `/opt/tlcg-wf/.env` (mode 600), copied from the Mini's `.env`; only the lines above plus `PORT`/`HOST` change |
| Not moved | R2 attachments (cloud) and Redis contents (short-lived codes and locks) |

---

## Phase A: rehearsal (the Mini stays live; staff notice nothing)

During the rehearsal the server copy must **not send emails or write to the Google Sheet**: both copies would act on the same queue and Sheet. So A7 turns those off in the server's `.env`.

1. **[MacBook]** Copy the backup Mini → server (it passes through the MacBook):
   `scp -3 <mini-login>:~/tlcg_workflow-20261009-2331.dump chinhnguyen@192.168.1.223:~/`
2. **[Server]** Install Redis: `sudo apt-get update && sudo apt-get install -y redis-server`
3. **[Server]** Check it: `redis-cli ping` → `PONG`. Ubuntu binds it to 127.0.0.1 only.
4. **[Server]** Database login for the app user: `sudo -u postgres createuser chinhnguyen`
5. **[Server]** The database: `sudo -u postgres createdb -O chinhnguyen tlcg_workflow`
6. **[Server]** Restore: `pg_restore --no-owner -d tlcg_workflow ~/tlcg_workflow-20261009-2331.dump`, then check `psql -d tlcg_workflow -Atc "select count(*) from vouchers"`.
7. **Code and settings:**
   - **[Server]** `sudo mkdir -p /opt/tlcg-wf && sudo chown chinhnguyen: /opt/tlcg-wf`
   - **[Server]** `git clone -b claude/gallant-heisenberg-mw8o7c https://github.com/theoneplusco/tlcg-workflow.git /opt/tlcg-wf`
   - **[Server]** `cd /opt/tlcg-wf && npm ci --omit=dev`
   - **[MacBook]** Copy the Mini's settings (secrets never shown on screen): `scp -3 <mini-login>:~/tlcg-workflow/.env chinhnguyen@192.168.1.223:/opt/tlcg-wf/.env`
   - **[Server]** `chmod 600 /opt/tlcg-wf/.env`
   - **[Server]** Change only these lines (by `sed`, without printing secrets):
     - `PORT=3002`
     - `HOST=127.0.0.1`
     - `DATABASE_URL=postgresql:///tlcg_workflow?host=/var/run/postgresql`
     - `REDIS_URL=redis://127.0.0.1:6379/0`
     - **rehearsal only:** comment out `RESEND_API_KEY` and set `SHEETS_MIRROR=off`
   - If `.env` names a `SHEETS_MIRROR_KEY_FILE`, copy that file too and fix its path.
8. **[Server]** Install and start the service:
   - `sudo cp /opt/tlcg-wf/deploy/tlcg-wf.service /etc/systemd/system/`
   - `sudo systemctl daemon-reload && sudo systemctl enable --now tlcg-wf`
9. **Test:**
   - **[Server]** `curl -s localhost:3002/api/health`
   - **[Server]** `journalctl -u tlcg-wf -n 30 --no-pager`
   - **[MacBook]** Browse via a tunnel to the server: `ssh -L 3002:localhost:3002 chinhnguyen@192.168.1.223`, then open http://localhost:3002. Log in, open a voucher, the cash book, a purchase request.

## Phase B: switch wf.tl-c.us (about 15 minutes, outside office hours)

1. **[Mini]** Stop the app: `pm2 stop tlcg-workflow`. The config is kept, for rollback.
2. **[Mini]** Final backup: `pg_dump -Fc -d tlcg_workflow -f ~/tlcg_workflow-final.dump`
3. **[MacBook]** `scp -3 <mini-login>:~/tlcg_workflow-final.dump chinhnguyen@192.168.1.223:~/`
4. **[Server]** `sudo systemctl stop tlcg-wf`, then:
   - `dropdb tlcg_workflow && sudo -u postgres createdb -O chinhnguyen tlcg_workflow`
   - `pg_restore --no-owner -d tlcg_workflow ~/tlcg_workflow-final.dump`
5. **[Server]** In `.env`, turn email and the Sheet copy back on, as on the Mini (`RESEND_API_KEY`, `SHEETS_MIRROR`). Then `sudo systemctl start tlcg-wf`.
6. **[Server]** Tunnel:
   - Back up: `sudo cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak-$(date +%Y%m%d-%H%M)`
   - Add, above the final `- service: http_status:404` line:
     ```
       - hostname: wf.tl-c.us
         service: http://localhost:3002
     ```
   - Validate: `cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate`
   - Move the DNS record to this tunnel: `cloudflared tunnel route dns --overwrite-dns 5b606ef2-3c7c-415a-8bbf-e0242476ab03 wf.tl-c.us`
   - Restart: `sudo systemctl restart cloudflared` (a few seconds' blip on all hostnames).
7. **Test** https://wf.tl-c.us: `/api/health`, log in, a voucher, an approval, an email arriving.

**Rollback (first hours):**
- On the Mini, `pm2 start tlcg-workflow`, and point the DNS back to the Mini's tunnel (`cloudflared tunnel route dns --overwrite-dns <mini tunnel> wf.tl-c.us`).
- Anything entered on the server after the switch would need a dump back to the Mini.

## Phase C: afterwards

- Keep the Mini stopped (not deleted) for a week. Then `pm2 delete tlcg-workflow && pm2 save`, and remove wf.tl-c.us from the Mini's tunnel config.
- Add a nightly `pg_dump` on the server, with a copy off the machine.
- Retire workflow.tl-c.us (see `docs/SESSION_LOG.md`, 2026-10-10 night):
  - Cloudflare redirect to wf.tl-c.us.
  - Apps Script `APP_BASE_URL`.
  - `sudo systemctl disable --now tlcg-workflow`.
  - Remove its ingress rule.
