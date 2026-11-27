const unitFiles = [
  'auth-local', 'connection-check', 'control-rules', 'db-test-discovery',
  'db-test-manifest', 'firebase-scrypt', 'game-transfer', 'health',
  'identity-rules', 'isolated-db-cli', 'json-response', 'line-rules', 'line-transport',
  'migration-import', 'migration-snapshot', 'nas-runtime', 'opencode-smoke',
  'presence-ui', 'seed-identity-unit', 'seed-objects-unit', 'service-rules',
  'session-client-background', 'session-client', 'shift-archive',
  'shift-start-rules', 'tabel-access', 'tabel-backend', 'tabel-remote',
  'truck-phone', 'updater', 'v2-router'
];

const dbFiles = [
  'api-pool-resilience', 'archive-consumers-latest', 'archive-parallel-restore', 'archive-read', 'archive-revisions', 'archive-schema-025', 'archive-store', 'auxiliary-store',
  'backup-store', 'control-store', 'game-store', 'history-store',
  'identity-store', 'legacy-shift-resolution', 'line-read', 'line-store',
  'notification-store',
  'parallel-shifts-historicalization', 'parallel-shifts-migration-core',
  'refresh-source', 'replica-materialize-parallel-shifts', 'replica-materialize',
'restored-context-migration', 'replica-pending-materialize',
  'replica-exact-backup', 'replica-store', 'replica-stream-026', 'report-store',
  'restored-context-store', 'seed-identity-db', 'seed-objects-db',
  'senior-foreman', 'server-control', 'settings', 'shift-close', 'shift-start',
  'tabel-presence', 'tabel-store', 'truck-phone-http', 'truck-phone-store',
  'v2-command', 'v2-shift-access', 'v2-shift-members-db', 'v2-shift-read-db',
  'v2-truck-transfer-db', 'v2-detached-completion-db', 'v2-line-operations-db'
];

const harnessFiles = [
  'compose-isolated-db', 'isolated-db-bootstrap', 'isolated-db-env', 'isolated-db-fixtures', 'isolated-db-guard',
  'isolated-db-http-tree', 'isolated-db-integration', 'isolated-db-lifecycle', 'isolated-db-process', 'isolated-db-runner',
  'isolated-db-s25-fixtures', 'isolated-db-s26-fixtures', 'isolated-db-templates', 'migration-registry', 'parallel-shifts-runtime-roles'
];

