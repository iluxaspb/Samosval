#!/bin/sh
# One-time, pinned TEST bootstrap through DSM Task Scheduler. No production target.
set -eu
umask 077
PATH=/usr/local/bin:/usr/bin:/bin:/var/packages/ContainerManager/target/usr/bin:$PATH
export PATH
INSTALL=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BASE=/volume2/docker/samosval-test-control
STATE=$BASE/state
CAND=/volume2/docker/samosval-test-candidate/compose.yaml
TAG=samosval-test-api:control-410
mkdir -p "$BASE"
mkdir "$BASE/bootstrap.lock" || { printf 'Another bootstrap is running\n'; exit 1; }
SWITCHED=0
CONTROL_STARTED=0
if command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  compose() { docker compose "$@"; }
fi
rollback() {
  code=$?
  trap - EXIT
  if test "$code" -ne 0 && test "$SWITCHED" -eq 1; then
    printf 'BOOTSTRAP_ROLLBACK_BEGIN\n'
    if test "$CONTROL_STARTED" -eq 1; then compose -p samosval-test-control -f "$INSTALL/compose.control.test.yaml" stop control || true; fi
    cp "$BACK/previous-override.json" "$STATE/api-override.json"
    compose -p samosval-test-candidate -f "$CAND" -f "$STATE/api-override.json" up -d --no-deps --no-build api || printf 'ROLLBACK_REQUIRES_ATTENTION\n'
  fi
  rmdir "$BASE/bootstrap.lock"
  exit "$code"
}
trap rollback EXIT
cd "$INSTALL"
sha256sum -c SHA256SUMS
if test -e "$STATE/installed.json"; then printf 'Control already installed; use app updates\n'; exit 1; fi
API=$(docker ps -q --filter label=com.docker.compose.project=samosval-test-candidate --filter label=com.docker.compose.service=api)
PG=$(docker ps -q --filter label=com.docker.compose.project=samosval-test --filter label=com.docker.compose.service=postgres)
test "$(printf '%s\n' "$API" | wc -w)" -eq 1
test "$(printf '%s\n' "$PG" | wc -w)" -eq 1
docker exec "$PG" sh -c 'test "$POSTGRES_DB" = samosval_test'
OLD=$(docker inspect --format '{{.Image}}' "$API")
printf '%s' "$OLD" | grep -Eq '^sha256:[a-f0-9]{64}$'
OLD_VERSION=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$API" | sed -n 's/^SAMOSVAL_RELEASE=//p')
if ! printf '%s' "$OLD_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$'; then OLD_VERSION=4.0.2; fi
NEEDED=$(docker exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d samosval_test -At -c "SELECT pg_database_size(current_database())"')
FREE=$(df -Pk "$BASE" | awk 'END {print $4}')
test "$((FREE*1024))" -gt "$((NEEDED*2+1073741824))"
STAMP=$(date +%Y%m%d-%H%M%S)
BACK=$STATE/backups/bootstrap_$STAMP
mkdir -p "$BACK" "$STATE/staging"
exec > "$BACK/bootstrap.log" 2>&1
printf 'BOOTSTRAP_TEST_BEGIN\n'
cp "$CAND" "$BACK/compose.yaml"
printf '{"services":{"api":{"image":"%s","environment":{"SAMOSVAL_RELEASE":"%s"}}}}\n' "$OLD" "$OLD_VERSION" > "$BACK/previous-override.json"
# The pre-control API cannot expose the new administration endpoints. Keep its
# image in the bootstrap recovery files, not as an app rollback target.
printf 'null\n' > "$STATE/previous.json"
docker cp "$API:/app/src" "$BACK/old-src"
docker cp "$API:/app/package.json" "$BACK/package.json"
printf 'FROM %s\nCOPY --chown=node:node src /app/src\nENV SAMOSVAL_RELEASE=4.1.0\n' "$OLD" > "$INSTALL/Dockerfile.api"
docker build --network none -f Dockerfile.api -t "$TAG" .
for FILE in src/*.mjs; do docker run --rm --read-only --network none --entrypoint node "$TAG" --check "$FILE"; done
# Docker CLI is present only in the independent worker, never in API containers.
docker build -f updater/Dockerfile --build-arg "API_BASE=$TAG" -t samosval-test-control:4.1.0 .
docker run --rm --network none --entrypoint docker samosval-test-control:4.1.0 compose version
printf 'BOOTSTRAP_IMAGES_VERIFIED\n'
docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d samosval_test -Fc' > "$BACK/database.dump"
test -s "$BACK/database.dump"
docker exec -i "$PG" pg_restore --list < "$BACK/database.dump" > "$BACK/contents.txt"
VERIFY=sc_bootstrap_$STAMP
VERIFY=$(printf '%s' "$VERIFY" | tr -d '-')
docker exec "$PG" sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$VERIFY"
if ! docker exec -i "$PG" sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --exit-on-error --no-owner' sh "$VERIFY" < "$BACK/database.dump"; then
  docker exec "$PG" sh -c 'dropdb -U "$POSTGRES_USER" "$1"' sh "$VERIFY"
  exit 1
fi
docker exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$1" -At -v ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM app_users),(SELECT count(*) FROM line_trucks),(SELECT count(*) FROM line_logs),(SELECT count(*) FROM tabel_records)"' sh "$VERIFY" > "$BACK/restored-counts.txt"
docker exec "$PG" sh -c 'dropdb -U "$POSTGRES_USER" "$1"' sh "$VERIFY"
BYTES=$(wc -c < "$BACK/database.dump" | tr -d ' ')
printf '{"id":"bootstrap_%s","createdAt":%s000,"bytes":%s,"restored":true}\n' "$STAMP" "$(date +%s)" "$BYTES" > "$BACK/verified.json"
sha256sum "$BACK/database.dump" "$BACK/compose.yaml" > "$BACK/SHA256SUMS"
printf 'BOOTSTRAP_BACKUP_RESTORED\n'
docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d samosval_test -v ON_ERROR_STOP=1' < sql/013_server_control.sql
cp baseline.json "$STATE/baseline.json"
NEW=$(docker image inspect --format '{{.Id}}' "$TAG")
printf '{"services":{"api":{"image":"%s","environment":{"SAMOSVAL_RELEASE":"4.1.0"}}}}\n' "$NEW" > "$STATE/api-override.json"
SWITCHED=1
compose -p samosval-test-candidate -f "$CAND" -f "$STATE/api-override.json" up -d --no-deps --no-build api
API=$(docker ps -q --filter label=com.docker.compose.project=samosval-test-candidate --filter label=com.docker.compose.service=api)
docker exec "$API" node --input-type=module -e 'for(let i=0;i<40;i++){try{const r=await fetch("http://127.0.0.1:8080/health/ready",{signal:AbortSignal.timeout(2000)});if(r.status===200)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,1000))}process.exit(1)'
docker exec "$API" node --input-type=module -e 'const r=await fetch("http://127.0.0.1:8080/api/v1/admin/server");if(r.status!==401)process.exit(1)'
compose -p samosval-test-control -f "$INSTALL/compose.control.test.yaml" up -d --no-build control
CONTROL_STARTED=1
docker exec "$API" node --input-type=module -e 'import pg from "pg";const p=new pg.Pool({host:process.env.PGHOST,database:process.env.POSTGRES_DB,user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD});try{for(let i=0;i<30;i++){const r=await p.query("SELECT 1 FROM server_control_state WHERE channel=$1 AND heartbeat>now()-interval '\''30 seconds'\'' AND payload->>'\''protocol'\''='\''1'\''",["test"]);if(r.rowCount)process.exit(0);await new Promise(r=>setTimeout(r,1000))}process.exit(1)}finally{await p.end()}'
printf '{"version":"4.1.0","channel":"test","installedAt":"%s"}\n' "$STAMP" > "$STATE/installed.json"
printf 'BOOTSTRAP_TEST_READY\n'
