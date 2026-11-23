#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { requireIsolatedDatabase } from '../tests/helpers/isolated-db.mjs';

try {
  requireIsolatedDatabase(process.env.TEST_DATABASE_URL);
} catch (error) {
  console.error(`isolated database preflight failed: ${error.message}`);
  process.exit(1);
}

const serverDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const requested = process.argv.slice(2);
const testFiles = requested.length
  ? requested
  : readdirSync(join(serverDirectory, 'tests'))
      .filter(name => name.endsWith('.test.mjs'))
      .sort()
      .map(name => join('tests', name));
const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...testFiles],
  { cwd: serverDirectory, env: process.env, stdio: 'inherit' }
);
if (result.error) {
  console.error(`isolated test runner failed: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