const consumersByFile = {
  'api-pool-resilience': [
    'tests/api-pool-resilience.test.mjs:db-env',
    'tests/api-pool-resilience.test.mjs:http-child',
    'tests/api-pool-resilience.test.mjs:pg'
  ],
  'parallel-shifts-runtime-roles': ['scripts/parallel-shifts-role-bootstrap.mjs:pg', 'tests/parallel-shifts-runtime-roles.test.mjs:pg'],
  'isolated-db-s25-fixtures': [
    'scripts/apply-migrations.mjs:pg',
    'tests/isolated-db-s25-fixtures.test.mjs:pg'
  ],
  'isolated-db-s26-fixtures': ['scripts/apply-migrations.mjs:pg', 'tests/isolated-db-s26-fixtures.test.mjs:pg'],
  'archive-consumers-latest': [
    'scripts/apply-migrations.mjs:pg',
    'tests/archive-consumers-latest.test.mjs:db-env',
    'tests/archive-consumers-latest.test.mjs:pg',
    'tests/helpers/isolated-db.mjs:db-env',
    'tests/helpers/isolated-db.mjs:db-helper',
    'tests/helpers/isolated-db.mjs:pg'
  ],
  "archive-parallel-restore": [
    "scripts/apply-migrations.mjs:pg",
    "tests/archive-parallel-restore.test.mjs:db-env",
    "tests/archive-parallel-restore.test.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg"
  ],
  "archive-read": [
    "scripts/apply-migrations.mjs:pg",
    "tests/archive-read.test.mjs:db-env",
    "tests/archive-read.test.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg"
  ],
  "archive-revisions": [
    "scripts/apply-migrations.mjs:pg",
    "tests/archive-revisions.test.mjs:db-env",
    "tests/archive-revisions.test.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg"
  ],
  "restored-context-migration": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/restored-context-migration.test.mjs:db-env",
    "tests/restored-context-migration.test.mjs:pg"
  ],
  "archive-schema-025": [
    "scripts/apply-migrations.mjs:pg",
    "tests/archive-schema-025.test.mjs:db-env",
    "tests/archive-schema-025.test.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg"
  ],
  "archive-store": [
    "scripts/apply-migrations.mjs:pg",
    "tests/archive-store.test.mjs:db-env",
    "tests/archive-store.test.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg"
  ],
  "auth-local": [],
  "auxiliary-store": [
    "tests/auxiliary-store.test.mjs:db-env",
    "tests/auxiliary-store.test.mjs:pg"
  ],
  "backup-store": [
    "tests/backup-store.test.mjs:db-env",
    "tests/backup-store.test.mjs:pg"
  ],
  "compose-isolated-db": [],
  "connection-check": [],
  "control-rules": [],
  "control-store": [
    "tests/control-store.test.mjs:db-env",
    "tests/control-store.test.mjs:pg"
  ],
  "db-test-discovery": [],
  "db-test-manifest": [],
  "firebase-scrypt": [],
  "game-store": [
    "tests/game-store.test.mjs:db-env",
    "tests/game-store.test.mjs:pg"
  ],
  "game-transfer": [],
  "health": [],
  "history-store": [
    "tests/history-store.test.mjs:db-env",
    "tests/history-store.test.mjs:pg"
  ],
  "identity-rules": [],
  "identity-store": [
    "tests/identity-store.test.mjs:db-env",
    "tests/identity-store.test.mjs:pg"
  ],
  "isolated-db-bootstrap": [
    "tests/isolated-db-bootstrap.test.mjs:pg"
  ],
  "isolated-db-env": [],
  "isolated-db-guard": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg"
  ],
  "isolated-db-http-tree": [
    "tests/isolated-db-http-tree.test.mjs:pg"
  ],
  "isolated-db-integration": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/isolated-db-integration.test.mjs:db-env",
    "tests/isolated-db-integration.test.mjs:pg"
  ],
  "isolated-db-process": [],
  "isolated-db-lifecycle": [
    "scripts/apply-migrations.mjs:pg",
    "tests/isolated-db-lifecycle.test.mjs:pg"
  ],
  "isolated-db-runner": [],
  "isolated-db-fixtures": [
    "scripts/apply-migrations.mjs:pg",
    "tests/isolated-db-fixtures.test.mjs:pg"
  ],
  "isolated-db-templates": [
    "scripts/apply-migrations.mjs:pg",
    "tests/isolated-db-templates.test.mjs:pg"
  ],
  "json-response": [],
  "legacy-shift-resolution": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/legacy-shift-resolution.test.mjs:db-env",
    "tests/legacy-shift-resolution.test.mjs:pg"
  ],
  "line-read": [
    "tests/line-read.test.mjs:db-env",
    "tests/line-read.test.mjs:pg"
  ],
  "line-rules": [],
  "line-store": [
    "tests/line-store.test.mjs:db-env",
    "tests/line-store.test.mjs:pg"
  ],
  "line-transport": [],
  "migration-import": [],
  "migration-registry": [
    "scripts/apply-migrations.mjs:pg",
    "tests/migration-registry.test.mjs:db-env",
    "tests/migration-registry.test.mjs:pg"
  ],
  "migration-snapshot": [],
  "nas-runtime": [],
  "notification-store": [
    "tests/notification-store.test.mjs:db-env",
    "tests/notification-store.test.mjs:pg"
  ],
  "opencode-smoke": [],
  "parallel-shifts-historicalization": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/parallel-shifts-historicalization.test.mjs:db-env",
    "tests/parallel-shifts-historicalization.test.mjs:pg"
  ],
  "parallel-shifts-migration-core": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/parallel-shifts-migration-core.test.mjs:db-env",
    "tests/parallel-shifts-migration-core.test.mjs:pg"
  ],
  "presence-ui": [],
  "refresh-source": [
    "tests/refresh-source.test.mjs:db-env",
    "tests/refresh-source.test.mjs:pg"
  ],
  "replica-materialize-parallel-shifts": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/replica-materialize-parallel-shifts.test.mjs:db-env",
    "tests/replica-materialize-parallel-shifts.test.mjs:pg"
  ],
  "replica-materialize": [
    "tests/replica-materialize.test.mjs:db-env",
    "tests/replica-materialize.test.mjs:pg"
  ],
  "replica-exact-backup": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/replica-exact-backup.test.mjs:db-env",
    "tests/replica-exact-backup.test.mjs:pg"
  ],
  "replica-pending-materialize": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/replica-pending-materialize.test.mjs:db-env",
    "tests/replica-pending-materialize.test.mjs:pg"
  ],
  "replica-store": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/replica-store.test.mjs:db-env",
    "tests/replica-store.test.mjs:pg"
  ],
  "replica-stream-026": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/replica-stream-026.test.mjs:db-env",
    "tests/replica-stream-026.test.mjs:pg"
  ],
  "report-store": [
    "tests/report-store.test.mjs:db-env",
    "tests/report-store.test.mjs:pg"
  ],
  "restored-context-store": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/restored-context-store.test.mjs:db-env",
    "tests/restored-context-store.test.mjs:pg"
  ],
  "seed-identity-db": [
    "tests/seed-identity-db.test.mjs:db-env",
    "tests/seed-identity-db.test.mjs:pg"
  ],
  "seed-identity-unit": [],
  "seed-objects-db": [
    "tests/seed-objects-db.test.mjs:db-env",
    "tests/seed-objects-db.test.mjs:pg"
  ],
  "seed-objects-unit": [],
  "senior-foreman": [
    "tests/senior-foreman.test.mjs:db-env",
    "tests/senior-foreman.test.mjs:pg"
  ],
  "server-control": [
    "tests/server-control.test.mjs:db-env",
    "tests/server-control.test.mjs:pg"
  ],
  "service-rules": [],
  "session-client-background": [],
  "session-client": [],
  "settings": [
    "tests/settings.test.mjs:db-env",
    "tests/settings.test.mjs:pg"
  ],
  "shift-archive": [],
  "shift-close": [
    "tests/shift-close.test.mjs:db-env",
    "tests/shift-close.test.mjs:pg"
  ],
  "shift-start-rules": [],
  "shift-start": [
    "tests/shift-start.test.mjs:db-env",
    "tests/shift-start.test.mjs:pg"
  ],
  "tabel-access": [],
  "tabel-backend": [],
  "tabel-presence": [
    "tests/tabel-presence.test.mjs:db-env",
    "tests/tabel-presence.test.mjs:pg"
  ],
  "tabel-remote": [],
  "tabel-store": [
    "tests/tabel-store.test.mjs:db-env",
    "tests/tabel-store.test.mjs:pg"
  ],
  "truck-phone-http": [
    "tests/truck-phone-http.test.mjs:db-env",
    "tests/truck-phone-http.test.mjs:http-child",
    "tests/truck-phone-http.test.mjs:pg"
  ],
  "truck-phone-store": [
    "tests/truck-phone-store.test.mjs:db-env",
    "tests/truck-phone-store.test.mjs:pg"
  ],
  "truck-phone": [],
  "v2-command": [
    "tests/v2-command.test.mjs:db-env",
    "tests/v2-command.test.mjs:pg"
  ],
  "v2-shift-access": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/v2-shift-access.test.mjs:db-env",
    "tests/v2-shift-access.test.mjs:pg"
  ],
  "v2-shift-members-db": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/v2-shift-members-db.test.mjs:db-env",
    "tests/v2-shift-members-db.test.mjs:pg"
  ],
  "v2-shift-read-db": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/v2-shift-read-db.test.mjs:db-env",
    "tests/v2-shift-read-db.test.mjs:pg"
  ],
  "v2-truck-transfer-db": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/v2-truck-transfer-db.test.mjs:db-env",
    "tests/v2-truck-transfer-db.test.mjs:pg"
  ],
  "v2-detached-completion-db": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/v2-detached-completion-db.test.mjs:db-env",
    "tests/v2-detached-completion-db.test.mjs:pg"
  ],
  "v2-line-operations-db": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/v2-line-operations-db.test.mjs:db-env",
    "tests/v2-line-operations-db.test.mjs:pg"
  ],
  "v2-router": [],
  "updater": [
    "audit:updater-release-only"
  ]
};

