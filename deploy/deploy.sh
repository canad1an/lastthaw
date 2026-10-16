#!/usr/bin/env bash
# Runs ON the Last Thaw server (ubuntu@lastthaw-prod). Pulls the latest main from
# the local bare repo, rebuilds images, applies migrations and restarts services.
set -euo pipefail
cd "$(dirname "$0")/.."

git pull -q --ff-only
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

$COMPOSE --profile app build --quiet
$COMPOSE up -d postgres redis
# Wait for Postgres before migrating.
for i in $(seq 1 30); do
  if $COMPOSE exec -T postgres pg_isready -U lastthaw >/dev/null 2>&1; then break; fi
  sleep 2
done
POSTGRES_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2- | tr -d '"')"
$COMPOSE --profile app run --rm --no-deps -e "DATABASE_URL_DIRECT=postgres://lastthaw:${POSTGRES_PASSWORD}@postgres:5432/lastthaw" api node dist/db/migrate.js
$COMPOSE --profile app up -d --remove-orphans
$COMPOSE --profile app ps
echo "deployed $(git rev-parse --short HEAD) at $(date -u +%FT%TZ)"
