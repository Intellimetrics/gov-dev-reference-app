#!/usr/bin/env bash
# scripts/rotate-local.sh: the local stand-in for the platform's rotation job.
# New password on the login first, then the secret (with rotatedAt) is replaced.
set -euo pipefail
DIR="${M14_SECRET_DIR:-$HOME/.config/m14-reference}"
NEW="$(openssl rand -base64 33 | tr -d '/+=' | cut -c1-28)Aa1!"
docker exec m14-sql /opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$(cat "$DIR/sa.txt")" \
  -Q "ALTER LOGIN app_user WITH PASSWORD = N'$NEW';"
umask 077
printf '{"user":"app_user","password":"%s","rotatedAt":"%s"}' "$NEW" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/db-app.tmp"
mv "$DIR/db-app.tmp" "$DIR/db-app"
echo "rotated app_user; rotatedAt written into the secret"
