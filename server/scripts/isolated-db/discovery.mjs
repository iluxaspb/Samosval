import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT_RE = /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+|import\s*\()(['"])([^'"]+)\1/g;
const DB_ENV_RE = /\b(?:TEST_DATABASE_URL|DATABASE_URL|PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD)\b/;
const HTTP_CHILD_RE = /(?:spawn|fork)\s*\([^\n]*(?:src\/index\.mjs|server\/src\/index\.mjs)/;
const HARNESS_ROOTS = new Set([
  'compose-isolated-db.test.mjs',
  'isolated-db-guard.test.mjs',
  'isolated-db-integration.test.mjs',
  'isolated-db-runner.test.mjs'
]);
const AUDITED_PURE_ROOTS = new Set([
  'db-test-discovery.test.mjs',
  'db-test-manifest.test.mjs',
  'tabel-access.test.mjs',
  'updater.test.mjs'
]);

function slash(path) {
  return path.split(sep).join('/');
}

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(path));
    else output.push(path);
  }
  return output;
}

async function resolveImport(from, specifier) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const candidate = isAbsolute(specifier) ? specifier : resolve(dirname(from), specifier);
  for (const path of [candidate, `${candidate}.mjs`, `${candidate}.js`, join(candidate, 'index.mjs')]) {
    try {
      if ((await stat(path)).isFile()) return await realpath(path);
    } catch {}
  }
  return null;
}

function directConsumers(source, relativeFile) {
  const consumers = [];
  if (/from\s*['"]pg['"]|import\s*['"]pg['"]/.test(source)) consumers.push(`${relativeFile}:pg`);
  if (DB_ENV_RE.test(source)) consumers.push(`${relativeFile}:db-env`);
  if (HTTP_CHILD_RE.test(source)) consumers.push(`${relativeFile}:http-child`);
  return consumers;
}

export async function discoverTests(serverDirectoryInput) {
  const raw = serverDirectoryInput instanceof URL ? fileURLToPath(serverDirectoryInput) : serverDirectoryInput;
  const serverDirectory = await realpath(raw);
  const testsDirectory = join(serverDirectory, 'tests');
  const roots = (await readdir(testsDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => join(testsDirectory, entry.name))
    .sort();
  const sourceCache = new Map();
  async function scan(path, visited = new Set()) {
    const canonical = await realpath(path);
    if (visited.has(canonical)) return [];
    visited.add(canonical);
    let source = sourceCache.get(canonical);
    if (source === undefined) {
      source = await readFile(canonical, 'utf8');
      sourceCache.set(canonical, source);
    }
    const rel = slash(relative(serverDirectory, canonical));
    const consumers = directConsumers(source, rel);
    for (const match of source.matchAll(IMPORT_RE)) {
      if (match[2] === 'pg') continue;
      const dependency = await resolveImport(canonical, match[2]);
      if (dependency) consumers.push(...await scan(dependency, visited));
    }
    return [...new Set(consumers)].sort();
  }
  const discovered = [];
  for (const root of roots) {
    const source = await readFile(root, 'utf8');
    let consumers = await scan(root);
    const name = root.slice(root.lastIndexOf(sep) + 1);
    const hasHttp = HTTP_CHILD_RE.test(source);
    let kind = consumers.length ? 'db' : 'unit';
    let discovery = hasHttp ? 'indirect-http' : consumers.length ? 'direct' : 'pure-import';
    if (HARNESS_ROOTS.has(name)) {
      kind = 'harness-contract';
      discovery = 'harness-contract';
    } else if (AUDITED_PURE_ROOTS.has(name)) {
      kind = 'unit';
      discovery = 'pure-import';
      consumers = [];
    }
    discovered.push({ file: slash(relative(serverDirectory, root)), kind, discovery, consumers });
  }
  return { roots: discovered, scannedFiles: (await filesUnder(serverDirectory)).filter(file => ['.mjs', '.js'].includes(extname(file))).length };
}
