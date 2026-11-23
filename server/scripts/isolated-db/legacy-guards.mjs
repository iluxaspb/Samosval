import { createHash } from 'node:crypto';
import { validateGeneratedIdentifier } from './safety.mjs';

const SAMOSVAL_TEST_SPACED = "current_database() <> 'samosval_test'";
const SAMOSVAL_TEST_COMPACT = "current_database()<>'samosval_test'";
const RESERVE_COMPACT = "current_database()<>'samosval_working_test_reserve'";

const definitions = {
  '002_tabel.sql': ['1801bcf5b60497f88d6a136fc225be122ffc71bab4fcc056c87b51a0d74c7af7', SAMOSVAL_TEST_SPACED],
  '003_shift_close.sql': ['114fc3c36bf92d97c061f296b6e214263a115960198947fcbc3ccbb0d68485c2', SAMOSVAL_TEST_SPACED],
  '004_objects.sql': ['780a6df2146101ddfe407f901b06317a0b3cbfd5eb907e813eaec1440faffc07', SAMOSVAL_TEST_SPACED],
  '005_controls.sql': ['4e88b2ce46211cd519f1f32b3b5c1973b3167c7a90560575ac6105d26866f88e', SAMOSVAL_TEST_SPACED],
  '006_identity.sql': ['7d03afcfdfcfb52509880bfc9130029728623f58f5e181df37512df14285fb9a', SAMOSVAL_TEST_COMPACT],
  '007_line_history.sql': ['40e15fac6d479771317741ec926f13103446313046715b84e6679dad390a3829', SAMOSVAL_TEST_COMPACT],
  '008_workspace_services.sql': ['e6ca65cf840c35bfcb06131a77ede32b803273ac621f5607e1c3251d24333518', SAMOSVAL_TEST_COMPACT],
  '009_auxiliary.sql': ['b17238a563887a6f3a0dca4446a722f27880eaff5c35aeb427b081ac203ed10a', SAMOSVAL_TEST_COMPACT],
  '010_reports.sql': ['234dc2971215c7cea1e1014e85b5e73c1389c867543bfb78b820d8f217a503a0', SAMOSVAL_TEST_COMPACT],
  '011_backups.sql': ['45654fff53912d451069cf414fa0ef6f7393c4a1525b267a376a7ec9142e1bb3', SAMOSVAL_TEST_COMPACT],
  '012_notifications.sql': ['12903ef44ff385fbb7180c05c8867c2745019bac683b428e78f596cb9d276a36', SAMOSVAL_TEST_COMPACT],
  '013_server_control.sql': ['a327c4625bf54721368ee753d565c2bf98b5b27b073d17dea771ae16d578af29', SAMOSVAL_TEST_COMPACT],
  '018_auth_credentials.sql': ['d08aaab0ad8d011d1f832cdb45daa902279eb6bf4dcf68facc453940893de5c3', RESERVE_COMPACT],
};

export const LEGACY_GUARDS = Object.freeze(Object.fromEntries(Object.entries(definitions).map(([filename, [checksum, source]]) => [filename, Object.freeze({
  filename, checksum, source, count: 1,
})])));

function exactOccurrences(source, needle) {
  const spans = [];
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    spans.push(offset);
    offset += needle.length;
  }
  return spans;
}

export function transformLegacyMigrationGuard(source, filename, database) {
  const guard = LEGACY_GUARDS[filename];
  if (!guard) {
    if (source.includes('current_database()')) throw new Error(`legacy guard unavailable: ${filename}`);
    return source;
  }
  validateGeneratedIdentifier(database);
  const checksum = createHash('sha256').update(source).digest('hex');
  if (checksum !== guard.checksum) throw new Error(`legacy migration checksum mismatch: ${filename}`);
  const spans = exactOccurrences(source, guard.source);
  if (spans.length !== guard.count) throw new Error(`legacy guard occurrence mismatch: ${filename}`);
  const replacement = guard.source.replace(/'[^']+'$/, `'${database}'`);
  let transformed = '';
  let cursor = 0;
  for (const start of spans) {
    transformed += source.slice(cursor, start) + replacement;
    cursor = start + guard.source.length;
  }
  return transformed + source.slice(cursor);
}
