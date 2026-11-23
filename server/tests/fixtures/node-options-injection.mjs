import { writeFileSync } from 'node:fs';

if (process.env.ISOLATED_DB_SENTINEL) {
  writeFileSync(process.env.ISOLATED_DB_SENTINEL, 'NODE_OPTIONS preload executed\n');
}
