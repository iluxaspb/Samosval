#!/bin/bash
set -euo pipefail
# Functional execution requires independent review of the exact clean commit.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ "${PHONE_REVIEWED_COMMIT:-}" = "$(git -C "$ROOT" rev-parse HEAD)" ] || { printf 'Set PHONE_REVIEWED_COMMIT only after positive independent review\n'; exit 1; }
[ -z "$(git -C "$ROOT" status --porcelain)" ] || exit 1
# Only scripts shipped in this repository may be seeded or run: an env value is
# a name of a reviewed tool, never a path to arbitrary code.
resolve_tool() {
 case "$1" in
  /*|*..*) printf 'BLOCKED: tool must be a repository-relative path: %s\n' "$1"; exit 1;;
 esac
 local file="$ROOT/$1"
 [ -f "$file" ] || { printf 'BLOCKED: missing tool: %s\n' "$1"; exit 1; }
 printf '%s' "$file"
}
SEED_NAME=${PHONE_SEED:-tools/phone-browser-seed.mjs}
SCENARIO_NAME=${PHONE_SCENARIO:-tools/phone-stand-896.mjs}
SEED=$(resolve_tool "$SEED_NAME")
SCENARIO=$(resolve_tool "$SCENARIO_NAME")
if [ "$(id -u)" != 0 ] && [ "${PHONE_BROWSER_NS:-}" != 1 ]; then
 export PHONE_HOST_NS=$(readlink /proc/self/ns/net)
 exec sudo -n --preserve-env=PHONE_HOST_NS,PHONE_REVIEWED_COMMIT,PHONE_SEED,PHONE_SCENARIO,PHONE_CHROMIUM unshare -n bash "$0"
fi
[[ "${PHONE_HOST_NS:-}" =~ ^net:\[[0-9]+\]$ ]] || exit 1
[ "$(readlink /proc/self/ns/net)" != "$PHONE_HOST_NS" ] || exit 1
if [ "$(id -u)" = 0 ]; then
 ip link set lo up
 exec setpriv --reuid=iluxa --regid=iluxa --init-groups env HOME=/home/iluxa PHONE_BROWSER_NS=1 \
  PHONE_SEED="$SEED_NAME" PHONE_SCENARIO="$SCENARIO_NAME" PHONE_CHROMIUM="${PHONE_CHROMIUM:-}" bash "$0"
fi
[ "$(readlink /proc/self/ns/net)" != "$PHONE_HOST_NS" ] || exit 1
[ -z "$(ip route show)" ] && [ -z "$(ip -6 route show)" ] || exit 1
available=$(df -Pk "$ROOT" | python3 -c 'import sys; print(sys.stdin.readlines()[-1].split()[3])')
[ "$available" -ge 225280 ] || { printf 'BLOCKED: need 220 MiB free before isolated browser run, have %s KiB\n' "$available"; exit 1; }
BASE=$(mktemp -d "$(dirname "$ROOT")/browser-fix.XXXXXX")
printf 'Artifacts: %s\n' "$BASE"
printf 'host=%s isolated=%s\n' "$PHONE_HOST_NS" "$(readlink /proc/self/ns/net)" > "$BASE/isolation.log"
ip addr show >> "$BASE/isolation.log"
ip route show >> "$BASE/isolation.log"
ip -6 route show >> "$BASE/isolation.log"
export PATH=/home/iluxa/.hermes/tools/node-26.12.1-linux-x64/bin:/usr/lib/postgresql/16/bin:$PATH
mkdir "$BASE/socket"
initdb -D "$BASE/data" -A trust --no-locale > "$BASE/init.log"
pg_ctl -D "$BASE/data" -l "$BASE/pg.log" -o "-k $BASE/socket -h ''" start
api= proxy=
trap 'kill ${api:-} ${proxy:-} 2>/dev/null || true; wait ${api:-} ${proxy:-} 2>/dev/null || true; pg_ctl -D "$BASE/data" -m fast stop' EXIT
createdb -h "$BASE/socket" samosval_test
# Migrations 025+ require the evidence-owner role to exist before they run. The
# phone stand owns its throwaway cluster, so the role is created here instead of
# borrowing the production bootstrap (no LOGIN, no password, no grants).
psql -h "$BASE/socket" -d samosval_test -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='samosval_migration_evidence_owner') THEN CREATE ROLE samosval_migration_evidence_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT; END IF; END \$\$;" >> "$BASE/migrate.log"
python3 "$ROOT/tools/phone-qa-fixture.py" "$BASE"
for f in "$BASE"/migrations/*.sql; do psql -h "$BASE/socket" -d samosval_test -v ON_ERROR_STOP=1 -f "$f" >> "$BASE/migrate.log"; done
export PGHOST="$BASE/socket" POSTGRES_DB=samosval_test POSTGRES_USER=iluxa POSTGRES_PASSWORD=synthetic-only FIREBASE_PROJECT_ID=synthetic-phone-qa WORKSPACE_ID=main_workspace PORT=18099 ALLOWED_ORIGINS=https://samosval-test.iluxa.pro:18499 AUTH_SESSION_SECRET
AUTH_SESSION_SECRET=$(openssl rand -hex 32)
node "$SEED"
BUILD="$BASE-build"
python3 "$ROOT/tools/build-phone-candidate.py" "$BUILD"
python3 "$ROOT/tools/build-phone-candidate.py" "$BASE-legacy" --legacy
ln -s "$BASE-legacy" "$BUILD/legacy"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$BASE/key.pem" -out "$BASE/cert.pem" -days 1 -subj /CN=samosval-test.iluxa.pro > "$BASE/cert.log" 2>&1
node "$ROOT/server/src/index.mjs" > "$BASE/api.log" 2>&1 & api=$!
python3 "$ROOT/tools/phone-local-proxy.py" "$BUILD" "$BASE/cert.pem" "$BASE/key.pem" > "$BASE/proxy.log" 2>&1 & proxy=$!
# Pinned Chromium: the reviewed build, overridable only for a new pinned build.
CHROME=${PHONE_CHROMIUM:-/home/iluxa/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome}
[ -x "$CHROME" ] || { printf 'Missing pinned Chromium: %s\n' "$CHROME"; exit 1; }
export PHONE_QA_BASE="$BASE" PHONE_QA_BUILD="$BUILD" PHONE_CHROMIUM="$CHROME"
node "$SCENARIO" > "$BASE/stand.log" 2>&1
printf 'Stand completed; evidence: %s/stand.log\n' "$BASE"
