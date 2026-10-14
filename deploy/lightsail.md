# Deploying Last Thaw to AWS Lightsail

Last Thaw runs on its **own, new Lightsail instance**. It must never share the
instance, database or Caddy config used by boatbuildlog.com.

## 1. Create the instance

1. Lightsail console → Create instance → Linux/Unix → OS only → **Ubuntu 24.04 LTS**.
2. Plan: 4 GB RAM / 2 vCPU is enough for the friends test and early launch. Upgrade the plan later if needed.
3. Name it `lastthaw-prod`. Create it.
4. Networking → attach a **static IP** and name it `lastthaw-ip`.
5. Firewall: allow TCP 22 (restrict to your IP), 80 and 443. Nothing else.

## 2. DNS

At the registrar for lastthaw.com (or a Lightsail DNS zone), add:

| Type | Name | Value |
|---|---|---|
| A | `@` | the static IP |
| A | `www` | the static IP |

Caddy issues the TLS certificate automatically once DNS resolves.

## 3. Install Docker on the box

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
```

Log out and back in so the group change applies.

## 4. First deploy

```bash
git clone https://github.com/canad1an/lastthaw.git ~/lastthaw
cd ~/lastthaw
cp .env.example .env
```

Edit `.env`: set a real `SESSION_SECRET` (`openssl rand -hex 32`), `NODE_ENV=production`,
`DEV_TOOLS=false`, `PUBLIC_URL=https://lastthaw.com`, and the SES SMTP settings
(`SMTP_HOST=email-smtp.<region>.amazonaws.com`, port 587, SMTP user and password from
an SES SMTP credential, `MAIL_FROM` on a verified SES domain).

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm api node dist/db/migrate.js
```

## 5. Updates

```bash
cd ~/lastthaw && git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm api node dist/db/migrate.js
```

## 6. Backups

Nightly Postgres dump to a Lightsail bucket (set up in milestone 7):

```bash
docker compose exec -T postgres pg_dump -U lastthaw lastthaw | gzip > /tmp/lastthaw-$(date +%F).sql.gz
```

## 7. SES

Verify the `lastthaw.com` domain in SES (same region as the instance), request production
access (out of the sandbox), and create SMTP credentials. Verification and password reset mail
are the only emails version 1 sends.
