import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEBUG_ACCOUNTS } from './seed-debug-accounts.mjs';

const source = readFileSync(new URL('./seed-debug-accounts.mjs', import.meta.url), 'utf8');

test('five debug accounts use the supported test roles and are marked hidden', () => {
  assert.deepEqual(DEBUG_ACCOUNTS.map(a => a.role), ['senior_foreman', 'foreman', 'master', 'lopater', 'viewer']);
  assert.equal(new Set(DEBUG_ACCOUNTS.map(a => a.email)).size, 5);
  assert.match(source, /debugAccount: true/);
});

test('seed copies the complete Firebase or local credential, without handling plaintext passwords', () => {
  assert.match(source, /SELECT password_hash,salt,algorithm,password_reset_required/);
  assert.match(source, /password_reset_required=EXCLUDED\.password_reset_required/);
  assert.match(source, /credential\.password_hash, credential\.salt, credential\.algorithm/);
  assert.doesNotMatch(source, /password\s*:\s*['\"]|console\.log\([^\n]*password/i);
});

test('seed has a production database guard and dry-run mode', () => {
  assert.match(source, /PRODUCTION_DATABASES\.has\(database\) && !options\.force/);
  assert.match(source, /options\.dryRun/);
});
