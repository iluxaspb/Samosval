#!/usr/bin/env node
import { readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { requireIsolatedDatabase } from '../tests/helpers/isolated-db.mjs';

try {
  requireIsolatedDatabase(process.env.TEST_DATABASE_URL);
} catch (error) {
  console.error(`isolated database preflight failed: ${error.message}`);
  process.exit(1);
}

const serverDirectory = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const testsDirectory = realpathSync(join(serverDirectory, 'tests'));
const requested = process.argv.slice(2);

function approvedTestPath(input) {
  if (typeof input !== 'string' || !input.endsWith('.test.mjs')) {
    throw new Error('test path is not approved');
  }
  let canonical;
  try {
    canonical = realpathSync(isAbsolute(input) ? input : resolve(serverDirectory, input));
  } catch {
    throw new Error('test path is not approved');
  }
  const inside = relative(testsDirectory, canonical);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('test path is not approved');
  }
  return canonical;
}

let testFiles;
try {
  testFiles = requested.length
    ? requested.map(approvedTestPath)
    : readdirSync(testsDirectory)
        .filter(name => name.endsWith('.test.mjs'))
        .sort()
        .map(name => approvedTestPath(join(testsDirectory, name)));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;
delete childEnv.NODE_PATH;
const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...testFiles],
  { cwd: serverDirectory, env: childEnv, stdio: 'inherit' }
);
if (result.error) {
  console.error(`isolated test runner failed: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