const unitReasons = {
  'connection-check': 'Imports the connection helper with synthetic clients; no PostgreSQL module or DB environment is used',
  'db-test-discovery': 'Exercises static filesystem discovery against fixtures; audited as infrastructure code without a database connection',
  'db-test-manifest': 'Validates manifest data in memory; no PostgreSQL module or DB environment is used',
  'health': 'Calls the health handler with test doubles; it does not start the API process or connect to PostgreSQL',
  'migration-import': 'Validates source SQL and import contracts as text without executing them against PostgreSQL',
  'tabel-access': 'Imports tabel-store only for the pure jobHash export; no pool is constructed or DB environment read',
  'updater': 'Imports updater code with database-capable dependencies but exercises release normalization only; static audit confirms no connection is created'
};

const dbReasons = {
  'archive-consumers-latest': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for latest-finalized archive consumers and exact revision history',
  'archive-revisions': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for restored context finalize into immutable archive revisions',
  'restored-context-migration': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for the exact legacy restored copy-verify-delete migration',
  'restored-context-store': 'Imports pg and reads TEST_DATABASE_URL for restored context corrections with CAS, receipt and audit',
  'parallel-shifts-historicalization': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for the exact-report legacy historicalization cutover',
  'parallel-shifts-migration-core': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for destructive migration 025 integration',
  'refresh-source': 'Imports pg and reads TEST_DATABASE_URL for source refresh with import tables',
  'replica-exact-backup': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for the exact provenance bundle normalization, bootstrap fingerprint and replica restore',
  'replica-materialize-parallel-shifts': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for atomic S24 to migration 025 replica behavior',
  'replica-pending-materialize': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for the 026 head/pending/delete materializer state machine',
  'replica-materialize': 'Imports pg and reads TEST_DATABASE_URL for replica materialization',
  'replica-store': 'Imports pg and reads TEST_DATABASE_URL for replica stream and cursor storage',
  'replica-stream-026': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for the fail-closed replica stream 026 preflight',
  'seed-identity-db': 'Imports pg and reads TEST_DATABASE_URL for identity promotion from explicit import tables',
  'seed-objects-db': 'Imports pg and reads TEST_DATABASE_URL for object promotion from explicit import tables',
  'v2-command': 'Imports pg and reads TEST_DATABASE_URL for v2 receipt/audit atomicity and replay',
  'v2-shift-members-db': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for strict v2 shift creation, object change and membership CAS on the S25 baseline',
  'v2-truck-transfer-db': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for one truck assignment, force transfer and the detached-cycle gates on the S25 baseline',
  'v2-detached-completion-db': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for the online completion of a detached source trip on the S25 baseline',
  'v2-line-operations-db': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for the shift-scoped line operations, object lock and CAS/receipt contract on the S25 baseline',
  'v2-shift-read-db': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for the visible shift list, scoped snapshot and trap B on the S24 baseline',
  'truck-phone-http': 'Starts the real src/index.mjs API child and imports pg; the child inherits its generated TEST_DATABASE_URL'
};

