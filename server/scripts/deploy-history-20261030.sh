#!/bin/sh
set -eu
umask 077
PATH=/usr/local/bin:/usr/bin:/bin:/var/packages/ContainerManager/target/usr/bin:$PATH
export PATH
ROOT=/volume2/docker/samosval-test
CAND=/volume2/docker/samosval-test-candidate
STAGE=$ROOT/history-deploy
BACK=$ROOT/migration-backups/history-20261030
test ! -e "$BACK"
mkdir "$BACK"
exec > "$BACK/deploy.log" 2>&1
cd "$STAGE"
sha256sum -c SHA256SUMS
grep -q 'image: samosval-test-api:identity-v1-20261030' "$CAND/compose.yaml"
docker inspect --format '{{.Config.Image}} {{.State.Running}}' samosval-test-candidate-api-1
PG=$(docker ps -q --filter label=com.docker.compose.project=samosval-test --filter label=com.docker.compose.service=postgres)
test -n "$PG"
test "$(printf '%s' "$PG" | wc -l)" -eq 0
docker exec "$PG" sh -c 'test "$POSTGRES_DB" = samosval_test'
docker build -t samosval-test-api:history-v1-20261030 "$STAGE"
docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACK/before.dump"
test -s "$BACK/before.dump"
docker exec -i "$PG" pg_restore --list < "$BACK/before.dump" > "$BACK/dump.list"
tar -czf "$BACK/source.tar.gz" -C "$ROOT" src package.json Dockerfile
tar -tzf "$BACK/source.tar.gz" > "$BACK/source.list"
cp "$CAND/compose.yaml" "$BACK/compose.yaml"
sha256sum "$BACK/before.dump" "$BACK/source.tar.gz" "$BACK/compose.yaml" > "$BACK/SHA256SUMS"
COUNTS='SELECT (SELECT count(*)::int FROM app_users) users,(SELECT count(*)::int FROM line_trucks) trucks,(SELECT count(*)::int FROM line_truck_statuses) statuses,(SELECT count(*)::int FROM line_logs) logs,(SELECT count(*)::int FROM tabel_records) tabel,(SELECT count(*)::int FROM workspace_objects) objects'
docker exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "$1"' sh "$COUNTS" > "$BACK/before-counts.txt"
docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < "$STAGE/007_line_history.sql"
if command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose -p samosval-test-candidate -f "$CAND/compose.yaml" "$@"; }
else
  compose() { docker compose -p samosval-test-candidate -f "$CAND/compose.yaml" "$@"; }
fi
rollback() { cp "$BACK/compose.yaml" "$CAND/compose.yaml"; compose up -d --no-deps --no-build api; }
sed 's@image: samosval-test-api:identity-v1-20261030@image: samosval-test-api:history-v1-20261030@' "$BACK/compose.yaml" > "$CAND/compose.yaml"
if ! compose up -d --no-deps --no-build api; then rollback; exit 1; fi
HEALTH='for(let i=0;i<30;i++){try{const r=await fetch("http://127.0.0.1:8080/health/ready",{signal:AbortSignal.timeout(2000)});if(r.status===200){console.log(await r.text());process.exit(0)}}catch{}await new Promise(r=>setTimeout(r,1000))}process.exit(1)'
if ! docker exec samosval-test-candidate-api-1 node --input-type=module -e "$HEALTH"; then rollback; exit 1; fi
docker exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "$1"' sh "$COUNTS" > "$BACK/after-counts.txt"
if ! cmp "$BACK/before-counts.txt" "$BACK/after-counts.txt"; then rollback; exit 1; fi
if ! docker exec samosval-test-candidate-api-1 node --input-type=module -e 'for(const path of ["/api/v1/history","/api/v1/archive/snapshot","/api/v1/session","/api/v1/line/snapshot"]){const r=await fetch("http://127.0.0.1:8080"+path);if(r.status!==401)throw Error(path+" "+r.status);console.log(path,r.status)}'; then rollback; exit 1; fi
echo HISTORY_API_VERIFIED
cat "$BACK/after-counts.txt"
