'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateBranch, validateChanges } = require('../../tools/github-pr.cjs');
test('reject protected branches and detached HEAD', () => {
  for (const branch of ['', 'root', 'docs/opencode-project-rules-20261031']) {
    assert.throws(() => validateBranch(branch));
  }
});
test('allow a separate task branch', () => {
  assert.doesNotThrow(() => validateBranch('feature/example'));
});
test('reject protected paths including renamed files', () => {
  for (const filename of ['index.html', 'app/src/main.js', 'server/db.sql', 'nas-preview/a',
    'firestore-v3.rules', '.env', 'secret.key', 'credentials.json']) {
    assert.throws(() => validateChanges([{ filename }]));
    assert.throws(() => validateChanges([{ filename: 'docs/moved.md', previous_filename: filename }]));
  }
});
test('reject empty and truncated comparisons', () => {
  assert.throws(() => validateChanges([]));
  assert.throws(() => validateChanges(Array(300).fill({ filename: 'docs/a.md' })));
});
test('allow workflow documentation and tooling', () => {
  assert.doesNotThrow(() => validateChanges([{ filename: 'tools/github-pr.cjs' },
    { filename: '.opencode/commands/github-pr.md' }, { filename: 'docs/GITHUB_WORKFLOW.md' }]));
});
