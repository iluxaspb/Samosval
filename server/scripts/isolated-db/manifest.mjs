const TOP_FIELDS = new Set(['manifestVersion', 'entries', 'harnessFixtures']);
const COMMON_FIELDS = new Set(['file', 'kind', 'discovery', 'reason']);
const DB_FIELDS = new Set([
  ...COMMON_FIELDS,
  'baseline', 'migrationsThrough', 'customSchema', 'importTables', 'fixtures',
  'timeoutMs', 'serial', 'exclusive', 'allowedSkips'
]);
const KINDS = new Set(['unit', 'db', 'harness-contract']);
const DISCOVERY = new Set(['pure-import', 'direct', 'indirect-http', 'harness-contract']);
const BASELINES = new Set(['empty', 'S24']);

function fail(message) {
  throw new Error(`invalid DB test manifest: ${message}`);
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('entry must be an object');
  const allowed = entry.kind === 'db' ? DB_FIELDS : COMMON_FIELDS;
  for (const field of Object.keys(entry)) if (!allowed.has(field)) fail(`unknown field ${field} in ${entry.file ?? '<unknown>'}`);
  for (const field of COMMON_FIELDS) if (!(field in entry)) fail(`missing ${field} in ${entry.file ?? '<unknown>'}`);
  if (!/^tests\/[^/]+\.test\.mjs$/.test(entry.file)) fail(`root path required for ${entry.file}`);
  if (!KINDS.has(entry.kind)) fail(`unknown kind for ${entry.file}`);
  if (!DISCOVERY.has(entry.discovery)) fail(`unknown discovery for ${entry.file}`);
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') fail(`reason required for ${entry.file}`);
  if (entry.kind === 'unit' && entry.discovery !== 'pure-import') fail(`unit discovery mismatch for ${entry.file}`);
  if (entry.kind === 'harness-contract' && entry.discovery !== 'harness-contract') fail(`harness discovery mismatch for ${entry.file}`);
  if (entry.kind !== 'db') return;
  for (const field of DB_FIELDS) if (!(field in entry)) fail(`missing ${field} in ${entry.file}`);
  if (!BASELINES.has(entry.baseline)) fail(`unsupported baseline for ${entry.file}`);
  if (entry.migrationsThrough !== null && (!Number.isInteger(entry.migrationsThrough) || entry.migrationsThrough < 24)) fail(`invalid migrationsThrough for ${entry.file}`);
  for (const field of ['customSchema', 'importTables', 'fixtures', 'allowedSkips']) if (!Array.isArray(entry[field])) fail(`${field} must be an array in ${entry.file}`);
  if (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 1_000 || entry.timeoutMs > 300_000) fail(`invalid timeoutMs in ${entry.file}`);
  if (typeof entry.serial !== 'boolean' || typeof entry.exclusive !== 'boolean' || (entry.serial && entry.exclusive)) fail(`invalid scheduling metadata in ${entry.file}`);
}

export function loadManifest(manifest, { discovered } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('root must be an object');
  for (const field of Object.keys(manifest)) if (!TOP_FIELDS.has(field)) fail(`unknown field ${field}`);
  if (!Number.isInteger(manifest.manifestVersion) || manifest.manifestVersion < 1) fail('manifestVersion required');
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.harnessFixtures)) fail('entries and harnessFixtures must be arrays');
  const seen = new Set();
  for (const entry of manifest.entries) {
    validateEntry(entry);
    if (seen.has(entry.file)) fail(`duplicate entry ${entry.file}`);
    seen.add(entry.file);
  }
  const fixtureSeen = new Set();
  for (const fixture of manifest.harnessFixtures) {
    if (typeof fixture !== 'string' || !/^tests\/fixtures\/[^/]+\.test\.mjs$/.test(fixture)) fail(`fixture path must be under tests/fixtures: ${fixture}`);
    if (fixtureSeen.has(fixture)) fail(`duplicate fixture ${fixture}`);
    fixtureSeen.add(fixture);
    if (seen.has(fixture)) fail(`fixture cannot also be a root entry: ${fixture}`);
  }
  if (discovered) {
    for (const file of discovered) if (file.includes('/fixtures/')) fail(`root discovery must not include fixtures: ${file}`);
    const roots = new Set(discovered);
    for (const file of roots) if (!seen.has(file)) fail(`missing root entry ${file}`);
    for (const file of seen) if (!roots.has(file)) fail(`stale manifest entry ${file}`);
  }
  return manifest;
}
