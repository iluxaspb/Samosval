import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const IMPORT_RE = /^\s*(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+)(['"])([^'"]+)\1/gm;
const PG_IMPORT_RE = /(?:^|;)\s*import\s+(?:[^'";]+?\s+from\s+)?['"]pg['"]/m;
const HARNESS_ROOTS = new Set(['compose-isolated-db.test.mjs', 'isolated-db-guard.test.mjs', 'isolated-db-integration.test.mjs', 'isolated-db-runner.test.mjs']);
const NON_DB_IMPORTS = new Map([['tests/updater.test.mjs', new Set(['../updater/agent.mjs'])]]);
const DB_ENV_RE = /process\.env\.(?:TEST_DATABASE_URL|DATABASE_URL|PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD)\b|process\.env\[['"](?:TEST_DATABASE_URL|DATABASE_URL|PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD)['"]\]/;
const HTTP_CHILD_RE = /\b(?:spawn|fork|execFile)\s*\([\s\S]{0,800}?(?:['"](?:server\/)?src\/index\.mjs['"]|\[\s*['"]src['"]\s*,\s*['"]index\.mjs['"]\s*\])/;
const DB_HELPER_RE = /tests\/helpers\/isolated-db\.mjs$/;

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
    else if (entry.isFile() || entry.isSymbolicLink()) {
      if (entry.name.endsWith('.test.mjs')) output.push(path);
    }
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

export async function discoverTests(serverDirectoryInput, { harnessFixtures = [] } = {}) {
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
  let candidates = await testFiles(testsDirectory);
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--', 'tests'], { cwd: serverDirectory });
    const visible = new Set(stdout.split('\n').filter(file => file.endsWith('.test.mjs')).map(file => resolve(serverDirectory, file)));
    candidates = candidates.filter(path => visible.has(path));
  } catch {}
  for (const path of candidates) {
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
    for (const match of source.matchAll(IMPORT_RE)) {
      if (match[2] === 'pg' || NON_DB_IMPORTS.get(rootFile)?.has(match[2])) continue;
      const dependency = await resolveImport(canonical, match[2], serverDirectory);
      if (dependency) consumers.push(...await scan(dependency, visited, rootFile));
    }
    return [...new Set(consumers)].sort();
  }
  const discovered = [];
  for (const root of roots) {
    const file = slash(relative(serverDirectory, root));
    const consumers = await scan(root, new Set(), file);
    const hasHttp = consumers.some(item => item.endsWith(':http-child'));
    const harness = HARNESS_ROOTS.has(file.slice(6));
    discovered.push({ file, kind: harness ? 'harness-contract' : consumers.length ? 'db' : 'unit', discovery: harness ? 'harness-contract' : hasHttp ? 'indirect-http' : consumers.length ? 'direct' : 'pure-import', consumers });
  }
  return { roots: discovered };
}
