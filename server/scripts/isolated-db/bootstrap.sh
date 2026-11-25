#!/bin/sh
set -eu

: "${SAMOSVAL_ORCHESTRATOR_PASSWORD:?runtime-generated orchestrator password is required}"
: "${SAMOSVAL_TEST_APP_PASSWORD:?runtime-generated test app password is required}"
: "${SAMOSVAL_TEST_RUNTIME_PASSWORD:?runtime-generated runtime password is required}"
: "${SAMOSVAL_TEST_MAINTENANCE_PASSWORD:?runtime-generated maintenance password is required}"

psql --no-psqlrc --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname postgres \
  --set=orchestrator_password="$SAMOSVAL_ORCHESTRATOR_PASSWORD" \
  --set=test_app_password="$SAMOSVAL_TEST_APP_PASSWORD" \
  --set=runtime_password="$SAMOSVAL_TEST_RUNTIME_PASSWORD" \
  --set=maintenance_password="$SAMOSVAL_TEST_MAINTENANCE_PASSWORD" \
  --file /opt/samosval/isolated-db-bootstrap.sql