// Per-file wall-clock budget. These legacy roots reset the target and replay the
// migration chain inside their own hooks, several times per file, so the default
// 60s is not a realistic ceiling for the heaviest ones. Measured locally on the
// isolated harness; kept generous to absorb slower CI disks.
const timeoutsByFile = {
  'archive-consumers-latest': 180_000,
  'archive-revisions': 180_000,
  'archive-schema-025': 180_000,
  'legacy-shift-resolution': 180_000,
  'parallel-shifts-historicalization': 240_000,
  'parallel-shifts-migration-core': 240_000,
  'replica-exact-backup': 240_000,
  'replica-materialize-parallel-shifts': 180_000,
  'replica-pending-materialize': 240_000,
  'replica-stream-026': 240_000,
  'replica-store': 180_000,
  'restored-context-migration': 240_000,
  'restored-context-store': 180_000,
  'v2-shift-members-db': 180_000,
  'v2-shift-read-db': 240_000,
  'v2-truck-transfer-db': 180_000,
  'v2-detached-completion-db': 180_000,
  'v2-line-operations-db': 180_000
};

const fixturesByFile = {
  'auxiliary-store': ['import-schema'],
  'backup-store': ['import-schema'],
  'identity-store': ['identity-empty', 'auth-schema-018'],
  'refresh-source': ['import-schema'],
  'replica-materialize-parallel-shifts': ['replica-admin', 'replica-empty-stream-cursors'],
  'replica-materialize': ['replica-admin', 'replica-empty-stream-cursors'],
  'replica-store': ['replica-admin'],
  'seed-identity-db': ['identity-empty', 'import-schema'],
  'seed-objects-db': ['import-schema'],
  'senior-foreman': ['authority-main-ubuntu'],
  'server-control': ['authority-main-ubuntu']
};

