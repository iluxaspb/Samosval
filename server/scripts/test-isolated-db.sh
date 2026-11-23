#!/bin/sh
unset NODE_OPTIONS NODE_PATH
exec node "$(dirname "$0")/test-isolated-db.mjs" "$@"
