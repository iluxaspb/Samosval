import test from 'node:test';
import { writeFileSync } from 'node:fs';

if (process.env.ISOLATED_DB_SENTINEL) {
  writeFileSync(process.env.ISOLATED_DB_SENTINEL, 'loaded\n');
}

test('isolated DB subprocess sentinel loads', () => {});
