import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const DATABASE_NAMES = ['samosval_test', 'samosval_working_test_reserve', 'samosval_parallel_shifts_test'];
const EXTENSIONS = new Set(['.mjs', '.js', '.sql', '.json', '.yaml', '.yml', '.sh', '.md']);

function slash(path) {
  return path.split(sep).join('/');
}

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else if (EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) output.push(path);
  }
  return output;
}

function occurrences(source, pattern) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(pattern, offset)) !== -1) {
    count += 1;
    offset += pattern.length;
  }
  return count;
}

export async function auditHardcodedDatabaseNames(serverDirectoryInput, allowlist) {
  const serverDirectory = await realpath(serverDirectoryInput);
  const actual = [];
  for (const path of await walk(serverDirectory)) {
    const source = await readFile(path, 'utf8');
    const file = slash(relative(serverDirectory, path));
    for (const pattern of DATABASE_NAMES) {
      const count = occurrences(source, pattern);
      if (count) actual.push({ file, pattern, count });
    }
  }
  for (const allowed of allowlist) {
    if (!allowed.reason || !Number.isInteger(allowed.expectedCount)) throw new Error(`invalid hardcoded database allowlist entry for ${allowed.file}`);
    const match = actual.find(item => item.file === allowed.file && item.pattern === allowed.pattern);
    const count = match?.count ?? 0;
    if (count !== allowed.expectedCount) throw new Error(`hardcoded database count drift in ${allowed.file}: expected ${allowed.expectedCount}, found ${count}`);
  }
  for (const match of actual) {
    if (!allowlist.some(item => item.file === match.file && item.pattern === match.pattern)) throw new Error(`unallowlisted hardcoded database name ${match.pattern} in ${match.file}`);
  }
  return { matches: actual };
}
