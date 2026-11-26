import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC_IMPORT_RE = /(?:^|;)\s*(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+)(['"])([^'"]+)\1/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const ANY_DYNAMIC_IMPORT_RE = /\bimport\s*\(([^)]*)\)/g;
const PG_IMPORT_RE = /(?:^|;)\s*import\s+(?:[^'";]+?\s+from\s+)?['"]pg['"]|\bimport\s*\(\s*['"]pg['"]\s*\)/m;
const HARNESS_ROOTS = new Set(['compose-isolated-db.test.mjs', 'isolated-db-bootstrap.test.mjs', 'isolated-db-env.test.mjs', 'isolated-db-fixtures.test.mjs', 'isolated-db-guard.test.mjs', 'isolated-db-integration.test.mjs', 'isolated-db-lifecycle.test.mjs', 'isolated-db-process.test.mjs', 'isolated-db-runner.test.mjs', 'isolated-db-s25-fixtures.test.mjs', 'isolated-db-templates.test.mjs', 'parallel-shifts-runtime-roles.test.mjs']);
const DB_ENV_RE = /process\.env\.(?:TEST_DATABASE_URL|DATABASE_URL|PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|POSTGRES_DB|POSTGRES_USER|POSTGRES_PASSWORD)\b|process\.env\[['"](?:TEST_DATABASE_URL|DATABASE_URL|PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|POSTGRES_DB|POSTGRES_USER|POSTGRES_PASSWORD)['"]\]/;
const HTTP_CHILD_RE = /\b(?:spawn|fork|execFile)\s*\([\s\S]{0,800}?(?:['"](?:server\/)?src\/index\.mjs['"]|\[\s*['"]src['"]\s*,\s*['"]index\.mjs['"]\s*\])/;
const DB_HELPER_RE = /tests\/helpers\/isolated-db\.mjs$/;

export const CURRENT_AUDITED_DEPENDENCIES = Object.freeze({
  'tests/updater.test.mjs': Object.freeze({
    id: 'updater-release-only',
    dependency: '../updater/agent.mjs',
    expectedConsumers: Object.freeze(['updater/agent.mjs:db-env', 'updater/agent.mjs:pg'])
  })
});

function slash(path) { return path.split(sep).join('/'); }
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
async function testFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await testFiles(path));
    else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.test.mjs')) output.push(path);
  }
  return output;
}
async function resolveImport(from, specifier, serverDirectory) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const candidate = isAbsolute(specifier) ? specifier : resolve(dirname(from), specifier);
  for (const path of [candidate, `${candidate}.mjs`, `${candidate}.js`, join(candidate, 'index.mjs')]) {
    try {
      const canonical = await realpath(path);
      if ((await stat(canonical)).isFile() && inside(serverDirectory, canonical)) return canonical;
    } catch {}
  }
  return null;
}
function directConsumers(source, relativeFile) {
  const consumers = [];
  if (PG_IMPORT_RE.test(source)) consumers.push(`${relativeFile}:pg`);
  if (DB_ENV_RE.test(source)) consumers.push(`${relativeFile}:db-env`);
  if (HTTP_CHILD_RE.test(source)) consumers.push(`${relativeFile}:http-child`);
  if (DB_HELPER_RE.test(relativeFile)) consumers.push(`${relativeFile}:db-helper`);
  return consumers;
}
function literalImports(source) {
  const imports = [];
  for (const regex of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    regex.lastIndex = 0;
    for (const match of source.matchAll(regex)) imports.push(match[2]);
  }
  ANY_DYNAMIC_IMPORT_RE.lastIndex = 0;
  for (const match of source.matchAll(ANY_DYNAMIC_IMPORT_RE)) {
    if (!/^\s*(['"])[^'"]+\1\s*$/.test(match[1])) throw new Error('nonliteral dynamic import requires an audited exception');
  }
  return imports;
}
function same(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }

export async function discoverTests(serverDirectoryInput, { harnessFixtures = [], auditedDependencies = CURRENT_AUDITED_DEPENDENCIES } = {}) {
  const raw = serverDirectoryInput instanceof URL ? fileURLToPath(serverDirectoryInput) : serverDirectoryInput;
  const serverDirectory = await realpath(raw);
  const testsDirectory = await realpath(join(serverDirectory, 'tests'));
  const excluded = new Set();
  for (const fixture of harnessFixtures) {
    const lexical = resolve(serverDirectory, fixture);
    const canonical = await realpath(lexical);
    if (!inside(testsDirectory, canonical) || canonical !== lexical || !fixture.startsWith('tests/fixtures/')) throw new Error(`invalid canonical harness fixture ${fixture}`);
    excluded.add(canonical);
  }
  const roots = [];
  for (const path of await testFiles(testsDirectory)) {
    const canonical = await realpath(path);
    if (!inside(testsDirectory, canonical) || canonical !== path) throw new Error(`test root must be canonical and not a symlink: ${slash(relative(serverDirectory, path))}`);
    if (!excluded.has(canonical)) roots.push(canonical);
  }
  roots.sort((a, b) => slash(relative(serverDirectory, a)).localeCompare(slash(relative(serverDirectory, b))));
  const sourceCache = new Map();
  async function scan(path, visited = new Set(), rootFile = null) {
    const canonical = await realpath(path);
    if (visited.has(canonical)) return [];
    visited.add(canonical);
    let source = sourceCache.get(canonical);
    if (source === undefined) { source = await readFile(canonical, 'utf8'); sourceCache.set(canonical, source); }
    const rel = slash(relative(serverDirectory, canonical));
    const consumers = directConsumers(source, rel);
    for (const specifier of literalImports(source)) {
      if (specifier === 'pg') continue;
      const dependency = await resolveImport(canonical, specifier, serverDirectory);
      if (!dependency) continue;
      const audit = auditedDependencies[rootFile];
      if (audit && specifier === audit.dependency) {
        const actual = await scan(dependency, new Set(), null);
        if (!same(actual, audit.expectedConsumers)) throw new Error(`audited dependency drift ${audit.id}: expected [${audit.expectedConsumers}], discovered [${actual}]`);
        consumers.push(`audit:${audit.id}`);
      } else consumers.push(...await scan(dependency, visited, rootFile));
    }
    return [...new Set(consumers)].sort();
  }
  const discovered = [];
  for (const root of roots) {
    const file = slash(relative(serverDirectory, root));
    const consumers = await scan(root, new Set(), file);
    const hasHttp = consumers.some(item => item.endsWith(':http-child'));
    const harness = HARNESS_ROOTS.has(file.slice(6));
    discovered.push({ file, kind: harness ? 'harness-contract' : consumers.length && !consumers.every(item => item.startsWith('audit:')) ? 'db' : 'unit', discovery: harness ? 'harness-contract' : hasHttp ? 'indirect-http' : consumers.length && !consumers.every(item => item.startsWith('audit:')) ? 'direct' : 'pure-import', consumers });
  }
  return { roots: discovered };
}
