import test from 'node:test';
import { appendFileSync } from 'node:fs';

test('records isolated runner child process', () => {
  appendFileSync(process.env.ISOLATED_DB_PROCESS_LOG, `${process.pid}\n`);
});
