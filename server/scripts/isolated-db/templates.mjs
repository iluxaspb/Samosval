import { GENERATED_DATABASE_PREFIX, validateGeneratedIdentifier } from './safety.mjs';

const OWNER = 'samosval_test_prepared_owner';
const MIGRATION_COUNT_THROUGH_24 = 22;
const REGISTRY_HASH = /^[a-f0-9]{64}$/;

function templateName(runid, suffix) {
  const database = `${GENERATED_DATABASE_PREFIX}${runid}_${suffix}`;
  validateGeneratedIdentifier(database, { runid, kind: 'template' });
  return database;
}

function templateComment(runid, kind, version, registryHash = 'empty') {
  return `samosval-isolated-db:v1;kind=template;runid=${runid};baseline=${kind};version=${version};registry=${registryHash};owner=${OWNER}`;
}

function verifyInspection(actual, expectedComment) {
  if (!actual || actual.owner !== OWNER || actual.comment !== expectedComment
      || actual.allowConnections !== false || actual.sessions !== 0) {
    throw new Error('template verification failed closed');
  }
}

function record(kind, database, source, version, registryHash, comment) {
  return Object.freeze({ kind, database, source, version, registryHash, owner: OWNER, comment, immutable: true });
}

export async function prepareTemplates(context) {
  if (!context || typeof context.templateOperation !== 'function'
      || typeof context.migrateTemplate !== 'function'
      || typeof context.inspectTemplate !== 'function') throw new Error('template context is not approved');
  const { runid, capability } = context;
  const empty = templateName(runid, 'tpl_empty');
  const s24 = templateName(runid, 'tpl_s24');
  const emptyComment = templateComment(runid, 'empty', 0);
  await context.templateOperation({ operation: 'createTemplate', database: empty, source: 'template0', runid, capability, comment: emptyComment });
  await context.templateOperation({ operation: 'freezeTemplate', database: empty, runid, capability, comment: emptyComment });
  verifyInspection(await context.inspectTemplate({ database: empty, runid, capability, comment: emptyComment }), emptyComment);

  await context.templateOperation({ operation: 'createTemplate', database: s24, source: empty, runid, capability, comment: null });
  const migration = await context.migrateTemplate({ database: s24, through: 24, runid, capability });
  if (!migration || migration.count !== MIGRATION_COUNT_THROUGH_24 || migration.version !== 24 || !REGISTRY_HASH.test(migration.registryHash)) {
    throw new Error('S24 migration registry verification failed closed');
  }
  const s24Comment = templateComment(runid, 'S24', 24, migration.registryHash);
  await context.templateOperation({ operation: 'freezeTemplate', database: s24, runid, capability, comment: s24Comment });
  verifyInspection(await context.inspectTemplate({ database: s24, runid, capability, comment: s24Comment }), s24Comment);

  return new Map([
    ['empty', record('empty', empty, 'template0', 0, 'empty', emptyComment)],
    ['S24', record('S24', s24, empty, 24, migration.registryHash, s24Comment)],
  ]);
}
