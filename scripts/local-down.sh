#!/usr/bin/env bash
set -u
docker rm -f m14-sql m14-oidc m14-otel >/dev/null 2>&1 || true
rm -rf "${M14_SECRET_DIR:-$HOME/.config/m14-reference}"
echo "local database removed"