const importTablesByFile = {
  'auxiliary-store': ['import-schema'],
  'backup-store': ['import-schema'],
  'refresh-source': ['import-schema'],
  'seed-identity-db': ['import-schema'],
  'seed-objects-db': ['import-schema']
};

const unitEntries = unitFiles.map(name => ({
  file: `tests/${name}.test.mjs`,
  kind: 'unit',
  discovery: 'pure-import',
  reason: `unit/pure-import tests/${name}.test.mjs: ${(consumersByFile[name] ?? []).join(', ') || 'no typed database consumer'}` ,
  consumers: consumersByFile[name] ?? []
}));

const bootstrapEnvByFile = {
  // These db roots reset the target and replay migrations through 025 (or 026)
  // inside their own setup hook. DDL — DROP/CREATE SCHEMA, CREATE TABLE, the 025
  // owner transfers and the SET SESSION AUTHORIZATION probes — cannot run as
  // `samosval_test_app`, so the helper performs it on a privileged bootstrap
  // connection while every assertion still runs on the app connection
  // (spec 3.10/§6). The extra passwords exist for the legacy restored-context
  // probes that must switch to the real runtime/maintenance role.
  // `api-pool-resilience` needs it for a different reason: it terminates every
  // other backend of its own target with pg_terminate_backend, which the
  // unprivileged app role is not allowed to do.
  'api-pool-resilience': ['bootstrap-url'],
  'archive-consumers-latest': ['bootstrap-url'],
  'archive-parallel-restore': ['bootstrap-url'],
  'archive-read': ['bootstrap-url'],
  'archive-store': ['bootstrap-url'],
  'archive-revisions': ['bootstrap-url'],
  'archive-schema-025': ['bootstrap-url'],
  'legacy-shift-resolution': ['bootstrap-url'],
  'parallel-shifts-historicalization': ['bootstrap-url'],
  'parallel-shifts-migration-core': ['bootstrap-url'],
  'replica-exact-backup': ['bootstrap-url'],
  'replica-materialize-parallel-shifts': ['bootstrap-url'],
  'replica-pending-materialize': ['bootstrap-url'],
  'replica-store': ['bootstrap-url'],
  'replica-stream-026': ['bootstrap-url'],
  'restored-context-migration': ['bootstrap-url', 'runtime-password', 'maintenance-password'],
  'restored-context-store': ['bootstrap-url'],
  'v2-shift-access': ['bootstrap-url'],
  'v2-shift-members-db': ['bootstrap-url'],
  'v2-shift-read-db': ['bootstrap-url'],
  'v2-truck-transfer-db': ['bootstrap-url'],
  'v2-detached-completion-db': ['bootstrap-url'],
  'v2-line-operations-db': ['bootstrap-url']
};

