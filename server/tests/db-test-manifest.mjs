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
  'compose-isolated-db', 'isolated-db-guard', 'isolated-db-integration',
  'isolated-db-runner'
];

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
  reason: unitReasons[name] ?? `Exercises ${name} domain behavior without PostgreSQL imports, DB environment reads or an API child`
}));

const dbEntries = dbFiles.map(name => ({
  file: `tests/${name}.test.mjs`,
  kind: 'db',
  discovery: name === 'truck-phone-http' ? 'indirect-http' : 'direct',
  reason: dbReasons[name] ?? `Imports pg and reads TEST_DATABASE_URL for the ${name} PostgreSQL contract`,
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
  reason: `Validates the ${name} launcher safety contract with only its explicitly controlled harness environment`
}));

const manifest = {
  manifestVersion: 1,
  entries: [...unitEntries, ...dbEntries, ...harnessEntries].sort((a, b) => a.file.localeCompare(b.file)),
  harnessFixtures: [
    'tests/fixtures/isolated-db-sentinel.test.mjs',
    'tests/fixtures/sigterm-self.test.mjs'
  ]
};

export default manifest;
