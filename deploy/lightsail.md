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
| Email | SES domain identity `lastthaw.com` (verified, DKIM ok), custom MAIL FROM `mail.lastthaw.com`, IAM user `lastthaw-smtp` with SMTP credentials in the server's `.env` |
| Code on the box | bare repo `~/lastthaw.git`, working checkout `~/lastthaw`, env file `~/lastthaw/.env` |

SES is still in the **sandbox**: it only delivers to verified addresses (mattadam07@gmail.com is verified).
Request production access in the SES console (Account dashboard → Request production access) before
inviting friends, or their verification emails will not arrive.

## Deploy a new version

From your machine, with the `prod` git remote (`ubuntu@44.221.111.218:lastthaw.git`):

```bash
bash deploy/push.sh
```

That pushes `main` to the server and runs `deploy/deploy.sh` there, which pulls, builds the
images, applies migrations and restarts `api`, `worker`, `web` and `caddy`. Caddy obtains the
TLS certificate for lastthaw.com automatically.

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

Nightly dump to the home directory (add to `crontab -e` on the server):

```
15 3 * * * cd ~/lastthaw && docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres pg_dump -U lastthaw lastthaw | gzip > ~/backups/lastthaw-$(date +\%F).sql.gz
```

Create `~/backups` first. Copy the dumps to a Lightsail bucket or S3 when you want off-box copies.

## Rebuilding from scratch

The instance, static IP, firewall, DNS and SES setup were created with small Node scripts using the
AWS SDK (default profile in `~/.aws`). Doing it by hand: create an Ubuntu 24.04 instance named
`lastthaw-prod`, attach a static IP, open 22/80/443, point the A records at it, install Docker
(`curl -fsSL https://get.docker.com | sudo sh`), create `~/lastthaw.git` as a bare repo, clone it to
`~/lastthaw`, copy `.env.example` to `.env` with production values, then run `bash deploy/deploy.sh`.
