#!/bin/sh
# Portable Synology/DSM and Linux runner for a disposable, synthetic lab.
# Only run from an extracted, checksum-verified spark-lab package.
# Does not access an existing NAS database or any Firebase project.
set -eu
umask 077
PATH=/usr/local/bin:/usr/bin:/bin:/var/packages/ContainerManager/target/usr/bin:${PATH:-}
export PATH

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT=samosval-spark-lab
COMPOSE_FILE="$ROOT/server/compose.spark-lab.test.yaml"
STARTED=0

fail(){ printf 'SPARK_LAB_PREFLIGHT_REFUSED: %s\n' "$*" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum unavailable'
command -v docker >/dev/null 2>&1 || fail 'Container Manager/docker unavailable'
test -f "$ROOT/SHA256SUMS" || fail 'verified package required'
test -f "$ROOT/SOURCE_COMMIT" || fail 'source commit missing'
test -f "$COMPOSE_FILE" || fail 'Compose missing'
(
  cd "$ROOT"
  sha256sum -c SHA256SUMS >/dev/null
) || fail 'package checksums mismatch'
grep -Eq '^[a-f0-9]{40}$' "$ROOT/SOURCE_COMMIT" || fail 'invalid pinned commit'

if docker compose version >/dev/null 2>&1; then
  compose(){ docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose(){ docker-compose "$@"; }
else
  fail 'Docker Compose not installed'
fi

# Prevent removal of any pre-existing project, even a stopped container.
# Clean the previous lab intentionally, separately, before retrying.
if test -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")"; then
  fail 'project containers already exist; refusing to touch them'
fi
if test -n "$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT")"; then
  fail 'project networks already exist; refusing to touch them'
fi
if test -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")"; then
  fail 'project volumes already exist; refusing to touch them'
fi
compose -p "$PROJECT" -f "$COMPOSE_FILE" config --quiet ||
  fail 'Compose configuration invalid'

# The installed package has no bind mounts, Docker socket, external network
# or published ports. Its exact Compose bytes were checked above.
cleanup(){
  code=$?
  trap - EXIT INT TERM
  if test "$STARTED" -eq 1; then
    if ! compose -p "$PROJECT" -f "$COMPOSE_FILE" down --volumes --remove-orphans; then
      printf 'SPARK_LAB_CLEANUP_FAILED_MANUAL_CHECK_REQUIRED\n' >&2
      if test "$code" -eq 0; then code=1; fi
    fi
  fi
  if test "$code" -eq 0; then
    printf 'SPARK_LAB_SYNOLOGY_REHEARSAL_SUCCESS_CLEANED\n'
  else
    printf 'SPARK_LAB_SYNOLOGY_REHEARSAL_FAILED_EXIT_%s\n' "$code" >&2
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'SPARK_LAB_PINNED_COMMIT_%s\n' "$(cat "$ROOT/SOURCE_COMMIT")"
printf 'SPARK_LAB_STARTING_DISPOSABLE_PROJECT_ONLY\n'
STARTED=1
compose -p "$PROJECT" -f "$COMPOSE_FILE" up --build --abort-on-container-exit --exit-code-from runner
