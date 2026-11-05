#!/usr/bin/env bash
# scripts/local-up.sh: the local database for lesson 08. Generates every password;
# none is typed, echoed or written inside the repository.
set -euo pipefail
DIR="${M14_SECRET_DIR:-$HOME/.config/m14-reference}"
PORT="${M14_SQL_PORT:-14330}"
NAME=m14-sql
mkdir -p "$DIR" && chmod 700 "$DIR"
gen() { printf '%sAa1!' "$(openssl rand -base64 33 | tr -d '/+=\n' | cut -c1-28)"; }   # meets SQL Server complexity rules
SA="$(gen)"; APP="$(gen)"
umask 077
printf '%s' "$SA" > "$DIR/sa.txt"
docker run -d --name "$NAME" -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD="$SA" -p "127.0.0.1:$PORT:1433" \
  mcr.microsoft.com/mssql/server:2022-latest >/dev/null
sq() { docker exec "$NAME" /opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$(cat "$DIR/sa.txt")" -Q "$1"; }
for i in $(seq 1 60); do sq "SELECT 1" >/dev/null 2>&1 && break; sleep 2; done
sq "CREATE DATABASE intake;"
sq "CREATE LOGIN app_user WITH PASSWORD = N'$APP', CHECK_POLICY = ON;"
sq "USE intake; CREATE USER app_user FOR LOGIN app_user; ALTER ROLE db_datareader ADD MEMBER app_user; ALTER ROLE db_datawriter ADD MEMBER app_user;"
# Local identity provider of record (lesson 03): issues ID tokens with a roles claim, no login page.
docker run -d --name m14-oidc -p 127.0.0.1:8080:8080 -e JSON_CONFIG="$(cat "$(dirname "$0")/oidc-config.json")" \
  ghcr.io/navikt/mock-oauth2-server:3.0.1 >/dev/null
# Local OpenTelemetry collector (lesson 16): prints what the app sends; see `docker logs m14-otel`.
docker run -d --name m14-otel -p 127.0.0.1:4318:4318 -v "$(cd "$(dirname "$0")" && pwd)/otel-collector.yaml:/etc/otelcol/config.yaml:ro" \
  otel/opentelemetry-collector:0.140.0 >/dev/null
printf '{"clientSecret":"%s"}' "$(gen)" > "$DIR/oidc-client.json"   # the mock accepts any secret; a real IdP issues it
printf '{"user":"app_user","password":"%s","rotatedAt":"%s"}' "$APP" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/db-app.json"
echo "local database ready on 127.0.0.1:$PORT; credential in $DIR/db-app.json (outside the repo)"
