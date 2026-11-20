#!/bin/bash
set -euo pipefail
# Run ONLY via sudo -n unshare -n: no host services or host DB used.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BASE=$(dirname "$ROOT")/qa-phone
if [ "$(id -u)" = 0 ]; then
 ip link set lo up
 test -z "$(ip route show)"
 exec setpriv --reuid=iluxa --regid=iluxa --init-groups env HOME=/home/iluxa PHONE_QA_NAMESPACE=1 bash "$0"
fi
[ "${PHONE_QA_NAMESPACE:-}" = 1 ] || { printf 'Run via sudo -n unshare -n bash tools/phone-qa.sh\n'; exit 1; }
[ -z "$(ip route show)" ] || exit 1
mkdir -p "$BASE/socket"
export PATH=/home/iluxa/.hermes/tools/node-26.12.1-linux-x64/bin:/usr/lib/postgresql/16/bin:$PATH
if [ ! -s "$BASE/data/PG_VERSION" ]; then initdb -D "$BASE/data" -A trust --no-locale > "$BASE/init.log"; fi
pg_ctl -D "$BASE/data" -l "$BASE/postgres.log" -o "-k $BASE/socket -h ''" start
trap 'pg_ctl -D "$BASE/data" -m fast stop' EXIT
createdb -h "$BASE/socket" samosval_test 2>/dev/null || true
for f in "$ROOT"/server/sql/*.sql; do
 if [[ "$f" = */018_auth_credentials.sql ]]; then
  # Only the isolated fixture copy changes its DB-name guard; source stays intact.
  python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text().replace("samosval_working_test_reserve","samosval_test"))' "$f" > "$BASE/auth-fixture.sql"
  f="$BASE/auth-fixture.sql"
 fi
 psql -h "$BASE/socket" -d samosval_test -v ON_ERROR_STOP=1 -f "$f" > "$BASE/migrate.log" 2>&1 || { cat "$BASE/migrate.log"; exit 1; }
done
export TEST_DATABASE_URL="postgresql:///samosval_test?host=$BASE/socket&user=iluxa"
cd "$ROOT"
if [ "${PHONE_QA_MODE:-tests}" = api ]; then
 export PGHOST="$BASE/socket" POSTGRES_DB=samosval_test POSTGRES_USER=iluxa POSTGRES_PASSWORD=synthetic-only FIREBASE_PROJECT_ID=synthetic-phone-qa WORKSPACE_ID=main_workspace PORT=18099 ALLOWED_ORIGINS=http://127.0.0.1:18099
 node server/src/index.mjs
else
 node --test --test-concurrency=1 server/tests/*.test.mjs > "$BASE/tests.log" 2>&1
fi
