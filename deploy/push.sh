#!/usr/bin/env bash
# Runs on your machine: push main to the server's bare repo and deploy there.
# Requires the `prod` git remote (ubuntu@<static ip>:lastthaw.git) and the
# lastthaw-aws SSH key. See deploy/lightsail.md.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${LASTTHAW_HOST:-ubuntu@44.221.111.218}"
KEY="${LASTTHAW_KEY:-$HOME/.ssh/lastthaw-aws}"

GIT_SSH_COMMAND="ssh -i $KEY -o BatchMode=yes" git push prod main
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash ~/lastthaw/deploy/deploy.sh'
