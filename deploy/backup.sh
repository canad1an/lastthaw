#!/usr/bin/env bash
# Runs ON the server from cron. Dumps the database, encrypts it with the key in
# ~/.backup.key (keep a copy of that key somewhere else: without it the backups are noise),
# and uploads it to the backups bucket. Keeps the last 7 days locally as well.
set -euo pipefail
cd "$(dirname "$0")/.."
BUCKET="$(grep -E '^BACKUP_BUCKET=' .env | cut -d= -f2- | tr -d '"')"
[ -n "$BUCKET" ] || { echo "set BACKUP_BUCKET in .env"; exit 1; }
KEY="$HOME/.backup.key"
[ -s "$KEY" ] || { echo "missing $KEY"; exit 1; }
mkdir -p "$HOME/backups"
STAMP="$(date -u +%F-%H%M)"
OUT="$HOME/backups/lastthaw-$STAMP.sql.gz.enc"
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres pg_dump -U lastthaw lastthaw \
  | gzip \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$KEY" -out "$OUT"
aws s3 cp --only-show-errors "$OUT" "s3://$BUCKET/$(basename "$OUT")"
find "$HOME/backups" -name 'lastthaw-*.enc' -mtime +7 -delete
echo "backup $(basename "$OUT") $(stat -c %s "$OUT") bytes uploaded"
