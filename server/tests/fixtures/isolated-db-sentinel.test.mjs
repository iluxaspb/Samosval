import test from 'node:test';
import { writeFileSync } from 'node:fs';

if (process.env.ISOLATED_DB_SENTINEL) {
  writeFileSync(process.env.ISOLATED_DB_SENTINEL, `${Object.keys(process.env).sort().join('\n')}\n`);
}

test('isolated DB subprocess sentinel loads', () => {});