// Roots that start the real src/index.mjs child on a fixed port are discovered
// as indirect-http and need the longer wall-clock budget.
const httpDbRoots = new Set(['api-pool-resilience', 'truck-phone-http']);

const dbEntries = dbFiles.map(name => ({
  file: `tests/${name}.test.mjs`,
  kind: 'db',
  discovery: httpDbRoots.has(name) ? 'indirect-http' : 'direct',
  reason: `${httpDbRoots.has(name) ? 'db/indirect-http' : 'db/direct'} tests/${name}.test.mjs: ${(consumersByFile[name] ?? []).join(', ')}` ,
  consumers: consumersByFile[name] ?? [],
  env: bootstrapEnvByFile[name] ?? [],
  // Until Task 17 no db root ran on S25: the S25 contract is proved by the
  // `isolated-db-s25-fixtures` harness contract. Nine roots build through 025;
  // five of them build pre-025 state and then apply 025 as their actual subject
  // (`parallel-shifts-migration-core`, `replica-materialize-parallel-shifts`,
  // `parallel-shifts-historicalization`, `legacy-shift-resolution`,
  // `restored-context-migration`), and an S25 clone has already consumed that
  // transition, so those stay on S24 by nature. `isolated-db-integration` stops
  // at 024 by design. The other four (`archive-schema-025`, `archive-revisions`,
  // `restored-context-store`, `archive-consumers-latest`) only reset the
  // database and apply everything through 25 — they are the ones that can move
  // to `baseline:'S25'`. The real blocker is the helper, not their subject:
  // `tests/helpers/isolated-db.mjs` accepts only the exact name
  // `samosval_parallel_shifts_test`, so a harness target
  // `..._<runid>_<hash>` skips and the run fails — verified on the unmodified
  // baseline: `archive-schema-025` as its own harness root gives
  // `# pass 1 # skipped 13`, `EXIT=1` (docs/opyt-oshibok.md §27.2).
  // `archive-store`, `archive-parallel-restore` and `replica-materialize` are
  // old-line scenarios that fail on S25 by nature (docs/opyt-oshibok.md,
  // lesson 23.1).
  // `v2-shift-access` is the first db root on S25: the ACL needs the 025
  // membership table from the frozen template and applies 026/027 itself on the
  // privileged bootstrap connection.
  // `v2-shift-read-db` stays on S24 on purpose: an unresolved historical row and
  // a restored copy can only be legacy v1 rows inserted before 025, so the root
  // applies 025/026/027 itself (docs/opyt-oshibok.md, lesson 19).
  baseline: ['v2-shift-access', 'v2-shift-members-db'].includes(name) ? 'S25' : ['v2-truck-transfer-db', 'v2-detached-completion-db', 'v2-line-operations-db'].includes(name) ? 'S25' : name === 'isolated-db-s26-fixtures' ? 'S25' : 'S24',
migrationsThrough: ['v2-shift-access', 'v2-shift-members-db', 'v2-shift-read-db'].includes(name) ? 27 : ['v2-truck-transfer-db', 'v2-detached-completion-db', 'v2-line-operations-db'].includes(name) ? 28 : ['replica-stream-026', 'replica-store', 'replica-pending-materialize', 'replica-exact-backup'].includes(name) ? 26 : name === 'parallel-shifts-migration-core' || name === 'replica-materialize-parallel-shifts' || name === 'parallel-shifts-historicalization' || name === 'legacy-shift-resolution' || name === 'archive-schema-025' || name === 'restored-context-migration' || name === 'restored-context-store' || name === 'archive-consumers-latest' || name === 'archive-revisions' ? 25 : null,
  customSchema: [],
  importTables: importTablesByFile[name] ?? [],
  fixtures: fixturesByFile[name] ?? [],
  timeoutMs: timeoutsByFile[name] ?? (httpDbRoots.has(name) ? 120_000 : 60_000),
  serial: false,
  exclusive: name === 'truck-phone-http',
  allowedSkips: []
}));

