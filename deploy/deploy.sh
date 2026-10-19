#!/usr/bin/env bash
# Runs ON the Last Thaw server (ubuntu@lastthaw-prod). Pulls the latest main from
# the local bare repo, rebuilds images, applies migrations and restarts services.
set -euo pipefail
cd "$(dirname "$0")/.."

git pull -q --ff-only
# The version is 1.<commits since early access began>, two digits at least: every commit moves it on by one.
EARLY_ACCESS_BASE=239
export APP_VERSION="1.$(printf '%02d' $(( $(git rev-list --count HEAD) - EARLY_ACCESS_BASE )))"
echo "version $APP_VERSION"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

$COMPOSE --profile app build --quiet
$COMPOSE up -d postgres redis
# Wait for Postgres before migrating.
for i in $(seq 1 30); do
  if $COMPOSE exec -T postgres pg_isready -U lastthaw >/dev/null 2>&1; then break; fi
  sleep 2
done
POSTGRES_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2- | tr -d '"
')"
$COMPOSE --profile app run --rm --no-deps -e "DATABASE_URL_DIRECT=postgres://lastthaw:${POSTGRES_PASSWORD}@postgres:5432/lastthaw" api node dist/db/migrate.js
# Everything but the API is recreated as usual; the API is replaced one replica at a time so Caddy always has a
# live upstream (the "no upstreams available" 503s came from both replicas restarting at once).
# --no-deps: without it compose would also recreate the API (caddy and web depend on it) and take both replicas down at once.
$COMPOSE --profile app up -d --no-deps --remove-orphans $($COMPOSE --profile app config --services | grep -vx api)
for c in $($COMPOSE ps -q api); do
  docker rm -f "$c" >/dev/null
  $COMPOSE --profile app up -d --no-deps --no-recreate --scale 2 api >/dev/null 2>&1 || $COMPOSE --profile app up -d --no-deps --no-recreate --scale api=2 api
  for i in $(seq 1 40); do
    unhealthy=0
    for n in $($COMPOSE ps -q api); do
      [ "$(docker inspect --format '{{.State.Health.Status}}' "$n" 2>/dev/null)" = "healthy" ] || unhealthy=1
    done
    [ "$unhealthy" = 0 ] && break
    sleep 2
  done
done
# The crontab (nightly backup, monthly restore check, Matomo archiving) lives in the repo and is installed whole,
# so a job added by hand on the box does not survive and cannot replace the others.
mkdir -p "$HOME/backups"
if ! crontab -l 2>/dev/null | diff -q - deploy/crontab >/dev/null 2>&1; then
  crontab deploy/crontab && echo "crontab installed from deploy/crontab"
fi
# The Caddyfile is a bind mount: a changed file needs a reload, not a recreate.
$COMPOSE exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
$COMPOSE --profile app ps
echo "deployed $(git rev-parse --short HEAD) at $(date -u +%FT%TZ)"
