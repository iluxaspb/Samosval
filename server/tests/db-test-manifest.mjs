const unitFiles = [
  'auth-local', 'connection-check', 'control-rules', 'db-test-discovery',
  'db-test-manifest', 'firebase-scrypt', 'game-transfer', 'health',
  'identity-rules', 'json-response', 'line-rules', 'line-transport',
  'migration-import', 'migration-snapshot', 'nas-runtime', 'opencode-smoke',
  'presence-ui', 'seed-identity-unit', 'seed-objects-unit', 'service-rules',
  'session-client-background', 'session-client', 'shift-archive',
  'shift-start-rules', 'tabel-access', 'tabel-backend', 'tabel-remote',
  'truck-phone', 'updater'
];

const dbFiles = [
  'archive-parallel-restore', 'archive-read', 'archive-store', 'auxiliary-store',
  'backup-store', 'control-store', 'game-store', 'history-store',
  'identity-store', 'line-read', 'line-store', 'migration-registry',
  'notification-store', 'parallel-shifts-migration-core', 'refresh-source',
  'replica-materialize-parallel-shifts', 'replica-materialize', 'replica-store',
  'report-store', 'seed-identity-db', 'seed-objects-db', 'senior-foreman',
  'server-control', 'settings', 'shift-close', 'shift-start', 'tabel-presence',
  'tabel-store', 'truck-phone-http', 'truck-phone-store'
];

const harnessFiles = [
  'compose-isolated-db', 'isolated-db-bootstrap', 'isolated-db-fixtures', 'isolated-db-guard',
  'isolated-db-integration', 'isolated-db-lifecycle', 'isolated-db-runner', 'isolated-db-templates'
];

const consumersByFile = {
  "archive-parallel-restore": [
    "tests/archive-parallel-restore.test.mjs:db-env",
    "tests/archive-parallel-restore.test.mjs:pg"
  ],
  "archive-read": [
    "tests/archive-read.test.mjs:db-env",
    "tests/archive-read.test.mjs:pg"
  ],
  "archive-store": [
    "tests/archive-store.test.mjs:db-env",
    "tests/archive-store.test.mjs:pg"
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
  "isolated-db-guard": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg"
  ],
  "isolated-db-integration": [
    "scripts/apply-migrations.mjs:pg",
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
    "tests/isolated-db-integration.test.mjs:db-env",
    "tests/isolated-db-integration.test.mjs:pg"
  ],
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
    "tests/helpers/isolated-db.mjs:db-env",
    "tests/helpers/isolated-db.mjs:db-helper",
    "tests/helpers/isolated-db.mjs:pg",
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
  "replica-store": [
    "tests/replica-store.test.mjs:db-env",
    "tests/replica-store.test.mjs:pg"
  ],
  "report-store": [
    "tests/report-store.test.mjs:db-env",
    "tests/report-store.test.mjs:pg"
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
  'migration-registry': 'Imports pg and apply-migrations, and reads TEST_DATABASE_URL to verify the migration registry',
  'parallel-shifts-migration-core': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for destructive migration 025 integration',
  'refresh-source': 'Imports pg and reads TEST_DATABASE_URL for source refresh with import tables',
  'replica-materialize-parallel-shifts': 'Imports pg/apply-migrations and reads TEST_DATABASE_URL for atomic S24 to migration 025 replica behavior',
  'replica-materialize': 'Imports pg and reads TEST_DATABASE_URL for replica materialization',
  'replica-store': 'Imports pg and reads TEST_DATABASE_URL for replica stream and cursor storage',
  'seed-identity-db': 'Imports pg and reads TEST_DATABASE_URL for identity promotion from explicit import tables',
  'seed-objects-db': 'Imports pg and reads TEST_DATABASE_URL for object promotion from explicit import tables',
  'truck-phone-http': 'Starts the real src/index.mjs API child and imports pg; the child inherits its generated TEST_DATABASE_URL'
};

const fixturesByFile = {
  'identity-store': ['identity-empty'],
  'refresh-source': ['import-schema'],
  'replica-materialize-parallel-shifts': ['replica-admin', 'replica-empty-stream-cursors'],
  'replica-materialize': ['replica-admin', 'replica-empty-stream-cursors'],
  'replica-store': ['replica-admin', 'replica-empty-stream-cursors'],
  'seed-identity-db': ['identity-empty', 'import-schema'],
  'seed-objects-db': ['import-schema'],
  'senior-foreman': ['authority-main-ubuntu'],
  'server-control': ['authority-main-ubuntu']
};

const importTablesByFile = {
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

const dbEntries = dbFiles.map(name => ({
  file: `tests/${name}.test.mjs`,
  kind: 'db',
  discovery: name === 'truck-phone-http' ? 'indirect-http' : 'direct',
  reason: `${name === 'truck-phone-http' ? 'db/indirect-http' : 'db/direct'} tests/${name}.test.mjs: ${(consumersByFile[name] ?? []).join(', ')}` ,
  consumers: consumersByFile[name] ?? [],
  baseline: 'S24',
  migrationsThrough: name === 'parallel-shifts-migration-core' || name === 'replica-materialize-parallel-shifts' ? 25 : null,
  customSchema: [],
  importTables: importTablesByFile[name] ?? [],
  fixtures: fixturesByFile[name] ?? [],
  timeoutMs: name === 'truck-phone-http' ? 120_000 : 60_000,
  serial: false,
  exclusive: name === 'truck-phone-http',
  allowedSkips: []
}));

const harnessEntries = harnessFiles.map(name => ({
  file: `tests/${name}.test.mjs`,
  kind: 'harness-contract',
  discovery: 'harness-contract',
  reason: `harness-contract/harness-contract tests/${name}.test.mjs: ${(consumersByFile[name] ?? []).join(', ') || 'no typed database consumer'}` ,
  consumers: consumersByFile[name] ?? []
}));

const manifest = {
  manifestVersion: 1,
  entries: [...unitEntries, ...dbEntries, ...harnessEntries].sort((a, b) => a.file.localeCompare(b.file)),
  harnessFixtures: [
    'tests/fixtures/isolated-db-sentinel.test.mjs',
    'tests/fixtures/marker-tamper.test.mjs',
    'tests/fixtures/sigterm-self.test.mjs'
  ]
};

export default manifest;
