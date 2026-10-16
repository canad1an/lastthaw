#!/usr/bin/env bash
# Runs ON the server, monthly from cron or by hand: fetches the newest backup from the
# bucket, decrypts it, restores it into a scratch database and checks it has what a
# real database has. A backup nobody has restored is a hope, not a backup.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
BUCKET="${BACKUP_BUCKET:?set BACKUP_BUCKET in .env}"
KEY="$HOME/.backup.key"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
LATEST="$(aws s3 ls "s3://$BUCKET/" | awk '{print $4}' | sort | tail -1)"
[ -n "$LATEST" ] || { echo "no backups in the bucket"; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; $COMPOSE exec -T postgres psql -U lastthaw -d postgres -c "drop database if exists lastthaw_restore" >/dev/null 2>&1 || true' EXIT
aws s3 cp --only-show-errors "s3://$BUCKET/$LATEST" "$TMP/dump.enc"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$KEY" -in "$TMP/dump.enc" | gunzip > "$TMP/dump.sql"
$COMPOSE exec -T postgres psql -U lastthaw -d postgres -c "drop database if exists lastthaw_restore" >/dev/null
$COMPOSE exec -T postgres psql -U lastthaw -d postgres -c "create database lastthaw_restore" >/dev/null
$COMPOSE exec -T postgres psql -U lastthaw -d lastthaw_restore -q < "$TMP/dump.sql" >/dev/null
USERS="$($COMPOSE exec -T postgres psql -U lastthaw -d lastthaw_restore -tAc "select count(*) from users")"
MATCHES="$($COMPOSE exec -T postgres psql -U lastthaw -d lastthaw_restore -tAc "select count(*) from matches")"
[ "$USERS" -ge 1 ] && [ "$MATCHES" -ge 1 ] || { echo "restore of $LATEST looks empty: users=$USERS matches=$MATCHES"; exit 1; }
echo "restore drill ok: $LATEST users=$USERS matches=$MATCHES"
