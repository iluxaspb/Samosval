#!/bin/sh
set -eu
umask 077
PATH=/usr/local/bin:/usr/bin:/bin:/var/packages/ContainerManager/target/usr/bin:$PATH
export PATH
ROOT=/volume2/docker/samosval-test
CAND=/volume2/docker/samosval-test-candidate
STAGE=$ROOT/transport-402-20261030
BACK=$ROOT/migration-backups/transport-402-20261030
TAG=samosval-test-api:release-402-20261030
BASE=samosval-test-api:release-401-20261030
VERIFY=samosval_verify402_20261030
test ! -e "$STAGE"
test ! -e "$BACK"
mkdir "$STAGE" "$BACK"
exec > "$BACK/deploy.log" 2>&1
printf 'TRANSPORT_402_BEGIN\n'
API=$(docker ps -q --filter label=com.docker.compose.project=samosval-test-candidate --filter label=com.docker.compose.service=api)
PG=$(docker ps -q --filter label=com.docker.compose.project=samosval-test --filter label=com.docker.compose.service=postgres)
test "$(printf '%s\n' "$API" | wc -w)" -eq 1
test "$(printf '%s\n' "$PG" | wc -w)" -eq 1
test "$(docker inspect --format '{{.Config.Image}}' "$API")" = "$BASE"
test "$(docker inspect --format '{{.Image}}' "$API")" = "$(docker image inspect --format '{{.Id}}' "$BASE")"
docker exec "$PG" sh -c 'test "$POSTGRES_DB" = samosval_test'
grep -q 'image: samosval-test-api:release-401-20261030' "$CAND/compose.yaml"
cp "$CAND/compose.yaml" "$BACK/compose.yaml"
docker cp "$API:/app/src" "$BACK/src"
docker cp "$API:/app/package.json" "$BACK/package.json"
(cd "$BACK" && printf '%s\n' '02a08ba43bbac764dc2d7c66feb46d1d7ba5beb37693169cfe7dbe9a983c1c3d  src/index.mjs' | sha256sum -c -)
cp -R "$BACK/src" "$STAGE/src"
for FILE in index.mjs json-response.mjs; do
  curl -fL --connect-timeout 15 --max-time 120 "https://raw.githubusercontent.com/iluxaspb/Samosval/3cf9c6da980732a3396051aa89865277082042ec/server/src/$FILE" -o "$STAGE/src/$FILE"
done
(cd "$STAGE" && printf '%s\n' '132b2e914835a5f9a3193af766e36b0628439ce37800a3cda5e8fe17468602fc  src/index.mjs' 'ca516df3ca33d965f4c138f038cfdbc562ebc9fdddc78707a054eacdb40b70ff  src/json-response.mjs' | sha256sum -c -)
printf 'FROM %s\nCOPY --chown=node:node src /app/src\n' "$BASE" > "$STAGE/Dockerfile"
docker build -t "$TAG" "$STAGE"
docker run --rm --network none --read-only --entrypoint node "$TAG" --check src/index.mjs
docker run --rm --network none --read-only --entrypoint node "$TAG" --check src/json-response.mjs
printf 'TRANSPORT_SOURCE_VERIFIED\n'
docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACK/before.dump"
test -s "$BACK/before.dump"
docker exec -i "$PG" pg_restore --list < "$BACK/before.dump" > "$BACK/dump.list"
docker exec "$PG" sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$VERIFY"
cleanup_verify() { docker exec "$PG" sh -c 'dropdb -U "$POSTGRES_USER" "$1"' sh "$VERIFY"; }
if ! docker exec -i "$PG" sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --exit-on-error --no-owner' sh "$VERIFY" < "$BACK/before.dump"; then cleanup_verify; exit 1; fi
docker exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$1" -At -v ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM app_users),(SELECT count(*) FROM line_trucks),(SELECT count(*) FROM line_logs),(SELECT count(*) FROM tabel_records)"' sh "$VERIFY" > "$BACK/restored-counts.txt"
cleanup_verify
sha256sum "$BACK/before.dump" "$BACK/compose.yaml" > "$BACK/SHA256SUMS"
printf 'DATABASE_BACKUP_RESTORE_VERIFIED\n'
if command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose -p samosval-test-candidate -f "$CAND/compose.yaml" "$@"; }
else
  compose() { docker compose -p samosval-test-candidate -f "$CAND/compose.yaml" "$@"; }
fi
rollback() {
  printf 'ROLLBACK_401_BEGIN\n'
  cp "$BACK/compose.yaml" "$CAND/compose.yaml"
  compose up -d --no-deps --no-build api
}
sed 's@image: samosval-test-api:release-401-20261030@image: samosval-test-api:release-402-20261030@' "$BACK/compose.yaml" > "$STAGE/compose-402.yaml"
cp "$STAGE/compose-402.yaml" "$CAND/compose.yaml"
if ! compose up -d --no-deps --no-build api; then rollback; exit 1; fi
API=$(docker ps -q --filter label=com.docker.compose.project=samosval-test-candidate --filter label=com.docker.compose.service=api)
if ! test "$(printf '%s\n' "$API" | wc -w)" -eq 1; then rollback; exit 1; fi
CHECK='for(let i=0;i<30;i++){try{const r=await fetch("http://127.0.0.1:8080/health/ready",{signal:AbortSignal.timeout(2000)});if(r.status===200){const b=await r.json();console.log("READINESS",JSON.stringify(b));process.exit(0)}}catch{}await new Promise(r=>setTimeout(r,1000))}process.exit(1)'
if ! docker exec "$API" node --input-type=module -e "$CHECK"; then rollback; exit 1; fi
if ! docker exec "$API" node --input-type=module -e 'for(const path of ["session","games","auxiliary","archive/snapshot","line/snapshot","settings","history","backups","notifications"]){const r=await fetch("http://127.0.0.1:8080/api/v1/"+path);if(r.status!==401||r.headers.get("etag"))throw Error(path+" access "+r.status);console.log("AUTH_REQUIRED",path,r.status)}const r=await fetch("http://127.0.0.1:8080/api/v1/session",{method:"OPTIONS",headers:{Origin:"https://iluxaspb.github.io","Access-Control-Request-Method":"GET","Access-Control-Request-Headers":"authorization,if-none-match"}});if(![200,204].includes(r.status)||!r.headers.get("access-control-allow-headers")?.includes("If-None-Match")||!r.headers.get("access-control-expose-headers")?.includes("ETag"))throw Error("CORS failed");console.log("CORS_ETAG_VERIFIED",r.status)'; then rollback; exit 1; fi
docker exec "$API" sha256sum /app/src/index.mjs /app/src/json-response.mjs
printf 'TRANSPORT_402_API_DEPLOYED\n'