// Harness roots that run the shipped runner as a nested child pay for a second
// set of templates and target clones, so they need their own wall-clock budget.
// The value stays inside the manifest's shared timeout range (1s..300s).
const harnessTimeoutsByFile = {
  'isolated-db-http-tree': 300_000
};

const harnessEntries = harnessFiles.map(name => ({
  file: `tests/${name}.test.mjs`,
  kind: 'harness-contract',
  discovery: 'harness-contract',
  reason: `harness-contract/harness-contract tests/${name}.test.mjs: ${(consumersByFile[name] ?? []).join(', ') || 'no typed database consumer'}` ,
  consumers: consumersByFile[name] ?? [],
  // Optional per-root budget: the pure registry checks keep the 60s default,
  // while a root that drives the real runner as a nested child declares its own.
  ...(harnessTimeoutsByFile[name] ? { timeoutMs: harnessTimeoutsByFile[name] } : {}),
  env: {
    // This harness contract deliberately receives admin-url: it verifies that
    // the orchestrator credential is distinct from bootstrap-admin credentials.
    // No other child receives this privileged URL.
    'isolated-db-bootstrap': ['admin-url', 'bootstrap-url', 'app-password', 'runtime-password'],
    // Drives the real runner twice on tests/truck-phone-http.test.mjs, so it
    // needs the orchestrator URL to read the generated targets around the runs
    // plus exactly the bootstrap/app credentials a nested runner invocation
    // requires, and the isolated marker it asserts on. No raw variable names
    // are declared here.
    'isolated-db-http-tree': ['admin-url', 'bootstrap-url', 'app-password', 'isolated-marker'],
    'isolated-db-fixtures': ['bootstrap-url'],
    'isolated-db-templates': ['bootstrap-url', 'app-password'],
    'isolated-db-lifecycle': ['bootstrap-url', 'app-password', 'runtime-password'],
     // The integration root resets the target and replays migrations 001–024
     // inside its own setup hook, so it needs the same privileged bootstrap
     // connection the db helper uses; the assertions still run as the app role.
     'isolated-db-integration': ['target-url', 'isolated-marker', 'bootstrap-url'],
    // Applies the 025 provenance/archive fixtures on clones of the run's sealed
    // S25 template. Two fixtures need table ownership (the pre-025 legacy row
    // behind the named v2 bridge and the fixture registry), which a db child
    // never receives: it runs as samosval_test_app, so this is a harness
    // contract like isolated-db-fixtures.
    'isolated-db-s25-fixtures': ['bootstrap-url'],
    'isolated-db-s26-fixtures': ['bootstrap-url'],
    // Verifies apply-migrations the way production runs it: on a fresh EMPTY
    // database, never in a decoy schema (025/026 are fully qualified on purpose).
    // That needs CREATE DATABASE/TEMPLATE and pg_authid-adjacent role checks,
    // which a db child never gets as samosval_test_app, so the root is a
    // harness contract like isolated-db-fixtures.
    'migration-registry': ['bootstrap-url'],
    'parallel-shifts-runtime-roles': ['bootstrap-url', 'runtime-password', 'maintenance-password']
  }[name] ?? []
}));

const manifest = {
  manifestVersion: 1,
  entries: [...unitEntries, ...dbEntries, ...harnessEntries].sort((a, b) => a.file.localeCompare(b.file)),
  harnessFixtures: [
    'tests/fixtures/isolated-db-sentinel.test.mjs',
    'tests/fixtures/marker-tamper.test.mjs',
    'tests/fixtures/sigterm-self.test.mjs',
    'tests/fixtures/isolated-db-process.test.mjs'
  ]
};

export default manifest;
