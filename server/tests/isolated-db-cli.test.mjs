import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRunnerArgs, exitCodeForError, CLI_USAGE } from '../scripts/isolated-db/cli.mjs';

const rejects = (argv, pattern) => assert.throws(
  () => parseRunnerArgs(argv),
  error => error.exitCode === 2 && pattern.test(error.message),
);

test('defaults run the full selection with one job and no report', () => {
  assert.deepEqual(parseRunnerArgs([]), { list: false, jobs: 1, files: [], report: null });
});

test('accepts the documented options and repeatable --file', () => {
  const parsed = parseRunnerArgs([
    '--jobs', '2',
    '--file', 'tests/archive-read.test.mjs',
    '--file', 'tests/archive-store.test.mjs',
    '--report', 'reports/isolated.json',
  ]);
  assert.equal(parsed.jobs, 2);
  assert.deepEqual(parsed.files, ['tests/archive-read.test.mjs', 'tests/archive-store.test.mjs']);
  assert.equal(parsed.report, 'reports/isolated.json');
  assert.equal(parsed.list, false);
});

test('positional manifest paths stay accepted as the historical form', () => {
  const parsed = parseRunnerArgs(['tests/archive-read.test.mjs']);
  assert.deepEqual(parsed.files, ['tests/archive-read.test.mjs']);
});

test('--list runs alone and needs no database configuration', () => {
  assert.equal(parseRunnerArgs(['--list']).list, true);
  rejects(['--list', '--file', 'tests/archive-read.test.mjs'], /--list runs alone/);
  rejects(['--list', '--report', 'reports/x.json'], /--list runs alone/);
});

test('rejects unknown options, node flags and traversal before any child loads', () => {
  for (const argv of [
    ['--bogus'],
    ['--import=./evil.mjs'],
    ['--require=./evil.mjs'],
    ['--test-reporter=spec'],
    ['-e'],
    ['--file', '--jobs'],
    // Path traversal is rejected later, by the realpath check in the runner
    // (`approvedTestPath`), which owns filesystem containment rather than argv.
    ['--file', 'tests/archive-read.test.mjs.js'],
    ['tests/not-a-test.mjs'],
    [''],
  ]) {
    rejects(argv, /not approved|accepts only|unknown option|requires a value|empty argument/);
  }
});

test('rejects malformed job counts and duplicate reports', () => {
  for (const argv of [
    ['--jobs', '0'],
    ['--jobs', '-1'],
    ['--jobs', 'abc'],
    ['--jobs', '2.5'],
    ['--jobs', '9'],
    ['--jobs'],
    ['--report'],
    ['--report', 'a.json', '--report', 'b.json'],
  ]) {
    rejects(argv, /--jobs|--report/);
  }
});

test('usage text lists every supported option', () => {
  for (const option of ['--list', '--jobs', '--file', '--report']) {
    assert.match(CLI_USAGE, new RegExp(option));
  }
});

test('exit contract maps safety, infrastructure and configuration errors apart', () => {
  assert.equal(exitCodeForError(Object.assign(new Error('safety'), { code: 'ESAFETY' })), 3);
  assert.equal(exitCodeForError(Object.assign(new Error('closed'), { code: 'CLOSED_ERROR' })), 4);
  assert.equal(exitCodeForError(Object.assign(new Error('config'), { exitCode: 2 })), 2);
  assert.equal(exitCodeForError(new Error('assertion')), 1);
  assert.equal(exitCodeForError(undefined), 1);
});
