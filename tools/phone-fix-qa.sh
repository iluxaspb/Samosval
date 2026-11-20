#!/bin/bash
set -euo pipefail
# Run ONLY via sudo -n unshare -n: no host services or host DB used.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BASE=$(dirname "$ROOT")/qa-fix-${PHONE_QA_LABEL:-candidate}
[[ "${PHONE_QA_LABEL:-candidate}" =~ ^[A-Za-z0-9_-]+$ ]] || exit 1
if [ "$(id -u)" = 0 ]; then
 [ "$(readlink /proc/self/ns/net)" != "$(readlink /proc/1/ns/net)" ] || { printf 'A new netns is required\n'; exit 1; }
 ip link set lo up
 test -z "$(ip route show)"
 exec setpriv --reuid=iluxa --regid=iluxa --init-groups env HOME=/home/iluxa PHONE_QA_NAMESPACE=1 bash "$0"
fi
[ "${PHONE_QA_NAMESPACE:-}" = 1 ] || { printf 'Run via sudo -n unshare -n bash tools/phone-qa.sh\n'; exit 1; }
[ "$(readlink /proc/self/ns/net)" != "$(readlink /proc/1/ns/net)" ] || exit 1
[ -z "$(ip route show)" ] && [ -z "$(ip -6 route show)" ] || exit 1
mkdir -p "$BASE/socket"
export PATH=/home/iluxa/.hermes/tools/node-26.12.1-linux-x64/bin:/usr/lib/postgresql/16/bin:$PATH
if [ ! -s "$BASE/data/PG_VERSION" ]; then initdb -D "$BASE/data" -A trust --no-locale > "$BASE/init.log"; fi
pg_ctl -D "$BASE/data" -l "$BASE/postgres.log" -o "-k $BASE/socket -h ''" start
trap 'pg_ctl -D "$BASE/data" -m fast stop' EXIT
createdb -h "$BASE/socket" samosval_test 2>/dev/null || true
python3 "$ROOT/tools/phone-qa-fixture.py" "$BASE"
for f in "$BASE"/migrations/*.sql; do
 psql -h "$BASE/socket" -d samosval_test -v ON_ERROR_STOP=1 -f "$f" > "$BASE/migrate.log" 2>&1 || { cat "$BASE/migrate.log"; exit 1; }
done
export TEST_DATABASE_URL="postgresql:///samosval_test?host=$BASE/socket&user=iluxa"
export PGHOST="$BASE/socket" POSTGRES_DB=samosval_test POSTGRES_USER=iluxa POSTGRES_PASSWORD=synthetic-only
cd "$ROOT"
if [ "${PHONE_QA_MODE:-tests}" = api ]; then
 export PGHOST="$BASE/socket" POSTGRES_DB=samosval_test POSTGRES_USER=iluxa POSTGRES_PASSWORD=synthetic-only FIREBASE_PROJECT_ID=synthetic-phone-qa WORKSPACE_ID=main_workspace PORT=18099 ALLOWED_ORIGINS=http://127.0.0.1:18099
 node server/src/index.mjs
elif [ "${PHONE_QA_MODE:-tests}" = focused ]; then
 node --test --test-concurrency=1 server/tests/truck-phone*.test.mjs server/tests/backup-store.test.mjs server/tests/line-*.test.mjs > "$BASE/focused.log" 2>&1
else
 node --test --test-concurrency=1 server/tests/*.test.mjs > "$BASE/tests.log" 2>&1
fi
