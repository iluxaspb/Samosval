import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const VERSION = 1;
const TOP_FIELDS = new Set(['manifestVersion', 'entries', 'harnessFixtures']);
const COMMON_FIELDS = new Set(['file', 'kind', 'discovery', 'reason', 'consumers']);
const HARNESS_FIELDS = new Set([...COMMON_FIELDS, 'env']);
const DB_FIELDS = new Set([...COMMON_FIELDS, 'baseline', 'migrationsThrough', 'customSchema', 'importTables', 'fixtures', 'timeoutMs', 'serial', 'exclusive', 'allowedSkips']);
const KINDS = new Set(['unit', 'db', 'harness-contract']);
const DISCOVERY = new Set(['pure-import', 'direct', 'indirect-http', 'harness-contract']);
const BASELINE_VERSIONS = new Map([['empty', 0], ['S24', 24]]);
const FIXTURES = new Set(['import-schema', 'identity-empty', 'auth-schema-018', 'authority-main-ubuntu', 'authority-main-firebase', 'replica-admin', 'replica-empty-stream-cursors']);
const CUSTOM_SCHEMA = new Set([]);
const IMPORT_TABLES = new Set(['import-schema']);

function fail(message) { throw new Error(`invalid DB test manifest: ${message}`); }
function same(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
export function canonicalReason({ file, kind, discovery, consumers }) {
  const signature = consumers.length ? consumers.join(', ') : 'no typed database consumer';
  return `${kind}/${discovery} ${file}: ${signature}`;
}
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function canonicalPath(serverDirectory, file, fixture = false) {
  const pattern = fixture ? /^tests\/fixtures\/(?:[^/]+\/)*[^/]+\.test\.mjs$/ : /^tests\/(?:[^/]+\/)*[^/]+\.test\.mjs$/;
  if (typeof file !== 'string' || isAbsolute(file) || !pattern.test(file) || file.includes('/../') || file.includes('/./')) fail(`canonical relative test path required for ${file}`);
  const lexical = resolve(serverDirectory, file);
  let metadata;
  try { metadata = await lstat(lexical); } catch { fail(`missing file ${file}`); }
  if (metadata.isSymbolicLink()) fail(`symlink test path rejected: ${file}`);
  const canonical = await realpath(lexical);
  const testsDirectory = await realpath(resolve(serverDirectory, 'tests'));
  if (!inside(testsDirectory, canonical) || canonical !== lexical) fail(`canonical contained test path required for ${file}`);
  return canonical;
}

function validateRegistry(field, values, registry, file) {
  if (!Array.isArray(values)) fail(`${field} must be an array in ${file}`);
  for (const value of values) if (typeof value !== 'string' || !registry.has(value)) fail(`unknown ${field} reference ${value} in ${file}`);
  if (new Set(values).size !== values.length) fail(`duplicate ${field} reference in ${file}`);
}

function validateSkips(values, file) {
  if (!Array.isArray(values)) fail(`allowedSkips must be an array in ${file}`);
  for (const value of values) {
    const fields = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
    if (!fields.every(field => ['name', 'reason', 'platform', 'node'].includes(field)) || typeof value?.name !== 'string' || !value.name || typeof value?.reason !== 'string' || !value.reason) fail(`invalid allowedSkips in ${file}`);
  }
}

async function validateEntry(entry, serverDirectory) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('entry must be an object');
  const allowed = entry.kind === 'db' ? DB_FIELDS : entry.kind === 'harness-contract' ? HARNESS_FIELDS : COMMON_FIELDS;
  for (const field of Object.keys(entry)) if (!allowed.has(field)) fail(`unknown field ${field} in ${entry.file ?? '<unknown>'}`);
  for (const field of allowed) if (!(field in entry)) fail(`missing ${field} in ${entry.file ?? '<unknown>'}`);
  await canonicalPath(serverDirectory, entry.file);
  if (!KINDS.has(entry.kind) || !DISCOVERY.has(entry.discovery)) fail(`unknown classification for ${entry.file}`);
  if (!Array.isArray(entry.consumers) || !entry.consumers.every(value => typeof value === 'string') || new Set(entry.consumers).size !== entry.consumers.length) fail(`invalid consumers in ${entry.file}`);
  if (entry.reason !== canonicalReason(entry)) fail(`reason drift in ${entry.file}`);
  if (entry.kind === 'unit' && (entry.discovery !== 'pure-import' || entry.consumers.some(value => !value.startsWith('audit:')))) fail(`unit consumer mismatch for ${entry.file}`);
  if (entry.kind === 'harness-contract' && entry.discovery !== 'harness-contract') fail(`harness discovery mismatch for ${entry.file}`);
  if (entry.kind !== 'db') return;
  if (!BASELINE_VERSIONS.has(entry.baseline)) fail(`unsupported baseline for ${entry.file}`);
  if (!entry.consumers.length) fail(`DB consumer signature required for ${entry.file}`);
  if (entry.migrationsThrough !== null && (!Number.isInteger(entry.migrationsThrough) || entry.migrationsThrough < BASELINE_VERSIONS.get(entry.baseline))) fail(`invalid migration chain for ${entry.file}`);
  validateRegistry('customSchema', entry.customSchema, CUSTOM_SCHEMA, entry.file);
  validateRegistry('importTables', entry.importTables, IMPORT_TABLES, entry.file);
  validateRegistry('fixtures', entry.fixtures, FIXTURES, entry.file);
  validateSkips(entry.allowedSkips, entry.file);
  if (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 1_000 || entry.timeoutMs > 300_000) fail(`invalid timeoutMs in ${entry.file}`);
  if (typeof entry.serial !== 'boolean' || typeof entry.exclusive !== 'boolean' || (entry.serial && entry.exclusive)) fail(`invalid scheduling metadata in ${entry.file}`);
}

export async function loadManifest(manifest, { serverDirectory, discovered } = {}) {
  if (!serverDirectory) fail('serverDirectory required');
  const serverRoot = await realpath(serverDirectory);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('root must be an object');
  for (const field of Object.keys(manifest)) if (!TOP_FIELDS.has(field)) fail(`unknown field ${field}`);
  if (manifest.manifestVersion !== VERSION) fail(`unsupported manifestVersion ${manifest.manifestVersion}`);
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.harnessFixtures)) fail('entries and harnessFixtures must be arrays');
  const seen = new Set();
  for (const entry of manifest.entries) {
    await validateEntry(entry, serverRoot);
    if (seen.has(entry.file)) fail(`duplicate entry ${entry.file}`);
    seen.add(entry.file);
  }
  const fixtureSeen = new Set();
  for (const fixture of manifest.harnessFixtures) {
    if (fixtureSeen.has(fixture)) fail(`duplicate fixture ${fixture}`);
    fixtureSeen.add(fixture);
    if (seen.has(fixture)) fail(`fixture cannot also be a root entry: ${fixture}`);
    await canonicalPath(serverRoot, fixture, true);
  }
  if (discovered) {
    const scanned = new Map(discovered.map(item => [item.file, item]));
    for (const [file] of scanned) if (!seen.has(file)) fail(`missing root entry ${file}`);
    for (const entry of manifest.entries) {
      const actual = scanned.get(entry.file);
      if (!actual) fail(`stale manifest entry ${entry.file}`);
      if (entry.kind !== actual.kind || entry.discovery !== actual.discovery) fail(`classification drift in ${entry.file}: ${actual.kind}/${actual.discovery}`);
      if (!same(entry.consumers, actual.consumers)) fail(`consumer drift in ${entry.file}: expected [${entry.consumers}], discovered [${actual.consumers}]`);
    }
  }
  return manifest;
}
