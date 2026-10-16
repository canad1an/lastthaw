# Deploying Last Thaw to AWS Lightsail

Last Thaw runs on its **own, dedicated Lightsail instance**. It never shares the
instance, database or Caddy config used by boatbuildlog.com.

## What exists (created 2026-10-13)

| Thing | Value |
|---|---|
| Instance | `lastthaw-prod`, Ubuntu 24.04, 4 GB / 2 vCPU (`medium_3_0`, $24/mo), us-east-1a |
| Static IP | `lastthaw-ip` = **44.221.111.218** |
| Firewall | TCP 22, 80, 443 |
| SSH | `ssh -i ~/.ssh/lastthaw-aws ubuntu@44.221.111.218` (Lightsail key pair `lastthaw-aws`) |
| DNS | Route 53 zone for lastthaw.com: `A @` and `A www` → 44.221.111.218; SES DKIM/SPF/DMARC records |
| Email | Postmark server `Last Thaw` (ID 21125344), sender domain `lastthaw.com` with DKIM (`20261016143914pm._domainkey`) and Return-Path (`pm-bounces` CNAME) verified; the server API token is `SMTP_USER` and `SMTP_PASS` in the box's `.env`, host `smtp.postmarkapp.com:587`. SES identity still exists but is unused. |
| Code on the box | bare repo `~/lastthaw.git`, working checkout `~/lastthaw`, env file `~/lastthaw/.env` |

Mail moved from SES to Postmark on 2026-10-16 because SES was still in the sandbox and rejected unverified recipients. Postmark's free tier is 100 messages a month, shared with boatbuildlog.com's server on the same account.

## Deploy a new version

From your machine, with the `prod` git remote (`ubuntu@44.221.111.218:lastthaw.git`):

```bash
bash deploy/push.sh
```

That pushes `main` to the server and runs `deploy/deploy.sh` there, which pulls, builds the
images, applies migrations and restarts `api`, `worker`, `web` and `caddy`. Caddy obtains the
TLS certificate for lastthaw.com automatically.

## Processes

`api` (two replicas, round-robin via Caddy), `worker` (timers, ticks, scheduler), `ai` (AI tribes' decisions on their own
cadence), `pgbouncer` (transaction pooling in front of Postgres; apps connect through it, migrations go direct), `postgres`,
`redis`, `web` (static build), `caddy` (TLS + routing). Scale the API with `--scale api=3` or by editing `replicas`.

## Useful commands on the server

```bash
cd ~/lastthaw
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f api worker
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres psql -U lastthaw lastthaw
```

Make yourself an admin (fair-play review page at /admin):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres psql -U lastthaw lastthaw -c "update users set is_admin = true where email = 'you@example.com'"
```

## Backups

`deploy/backup.sh` runs nightly from cron on the server: `pg_dump`, gzip, AES-256 encryption with the key in
`~/.backup.key`, upload to the private S3 bucket named by `BACKUP_BUCKET` in `.env` (objects expire after 30 days).
`deploy/restore-check.sh` runs monthly: it pulls the newest backup, restores it into a scratch database and fails loudly
if it looks empty. Cron lines on the server:

```
15 3 * * *  cd ~/lastthaw && bash deploy/backup.sh >> ~/backups/backup.log 2>&1
0 4 1 * *   cd ~/lastthaw && bash deploy/restore-check.sh >> ~/backups/backup.log 2>&1
```

Keep a copy of `~/.backup.key` off the server (Matt has one in `~/.ssh/lastthaw-backup.key`). The upload uses the
`lastthaw-backup` IAM user, which can only write to that bucket.

## Secrets and firewall

`.env` on the server holds `POSTGRES_PASSWORD` and `REDIS_PASSWORD` (random); the compose files read them for Postgres,
PgBouncer, Redis and every service URL. Rotate with `openssl rand -hex 24`, `alter user lastthaw password '...'` in
Postgres, then `bash deploy/deploy.sh`. SSH (port 22) is open only to Matt's address in the Lightsail firewall; change it
with `aws lightsail put-instance-public-ports`. The API container runs as the unprivileged `node` user.

## Rebuilding from scratch

The instance, static IP, firewall, DNS and SES setup were created with small Node scripts using the
AWS SDK (default profile in `~/.aws`). Doing it by hand: create an Ubuntu 24.04 instance named
`lastthaw-prod`, attach a static IP, open 22/80/443, point the A records at it, install Docker
(`curl -fsSL https://get.docker.com | sudo sh`), create `~/lastthaw.git` as a bare repo, clone it to
`~/lastthaw`, copy `.env.example` to `.env` with production values, then run `bash deploy/deploy.sh`.
