import { writeFileSync } from 'node:fs';

if (process.env.npm_lifecycle_event === 'test:db' && process.env.ISOLATED_DB_SENTINEL) {
  writeFileSync(process.env.ISOLATED_DB_SENTINEL, 'NODE_OPTIONS executed in test:db lifecycle\n');
}
