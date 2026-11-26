import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { GENERATED_DATABASE_PREFIX, MAX_RUNID_LENGTH } from '../scripts/isolated-db/safety.mjs';
import { createProvisioningBroker, createTemplateBroker, generateRunCapability } from '../scripts/isolated-db/admin.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { transformLegacyMigrationGuard } from '../scripts/isolated-db/legacy-guards.mjs';
import {
  TARGET_COMMENT_PREFIX, TARGET_OWNER, cleanupTarget, leakCheck, makeRunIdentity, makeTargetName,
  provisionTarget, recoverPartialTarget, targetComment, targetUrl,
} from '../scripts/isolated-db/database.mjs';
import { EXPECTED_S24_HASH, prepareTemplates, verifyS24Target, verifyTargetAuthority } from '../scripts/isolated-db/templates.mjs';
import manifest from './db-test-manifest.mjs';

const RUNID = '0123456789ab';
const PREFIX = `${GENERATED_DATABASE_PREFIX}${RUNID}`;
const digest = file => createHash('sha256').update(file).digest('hex').slice(0, 12);
const HASH_A = digest('tests/a.test.mjs');
const NAME_A = `${PREFIX}_${HASH_A}`;
const FILE_B = 'tests/second-file.test.mjs';
const NAME_B = `${PREFIX}_${digest(FILE_B)}`;
const TEMPLATE_NAMES = [`${PREFIX}_tpl_empty`, `${PREFIX}_tpl_s24`, `${PREFIX}_tpl_s25`];
const RESERVED_NAMES = ['postgres', 'template0', 'template1', 'samosval_test', 'samosval_working_test_reserve', 'samosval_parallel_shifts_test'];
const CAPABILITY = 'c'.repeat(64);
const TEMPLATE_COMMENT = `samosval-isolated-db:v1;kind=template;runid=${RUNID};baseline=S24;version=24;registry=${EXPECTED_S24_HASH};owner=${TARGET_OWNER}`;

function marker(name, runid = RUNID) {
  return `${TARGET_COMMENT_PREFIX}kind=target;runid=${runid};hash=${name.slice(-12)};owner=${TARGET_OWNER}`;
}

// A programmable stand-in for the dedicated bootstrap session. It answers the
// closed I2/I4 operations and lets a test mutate catalog truth (comment, owner,
// state, presence) between statements, so sequencing decisions are observable.
function session(initial = {}) {
  // templates is the frozen-template registry (clone sources); exists is the
  // pg_database catalog. A template enters the catalog only when a test puts
  // it there, so a leak check sees exactly what pg_database would show.
  const world = { exists: new Set(), owner: new Map(), comment: new Map(), state: new Map(), templates: new Set(), ...initial };
  const events = [];
  const hooks = { beforeDrop: null, beforeTerminate: null, afterAuthorize: null, onClone: null };
  let locked = false;
  const fingerprintOf = (w, n) => ({ databaseOid: n, ownerOid: TARGET_OWNER, ownerName: w.owner.get(n), commentText: w.comment.get(n) ?? '<absent>', commentHash: createHash('sha256').update(w.comment.get(n) ?? '').digest('hex'), receiptGeneration: '1', receiptState: w.state.get(n), capabilityBinding: 'b'.repeat(64) });
  const identityOf = (w, n) => ({ datname: n, owner: w.owner.get(n), comment: w.comment.get(n) ?? null, allow_connections: true });
  const receiptOf = (w, n) => ({ runid: RUNID, kind: 'target', receipt_state: w.state.get(n), expected_owner: TARGET_OWNER, database: n, owner: w.owner.get(n), comment: w.comment.get(n) ?? null });
  const client = {
    world, events, hooks,
    async query(config, valuesArgument) {
      const sql = String(config?.text ?? config);
      const name = (config?.values ?? valuesArgument)?.[0];
      if (sql.includes('pg_advisory_lock')) { assert.equal(locked, false, 'session fence must not be nested'); locked = true; events.push('lock'); return { rows: [{ locked: null }] }; }
      if (sql.includes('pg_advisory_unlock')) { assert.equal(locked, true, 'unlock without lock'); locked = false; events.push('unlock'); return { rows: [{ unlocked: true }] }; }
      if (sql.includes('reserve_target')) { events.push(['reserve', name]); if (world.exists.has(name) || world.state.has(name)) throw new Error('isolated target reservation rejected'); world.state.set(name, 'reserved'); return { rows: [] }; }
      if (sql.includes('mark_reserved_target')) {
        events.push(['mark', name]);
        if (world.state.get(name) !== 'reserved') throw new Error('isolated authority rejected');
        if (world.owner.get(name) !== TARGET_OWNER) throw new Error('isolated target identity mismatch');
        world.comment.set(name, marker(name));
        world.state.set(name, 'marked');
        return { rows: [{ comment: world.comment.get(name) }] };
      }
      if (sql.includes('terminate_exact_target')) {
        events.push(['terminate', name]);
        hooks.beforeTerminate?.(world, name);
        if (world.state.get(name) !== 'marked') throw new Error('isolated authority rejected');
        if (world.owner.get(name) !== TARGET_OWNER || world.comment.get(name) !== marker(name)) throw new Error('isolated target identity mismatch');
        return { rows: [{ terminate_exact_target: 0 }] };
      }
      if (sql.includes('authorize_drop_target')) {
        events.push(['authorize', name]);
        if (world.state.get(name) !== 'marked') throw new Error('isolated authority rejected');
        if (!world.exists.has(name) || world.owner.get(name) !== TARGET_OWNER || world.comment.get(name) !== marker(name)) throw new Error('isolated target identity mismatch');
        const fingerprint = fingerprintOf(world, name);
        hooks.afterAuthorize?.(world, name);
        return { rows: [{ fingerprint }] };
      }
      if (sql.includes('isolated-drop-revalidate')) { events.push(['revalidate', name]); return { rows: [{ fingerprint: world.exists.has(name) ? fingerprintOf(world, name) : null }] }; }
      if (sql.includes('isolated-target-identity')) { events.push(['identity', name]); return { rows: world.exists.has(name) ? [identityOf(world, name)] : [] }; }
      if (sql.includes('isolated-partial-receipt')) { events.push(['partial-receipt', name]); return { rows: world.state.has(name) && world.exists.has(name) ? [receiptOf(world, name)] : [] }; }
      if (sql.includes('authorize_partial_drop')) {
        events.push(['partial-authorize', name]);
        // Mirrors the SQL predicate: reserved receipt, exact owner, no marker.
        const ok = world.state.get(name) === 'reserved' && world.exists.has(name) && world.owner.get(name) === TARGET_OWNER && !world.comment.has(name);
        return { rows: ok ? [{ fingerprint: fingerprintOf(world, name) }] : [] };
      }
      if (sql.includes('starts_with(datname')) { events.push(['catalog', name]); return { rows: [...world.exists].map(database => ({ datname: database, owner: world.owner.get(database) ?? null, comment: world.comment.get(database) ?? null })) }; }
      if (/^CREATE DATABASE/.test(sql)) {
        const [, created, template] = /CREATE DATABASE "([^"]+)"(?: TEMPLATE "([^"]+)")?/.exec(sql);
        events.push(template ? ['clone', created, template] : ['create', created]);
        if (world.exists.has(created)) throw new Error('database already exists');
        if (template && !world.exists.has(template) && !world.templates.has(template)) throw new Error('source database does not exist');
        if (template && !world.templates.has(template)) throw new Error('source database is not a frozen template');
        world.exists.add(created);
        world.owner.set(created, 'samosval_test_bootstrap_admin');
        world.comment.delete(created);
        await hooks.onClone?.(world, created);
        return { rows: [] };
      }
      if (sql.startsWith('ALTER DATABASE') && sql.includes('OWNER TO')) { const target = /ALTER DATABASE "([^"]+)"/.exec(sql)[1]; events.push(['owner', target]); world.owner.set(target, TARGET_OWNER); return { rows: [] }; }
      if (sql.startsWith('GRANT CONNECT')) { events.push(['grant', /DATABASE "([^"]+)"/.exec(sql)[1]]); return { rows: [] }; }
      if (sql.startsWith('DROP DATABASE')) {
        const target = /DROP DATABASE "([^"]+)"/.exec(sql)[1];
        assert.equal(locked, true, 'DROP must run inside the held session fence');
        hooks.beforeDrop?.(world, target);
        events.push(['drop', target]);
        world.exists.delete(target); world.state.delete(target); world.owner.delete(target); world.comment.delete(target);
        return { rows: [] };
      }
      throw new Error(`unexpected statement in session double: ${sql.slice(0, 80)}`);
    },
    async end() { locked = false; events.push('end'); },
  };
  return client;
}

function context(client, overrides = {}) {
  const templates = overrides.templates ?? new Map([['S24', { kind: 'S24', database: `${PREFIX}_tpl_s24`, immutable: true }]]);
  return { bootstrapClient: client, runid: RUNID, capability: CAPABILITY, templates, ...overrides, templates };
}

const S24_TEMPLATE = new Set([`${PREFIX}_tpl_s24`]);
const kinds = client => client.events.map(event => Array.isArray(event) ? event[0] : event);
const destructive = client => client.events.some(event => Array.isArray(event) && ['drop', 'terminate'].includes(event[0]));
async function provisioned(client, file = 'tests/a.test.mjs') {
  const ctx = context(client);
  const record = (await provisionTarget(ctx, { file, baseline: 'S24' })).transition('running');
  client.events.length = 0;
  return { ctx, record };
}

test('run identity is cryptographic, bounded and never leaks the capability into transport', () => {
  const first = makeRunIdentity();
  const second = makeRunIdentity();
  assert.match(first.runid, /^[a-f0-9]{12,20}$/);
  assert.notEqual(first.runid, second.runid);
  assert.match(first.capability, /^[a-f0-9]{64}$/);
  assert.notEqual(first.capability, second.capability);
  assert.equal(first.prefix, `${GENERATED_DATABASE_PREFIX}${first.runid}`);
  assert.equal(Object.isFrozen(first), true);
  for (const value of [first.capability, second.capability]) {
    assert.equal(process.argv.includes(value), false);
    assert.equal(Object.values(process.env).includes(value), false);
  }
  assert.equal(MAX_RUNID_LENGTH, 20, 'a generated target name must fit NAMEDATALEN-1 for every accepted runid');
});

test('target name is the deterministic 12-hex digest of the canonical relative file path', () => {
  assert.equal(makeTargetName(RUNID, 'tests/a.test.mjs'), NAME_A);
  assert.equal(makeTargetName(RUNID, 'tests/a.test.mjs'), NAME_A);
  assert.notEqual(makeTargetName(RUNID, FILE_B), NAME_A);
  assert.equal(makeTargetName(RUNID, FILE_B), NAME_B);
  assert.equal(Buffer.byteLength(makeTargetName('a'.repeat(20), 'tests/x.test.mjs')), 63);
  for (const rejected of ['a.test.mjs', 'tests/../a.test.mjs', '/tests/a.test.mjs', 'tests//a.test.mjs', 'Tests/a.test.mjs', 'tests/a.txt', '', null, 42]) {
    assert.throws(() => makeTargetName(RUNID, rejected), /file path is not approved/i, String(rejected));
  }
  assert.throws(() => makeTargetName('short', 'tests/a.test.mjs'), /run identity is not approved/i);
});

test('target COMMENT is exact, carries no capability and no template kind', () => {
  const comment = targetComment(NAME_A, RUNID);
  assert.equal(comment, marker(NAME_A));
  assert.equal(comment, `samosval-isolated-db:v1;kind=target;runid=${RUNID};hash=${HASH_A};owner=${TARGET_OWNER}`);
  assert.doesNotMatch(comment, /kind=template/);
  assert.throws(() => targetComment(`${PREFIX}_tpl_s24`, RUNID), /identifier is not approved/i);
  assert.throws(() => targetComment(`${GENERATED_DATABASE_PREFIX}ffffffffffff_${HASH_A}`, RUNID), /identifier is not approved/i);
});

test('provision clones the frozen template inside one held fence and the record climbs monotonically', async () => {
  const client = session({ templates: new Set(S24_TEMPLATE) });
  const seen = [];
  const record = await provisionTarget(context(client, { onState: state => seen.push(state) }), { file: 'tests/a.test.mjs', baseline: 'S24' });
  assert.deepEqual(seen, ['creating', 'created', 'marked']);
  assert.equal(record.state, 'marked');
  assert.equal(record.database, NAME_A);
  assert.equal(record.comment, marker(NAME_A));
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.hasOwn(record, 'capability'), false);
  assert.equal(JSON.stringify(record).includes(CAPABILITY), false);
  const flat = kinds(client);
  assert.equal(flat[0], 'lock');
  assert.equal(flat.at(-1), 'unlock');
  assert.deepEqual(flat.slice(1, -1), ['reserve', 'clone', 'owner', 'grant', 'mark', 'identity']);
  assert.deepEqual(client.events.find(event => Array.isArray(event) && event[0] === 'clone').slice(1), [NAME_A, `${PREFIX}_tpl_s24`]);
  assert.equal(client.world.comment.get(NAME_A), marker(NAME_A));
});

test('child may start only from marked and running is reachable only from marked', async () => {
  const client = session({ templates: new Set(S24_TEMPLATE) });
  const record = await provisionTarget(context(client), { file: 'tests/a.test.mjs', baseline: 'S24' });
  const url = targetUrl(record, { host: '127.0.0.1', port: 55432 });
  assert.equal(new URL(url).pathname, `/${NAME_A}`);
  assert.equal(new URL(url).search, '');
  assert.equal(new URL(url).hash, '');
  assert.doesNotMatch(url, /postgresql:\/\/.*:[^@]*@/, 'a generated URL carries no credential on its own');
  const running = record.transition('running');
  assert.equal(running.state, 'running');
  assert.equal(record.state, 'marked', 'records are immutable; a transition returns a new record');
  assert.equal(running.database, record.database);
  for (const bad of ['marked', 'running', 'creating', 'created', undefined]) assert.throws(() => running.transition(bad), /transition is not approved/i);
  assert.throws(() => record.transition('created'), /transition is not approved/i);
  assert.throws(() => record.transition('runningx'), /transition is not approved/i);
  assert.throws(() => targetUrl({ ...record, state: 'created' }), /only from marked/i);
  assert.throws(() => targetUrl({ ...record, state: 'creating' }), /only from marked/i);
});

test('state below marked is never terminated or dropped by ordinary cleanup', async () => {
  for (const state of ['creating', 'created']) {
    const client = session({ templates: new Set(S24_TEMPLATE) });
    await provisionTarget(context(client), { file: 'tests/a.test.mjs', baseline: 'S24' });
    client.events.length = 0;
    await assert.rejects(cleanupTarget(context(client), { database: NAME_A, state }, { phase: 'timeout' }), error => error.code === 'ESAFETY' && /state/i.test(error.message));
    assert.equal(client.world.exists.has(NAME_A), true);
    assert.equal(destructive(client), false);
    assert.equal(client.events.at(-1), 'unlock');
  }
  const client = session();
  for (const state of [undefined, 'dropped', 'MARKED', 1]) {
    await assert.rejects(cleanupTarget(context(client), { database: NAME_A, state }, { phase: 'setup' }), /state is not approved/i);
  }
  assert.equal(client.events.length, 0);
});

test('provisioning is globally serialized: two sessions never overlap their fences', async () => {
  // Two dedicated bootstrap sessions are two independent brokers and two
  // independent session fences (one pending chain per session). Only the
  // global provisioning semaphore can still serialize the two clones, so a
  // shared peak counter inside onClone is what actually observes it.
  const clients = [session({ templates: new Set(S24_TEMPLATE) }), session({ templates: new Set(S24_TEMPLATE) })];
  let active = 0;
  let peak = 0;
  for (const client of clients) {
    client.hooks.onClone = async () => { active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active -= 1; };
  }
  const [a, b] = await Promise.all([
    provisionTarget(context(clients[0]), { file: 'tests/a.test.mjs', baseline: 'S24' }),
    provisionTarget(context(clients[1]), { file: FILE_B, baseline: 'S24' }),
  ]);
  assert.equal(peak, 1, 'clone/setup must hold the global provisioning semaphore across sessions');
  assert.notEqual(a.database, b.database);
  for (const client of clients) {
    const flat = kinds(client);
    assert.equal(flat.filter(kind => kind === 'lock').length, 1);
    assert.equal(flat.filter(kind => kind === 'unlock').length, 1);
    // Serialize each sequence and prove no fence opens before the previous one closed.
    let open = false;
    for (const kind of flat) {
      if (kind === 'lock') { assert.equal(open, false, 'nested fences'); open = true; }
      if (kind === 'unlock') { assert.equal(open, true); open = false; }
    }
    assert.equal(open, false);
  }
});

test('a failure before mark leaves the record below marked, performs no destructive query and always releases the fence', async () => {
  for (const failing of [
    sql => sql.includes('reserve_target'),
    sql => /^CREATE DATABASE/.test(sql),
    sql => sql.startsWith('GRANT CONNECT'),
    sql => sql.includes('mark_reserved_target'),
  ]) {
    const client = session({ templates: new Set(S24_TEMPLATE) });
    const inner = client.query;
    let remaining = 1;
    client.query = async (config, values) => { if (remaining > 0 && failing(String(config?.text ?? config))) { remaining -= 1; throw new Error('injected provisioning failure'); } return inner(config, values); };
    const seen = [];
    const error = await provisionTarget(context(client, { onState: state => seen.push(state) }), { file: 'tests/a.test.mjs', baseline: 'S24' }).then(() => null, reason => reason);
    assert.ok(error, 'provisioning must fail');
    assert.doesNotMatch(error.message, /c{64}|password|postgresql:\/\//i);
    assert.equal(seen.includes('marked'), false, 'the record must never claim marked after a failure');
    assert.equal(destructive(client), false, 'provisioning never cleans up on its own');
    assert.equal(client.events.at(-1), 'unlock');
  }
});

test('provision rejects unknown baselines, unfrozen templates and foreign templates before any SQL', async () => {
  const foreign = { kind: 'S24', database: `${GENERATED_DATABASE_PREFIX}ffffffffffff_tpl_s24`, immutable: true };
  for (const [spec, overrides, pattern] of [
    [{ file: 'tests/a.test.mjs', baseline: 'S26' }, {}, /baseline is not approved/i],
    [{ file: 'tests/a.test.mjs', baseline: 'S24' }, { templates: new Map() }, /template is not approved/i],
    [{ file: 'tests/a.test.mjs', baseline: 'S24' }, { templates: new Map([['S24', foreign]]) }, /template is not approved/i],
    [{ file: 'tests/a.test.mjs', baseline: 'S24' }, { templates: new Map([['S24', { kind: 'S24', database: `${PREFIX}_tpl_s24` }]]) }, /template is not approved/i],
    [{ file: 'tests/a.test.mjs', baseline: 'S24', template: 'x' }, {}, /unknown field/i],
  ]) {
    const client = session();
    await assert.rejects(provisionTarget(context(client, overrides), spec), pattern);
    assert.equal(client.events.length, 0, 'rejected before the first statement');
  }
});

test('cleanup revalidates exact identity inside one held fence, terminates only the exact target, then drops', async () => {
  const client = session({ templates: new Set(S24_TEMPLATE) });
  const { ctx, record } = await provisioned(client);
  const report = await cleanupTarget(ctx, record, { phase: 'assertion' });
  assert.equal(report.dropped, NAME_A);
  assert.equal(report.phase, 'assertion');
  assert.equal(Object.isFrozen(report), true);
  const flat = kinds(client);
  assert.equal(flat[0], 'lock');
  assert.equal(flat.at(-1), 'unlock');
  assert.deepEqual(flat.slice(1, -1), ['identity', 'terminate', 'authorize', 'revalidate', 'drop']);
  assert.deepEqual(client.events.find(event => Array.isArray(event) && event[0] === 'terminate').slice(1), [NAME_A]);
  assert.equal(client.world.exists.has(NAME_A), false);
  assert.equal(client.world.state.has(NAME_A), false);
});

test('cleanup runs for setup, running, assertion and timeout phases with the same fail-closed predicate', async () => {
  for (const phase of ['setup', 'running', 'assertion', 'timeout']) {
    const client = session({ templates: new Set(S24_TEMPLATE) });
    const { ctx, record } = await provisioned(client);
    const report = await cleanupTarget(ctx, record, { phase });
    assert.equal(report.phase, phase);
    assert.equal(report.dropped, NAME_A);
    assert.deepEqual(kinds(client).slice(1, -1), ['identity', 'terminate', 'authorize', 'revalidate', 'drop']);
  }
  const client = session({ templates: new Set(S24_TEMPLATE) });
  const { ctx, record } = await provisioned(client);
  await assert.rejects(cleanupTarget(ctx, record, { phase: 'success' }), /phase is not approved/i);
  assert.equal(destructive(client), false);
  await assert.rejects(cleanupTarget(ctx, record, { phase: 'setup', force: true }), /cleanup options are not approved/i);
  assert.equal(destructive(client), false);
});

test('cleanup is idempotent: a second call for an already dropped target has nothing to destroy', async () => {
  const client = session({ templates: new Set(S24_TEMPLATE) });
  const { ctx, record } = await provisioned(client);
  assert.equal((await cleanupTarget(ctx, record, { phase: 'setup' })).dropped, NAME_A);
  client.events.length = 0;
  const again = await cleanupTarget(ctx, record, { phase: 'setup' });
  assert.equal(again.dropped, null);
  assert.equal(destructive(client), false);
});

test('changed_marker_fails_closed', async () => {
  const client = session({ templates: new Set(S24_TEMPLATE) });
  const { ctx, record } = await provisioned(client);
  client.world.comment.set(NAME_A, `samosval-isolated-db:v1;kind=target;runid=ffffffffffff;hash=${HASH_A};owner=${TARGET_OWNER}`);
  await assert.rejects(cleanupTarget(ctx, record, { phase: 'setup' }), error => error.code === 'ESAFETY' && /identity/i.test(error.message));
  assert.equal(client.world.exists.has(NAME_A), true, 'a changed marker must leave the database untouched');
  assert.equal(destructive(client), false, 'no destructive query after a marker change');
  assert.equal(client.events.at(-1), 'unlock');
});

test('changed owner, missing marker, template marker and changed prefix fail closed before any destructive query', async () => {
  for (const [label, mutate] of [
    ['owner', w => w.owner.set(NAME_A, 'samosval_test_bootstrap_admin')],
    ['missing marker', w => w.comment.delete(NAME_A)],
    ['template marker', w => w.comment.set(NAME_A, TEMPLATE_COMMENT)],
  ]) {
    const client = session({ templates: new Set(S24_TEMPLATE) });
    const { ctx, record } = await provisioned(client);
    mutate(client.world);
    await assert.rejects(cleanupTarget(ctx, record, { phase: 'assertion' }), error => error.code === 'ESAFETY' && /identity/i.test(error.message), label);
    assert.equal(client.world.exists.has(NAME_A), true, label);
    assert.equal(destructive(client), false, label);
    assert.equal(client.events.at(-1), 'unlock', label);
  }
  const client = session({ templates: new Set(S24_TEMPLATE), exists: new Set([...TEMPLATE_NAMES, ...RESERVED_NAMES]) });
  await provisionTarget(context(client), { file: 'tests/a.test.mjs', baseline: 'S24' });
  const before = client.world.exists.size;
  for (const name of [...TEMPLATE_NAMES, ...RESERVED_NAMES, `${GENERATED_DATABASE_PREFIX}ffffffffffff_${HASH_A}`, `${NAME_A}x`, NAME_A.toUpperCase(), 'samosval_parallel_shifts_test']) {
    for (const state of ['running', 'marked']) {
      await assert.rejects(cleanupTarget(context(client), { database: name, state }, { phase: 'setup' }), error => error.code === 'ESAFETY', `${name} (${state})`);
    }
  }
  assert.equal(client.world.exists.size, before, 'no reserved or template database was dropped');
  assert.equal(destructive(client), false);
});

test('cleanup_revalidates_identity_after_toctou', async () => {
  // The mutation lands after the first identity reread and before the
  // destructive phase: the next check must catch it inside the same fence.
  for (const [label, mutate, expected] of [
    ['marker', (w, name) => w.comment.set(name, 'competing replacement'), ['identity', 'terminate']],
    ['owner', (w, name) => w.owner.set(name, 'samosval_test_orchestrator'), ['identity', 'terminate']],
    ['state', (w, name) => w.state.set(name, 'reserved'), ['identity', 'terminate']],
  ]) {
    const client = session({ templates: new Set(S24_TEMPLATE) });
    const { ctx, record } = await provisioned(client);
    let mutated = 0;
    client.hooks.beforeTerminate = w => { mutated += 1; mutate(w, NAME_A); };
    await assert.rejects(cleanupTarget(ctx, record, { phase: 'setup' }), error => error.code === 'ESAFETY', label);
    assert.equal(mutated, 1, `${label}: the first reread must have passed`);
    assert.equal(client.world.exists.has(NAME_A), true, `${label}: TOCTOU must leave the database untouched`);
    assert.deepEqual(kinds(client).slice(1, -1), expected, label);
    assert.equal(client.events.at(-1), 'unlock', label);
  }
});

test('identity drift caught by the drop phase is a safety verdict: ESAFETY, not an infrastructure error', async () => {
  // The same drift is ESAFETY when the terminate phase sees it. A drift one
  // statement later (the drop authority, or the reread after it) must carry
  // the same verdict, so a consumer never tells a leak from a broken session.
  const client = session({ templates: new Set(S24_TEMPLATE) });
  const { ctx, record } = await provisioned(client);
  client.hooks.afterAuthorize = w => { w.owner.set(NAME_A, 'samosval_test_orchestrator'); };
  await assert.rejects(cleanupTarget(ctx, record, { phase: 'setup' }), error => error.code === 'ESAFETY');
  assert.equal(client.world.exists.has(NAME_A), true);
  assert.equal(client.events.some(event => Array.isArray(event) && event[0] === 'drop'), false);
  assert.equal(client.events.at(-1), 'unlock');
});

test('a connection break in the drop phase is an infrastructure failure: CLOSED_ERROR, never a safety verdict', async () => {
  const client = session({ templates: new Set(S24_TEMPLATE) });
  const { ctx, record } = await provisioned(client);
  const inner = client.query;
  let dead = false;
  // A lost connection fails every later statement of the session, the fence
  // release included; only ending the dedicated session clears the lock.
  client.query = async (config, values) => {
    if (dead || String(config?.text ?? config).includes('authorize_drop_target')) { dead = true; throw new Error('Connection terminated unexpectedly'); }
    return inner(config, values);
  };
  await assert.rejects(cleanupTarget(ctx, record, { phase: 'setup' }), error => error.code !== 'ESAFETY' && /failed closed/i.test(error.message));
  assert.equal(client.world.exists.has(NAME_A), true, 'nothing was destroyed by an infrastructure failure');
  assert.equal(client.events.some(event => Array.isArray(event) && event[0] === 'drop'), false);
  assert.equal(client.events.at(-1), 'end', 'the dedicated session is closed to clear the fence');
});

test('a session-fence release failure closes the dedicated session', async () => {
  const client = session({ templates: new Set(S24_TEMPLATE) });
  const { ctx, record } = await provisioned(client);
  const inner = client.query;
  client.query = async (config, values) => { if (String(config?.text ?? config).includes('pg_advisory_unlock')) throw new Error('injected unlock failure'); return inner(config, values); };
  await assert.rejects(cleanupTarget(ctx, record, { phase: 'setup' }), /failed closed/i);
  assert.equal(client.events.at(-1), 'end');
});

async function partial(client, file = 'tests/a.test.mjs') {
  // reserve + clone + owner succeeded, the grant failed: the object exists
  // with a "reserved" receipt and is therefore stuck below "marked".
  const inner = client.query;
  let remaining = 1;
  client.query = async (config, values) => { if (remaining > 0 && String(config?.text ?? config).startsWith('GRANT CONNECT')) { remaining -= 1; throw new Error('injected provisioning failure'); } return inner(config, values); };
  const error = await provisionTarget(context(client), { file, baseline: 'S24' }).then(() => null, reason => reason);
  assert.ok(error, 'provisioning must fail');
  client.query = inner;
  client.events.length = 0;
}

test('partial-create recovery drops only a receipt-proven reserved target of the same run', async () => {
  const client = session({ templates: new Set(S24_TEMPLATE) });
  const ctx = context(client);
  await partial(client);
  assert.equal(client.world.exists.has(NAME_A), true);
  assert.equal(client.world.state.get(NAME_A), 'reserved');
  const report = await recoverPartialTarget(ctx, { database: NAME_A, runid: RUNID });
  assert.equal(report.recovered, NAME_A);
  assert.equal(Object.isFrozen(report), true);
  const flat = kinds(client);
  assert.equal(flat[0], 'lock');
  assert.equal(flat.at(-1), 'unlock');
  assert.deepEqual(flat.slice(1, -1), ['partial-receipt', 'partial-authorize', 'revalidate', 'drop']);
  assert.equal(client.world.exists.has(NAME_A), false);
  assert.equal(client.world.state.has(NAME_A), false);
});

test('partial-create recovery fails closed without a same-run reserved receipt or with a drifted identity', async () => {
  const cases = [
    ['no receipt', () => {}, c => c.world.state.delete(NAME_A), /receipt/i],
    ['marked receipt is not partial', () => {}, c => { c.world.comment.set(NAME_A, marker(NAME_A)); c.world.state.set(NAME_A, 'marked'); }, /receipt/i],
    ['database vanished', () => {}, c => c.world.exists.delete(NAME_A), /receipt/i],
    ['owner drifted', () => {}, c => c.world.owner.set(NAME_A, 'samosval_test_orchestrator'), /identity/i],
    ['marker present', () => {}, c => c.world.comment.set(NAME_A, 'unexpected'), /identity/i],
    ['foreign runid', () => {}, () => {}, /identifier is not approved/i],
  ];
  for (const [label, , mutate, pattern] of cases) {
    const client = session({ templates: new Set(S24_TEMPLATE) });
    await partial(client);
    mutate(client);
    const database = label === 'foreign runid' ? `${GENERATED_DATABASE_PREFIX}ffffffffffff_${HASH_A}` : NAME_A;
    await assert.rejects(recoverPartialTarget(context(client), { database, runid: RUNID }), pattern, label);
    assert.equal(client.events.some(event => Array.isArray(event) && event[0] === 'drop'), false, `${label}: no DROP`);
  }
  for (const name of [...TEMPLATE_NAMES, ...RESERVED_NAMES]) {
    const client = session();
    await assert.rejects(recoverPartialTarget(context(client), { database: name, runid: RUNID }), /identifier is not approved/i);
    assert.equal(client.events.length, 0);
  }
  const client = session();
  await assert.rejects(recoverPartialTarget(context(client), { database: NAME_A, runid: RUNID, force: true }), /unknown field/i);
  assert.equal(client.events.length, 0);
});

test('leak check unions tracked names with the prefix catalog, validates each hit and never destroys', async () => {
  const client = session({ templates: new Set(S24_TEMPLATE) });
  const ctx = context(client);
  const a = await provisionTarget(ctx, { file: 'tests/a.test.mjs', baseline: 'S24' });
  await cleanupTarget(ctx, a, { phase: 'setup' });
  client.world.exists.add(NAME_B); // foreign object under our prefix: no receipt, no marker
  client.events.length = 0;
  const report = await leakCheck(ctx, { tracked: [a] });
  assert.equal(report.clean, false);
  assert.deepEqual(report.leaks.map(leak => leak.database), [NAME_B]);
  assert.equal(report.leaks[0].reason, 'identity');
  assert.equal(Object.isFrozen(report), true);
  assert.deepEqual(client.events.find(event => Array.isArray(event) && event[0] === 'catalog').slice(1), [PREFIX]);
  assert.equal(destructive(client), false, 'a leak check never destroys');
});

test('leak check distinguishes a tracked target still present, a template and a clean run', async () => {
  const client = session({ templates: new Set(S24_TEMPLATE) });
  const ctx = context(client);
  const a = await provisionTarget(ctx, { file: 'tests/a.test.mjs', baseline: 'S24' });
  const tracked = await leakCheck(ctx, { tracked: [a] });
  assert.deepEqual(tracked.leaks.map(leak => [leak.database, leak.reason]), [[NAME_A, 'tracked target still present']]);
  await cleanupTarget(ctx, a, { phase: 'setup' });
  assert.deepEqual(await leakCheck(ctx, { tracked: [a] }), Object.freeze({ type: 'samosval-leak-report:v1', clean: true, leaks: Object.freeze([]) }));
  client.world.exists.add(`${PREFIX}_tpl_s24`);
  client.world.owner.set(`${PREFIX}_tpl_s24`, TARGET_OWNER);
  client.world.comment.set(`${PREFIX}_tpl_s24`, TEMPLATE_COMMENT);
  const withTemplate = await leakCheck(ctx, { tracked: [a] });
  assert.equal(withTemplate.clean, false);
  assert.deepEqual(withTemplate.leaks.map(leak => [leak.database, leak.reason]), [[`${PREFIX}_tpl_s24`, 'template']]);
});

test('leak entries carry names and reasons only, never a URL, password or capability', async () => {
  const client = session({ exists: new Set([NAME_B]), owner: new Map([[NAME_B, 'someone']]) });
  const report = await leakCheck(context(client), { tracked: [] });
  assert.equal(JSON.stringify(report).includes(CAPABILITY), false);
  assert.doesNotMatch(JSON.stringify(report), /postgresql:\/\//);
  assert.deepEqual(Object.keys(report.leaks[0]).sort(), ['database', 'reason']);
});

test('leak check rejects records and options that are not exact generated names of the run', async () => {
  const client = session();
  for (const record of [
    { database: 'postgres', state: 'running' },
    { database: `${PREFIX}_tpl_s24`, state: 'running' },
    { database: `${GENERATED_DATABASE_PREFIX}ffffffffffff_${HASH_A}`, state: 'running' },
    { database: NAME_A, state: 'creating' },
  ]) {
    await assert.rejects(leakCheck(context(client), { tracked: [record] }), /not approved/i, record.database);
  }
  await assert.rejects(leakCheck(context(client), { tracked: [{ database: NAME_A, state: 'running' }], extra: true }), /not approved/i);
  assert.equal(client.events.length, 0);
});

test('the closed provisioning broker grows only the enumerated I4 operations and still rejects raw SQL', async () => {
  const capability = generateRunCapability();
  const client = session({ templates: new Set(S24_TEMPLATE) });
  const broker = createProvisioningBroker({ bootstrapClient: client });

  // The complete approved surface: the I2 pair plus exactly four I4 operations.
  // Each of them passes validation (and so reaches a statement).
  const approved = {
    createReservedTarget: { operation: 'createReservedTarget', database: NAME_A, runid: RUNID, capability },
    dropReservedTarget: { operation: 'dropReservedTarget', database: NAME_A, runid: RUNID, capability },
    cloneTarget: { operation: 'cloneTarget', database: NAME_B, runid: RUNID, template: `${PREFIX}_tpl_s24`, capability },
    cleanupTarget: { operation: 'cleanupTarget', database: NAME_B, runid: RUNID, capability, state: 'running' },
    recoverTarget: { operation: 'recoverTarget', database: NAME_B, runid: RUNID, capability },
    listRunDatabases: { operation: 'listRunDatabases', runid: RUNID },
  };
  for (const [operation, request] of Object.entries(approved)) {
    client.events.length = 0;
    await broker.run(request).catch(() => {});
    assert.ok(client.events.length > 0, `${operation} is an approved operation`);
  }

  // Anything outside that surface is refused before the first statement.
  client.events.length = 0;
  for (const operation of ['sql', 'terminateReservedTarget', 'terminate', 'dropDatabase', 'commentDatabase', 'createTemplate', 'freezeTemplate', 'clone', undefined]) {
    await assert.rejects(broker.run({ ...approved.cleanupTarget, operation }), /not approved/i, String(operation));
  }
  for (const request of [
    { operation: 'sql', sql: 'DROP DATABASE postgres', database: NAME_A, runid: RUNID, capability },
    { operation: 'cloneTarget', database: NAME_A, runid: RUNID, capability },
    { operation: 'cloneTarget', database: NAME_A, runid: RUNID, template: 'template0', capability },
    { operation: 'cloneTarget', database: `${PREFIX}_tpl_s24`, runid: RUNID, template: `${PREFIX}_tpl_s24`, capability },
    { operation: 'cloneTarget', database: NAME_A, runid: RUNID, template: `${GENERATED_DATABASE_PREFIX}ffffffffffff_tpl_s24`, capability },
    { operation: 'cloneTarget', database: NAME_A, runid: RUNID, template: `${PREFIX}_tpl_s24`, capability, comment: 'x' },
    { operation: 'cloneTarget', database: NAME_A, runid: RUNID, template: `${PREFIX}_tpl_s24` },
    { operation: 'cloneTarget', database: NAME_A, runid: RUNID, template: `${PREFIX}_tpl_s24`, capability, onState: 'not a function' },
    { operation: 'cleanupTarget', database: NAME_A, runid: RUNID, capability, template: `${PREFIX}_tpl_s24` },
    { operation: 'cleanupTarget', database: 'postgres', runid: RUNID, capability },
    { operation: 'listRunDatabases', runid: RUNID, capability },
  ]) await assert.rejects(broker.run(request), /not approved/i);
  assert.equal(client.events.length, 0, 'rejected before the first statement');
});

test('lifecycle context rejects anything beyond the closed orchestration surface before any SQL', async () => {
  const client = session({ templates: new Set(S24_TEMPLATE) });
  for (const [ctx, pattern] of [
    [context(client, { capability: 'short' }), /not approved/i],
    [context(client, { runid: 'short' }), /not approved/i],
    [context(client, { templates: new Map([['S24', { kind: 'S24', database: `${PREFIX}_tpl_s24`, immutable: true, extra: 1 }]]) }), /not approved/i],
    [{ runid: RUNID, capability: CAPABILITY, templates: new Map() }, /not approved/i],
  ]) {
    await assert.rejects(provisionTarget(ctx, { file: 'tests/a.test.mjs', baseline: 'S24' }), pattern);
  }
  assert.equal(client.events.length, 0);
});

test('every manifest DB baseline maps onto a prepared template kind and the target comment is never a template comment', () => {
  const baselines = new Set(manifest.entries.filter(entry => entry.kind === 'db').map(entry => entry.baseline));
  assert.deepEqual([...baselines].sort(), ['S24']);
  for (const baseline of baselines) assert.ok(['empty', 'S24'].includes(baseline));
  assert.notEqual(TEMPLATE_COMMENT, targetComment(NAME_A, RUNID));
  assert.equal(TEMPLATE_COMMENT.startsWith(`${TARGET_COMMENT_PREFIX}kind=template;`), true);
});

test('bootstrap.sql keeps the target cleanup predicate and the partial-create predicate apart', () => {
  const sql = readFileSync(new URL('../scripts/isolated-db/bootstrap.sql', import.meta.url), 'utf8');
  const dropStart = sql.indexOf('CREATE OR REPLACE FUNCTION samosval_isolated_admin.authorize_drop_target');
  const partialStart = sql.indexOf('CREATE OR REPLACE FUNCTION samosval_isolated_admin.authorize_partial_drop');
  const drop = sql.slice(dropStart, partialStart);
  assert.match(drop, /receipt\.state <> 'marked'/);
  assert.doesNotMatch(drop, /'reserved'/, 'ordinary drop authority must never accept a reserved receipt');
  const partialDrop = sql.slice(partialStart, sql.indexOf('ALTER FUNCTION samosval_isolated_admin.reserve_target'));
  assert.match(partialDrop, /receipt\.state <> 'reserved'/);
  assert.doesNotMatch(partialDrop, /'marked'/, 'partial recovery authority must never accept a marked receipt');
  assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION[\\s\\S]*authorize_partial_drop\\(text,text\\)[\\s\\S]*TO samosval_test_orchestrator`));
});

const bootstrapUrl = process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;
const appPassword = process.env.SAMOSVAL_TEST_APP_PASSWORD;
const runtimePassword = process.env.SAMOSVAL_TEST_RUNTIME_PASSWORD;
const real = { skip: !bootstrapUrl || !appPassword || !runtimePassword ? 'SAMOSVAL_TEST_BOOTSTRAP_URL, SAMOSVAL_TEST_APP_PASSWORD and SAMOSVAL_TEST_RUNTIME_PASSWORD are required' : false };

// Frozen S24 for real clones. Migration and ownership transfer mirror the I3
// real template test; the trusted verifiers stay the accept authority.
async function frozenTemplates(admin, identity) {
  const urlFor = database => { const u = new URL(bootstrapUrl); u.pathname = `/${database}`; return u.href; };
  const broker = createTemplateBroker({ bootstrapClient: admin, runid: identity.runid, capability: identity.capability });
  return prepareTemplates({
    runid: identity.runid,
    templateOperation: request => broker.run({ ...request, capability: identity.capability }),
    async migrateTemplate({ database, through }) {
      const pool = new pg.Pool({ connectionString: urlFor(database), max: 1 });
      try {
        await applyMigrations(pool, { through, transformSource: (source, file) => transformLegacyMigrationGuard(source, file, database) });
        await pool.query(`ALTER SCHEMA public OWNER TO ${TARGET_OWNER}`);
        await pool.query(`DO $own$ DECLARE item record; BEGIN FOR item IN SELECT c.relkind,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') LOOP EXECUTE format(CASE WHEN item.relkind='S' THEN 'ALTER SEQUENCE public.%I OWNER TO ${TARGET_OWNER}' ELSE 'ALTER TABLE public.%I OWNER TO ${TARGET_OWNER}' END,item.relname); END LOOP; END $own$`);
        await pool.query(`DO $fn$ DECLARE item record; BEGIN FOR item IN SELECT p.proname, pg_get_function_identity_arguments(p.oid) args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' LOOP EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO ${TARGET_OWNER}', item.proname, item.args); END LOOP; END $fn$`);
      } finally { await pool.end(); }
    },
    async queryTemplate(database, text, values) { const c = new pg.Client({ connectionString: urlFor(database) }); try { await c.connect(); return await c.query(text, values); } finally { await c.end(); } },
    async queryCatalog(text, values) { return admin.query(text, values); },
  });
}

async function withRealRun(work, { templates = true } = {}) {
  const identity = makeRunIdentity();
  const admin = new pg.Client({ connectionString: bootstrapUrl, application_name: 'i4_lifecycle_admin' });
  await admin.connect();
  const ctx = { bootstrapClient: admin, runid: identity.runid, capability: identity.capability, templates: new Map() };
  try {
    if (templates) ctx.templates = await frozenTemplates(admin, identity);
    return await work({ identity, admin, ctx });
  } finally {
    // Test-side privileged teardown. The suite's own leak check is asserted
    // before this point; anything still present here is a defect under test.
    const prefix = `${GENERATED_DATABASE_PREFIX}${identity.runid}_`;
    for (const row of (await admin.query('SELECT datname FROM pg_database WHERE starts_with(datname, $1)', [prefix])).rows) await admin.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`).catch(() => {});
    await admin.query('DELETE FROM samosval_isolated_admin.target_receipts WHERE runid=$1', [identity.runid]).catch(() => {});
    await admin.end();
  }
}

async function appClient(database, role, password) {
  const url = new URL(bootstrapUrl);
  url.pathname = `/${database}`;
  url.username = role;
  url.password = password;
  const client = new pg.Client({ connectionString: url.href });
  client.on('error', () => {});
  await client.connect();
  return client;
}

const catalogRow = (admin, database) => admin.query(`SELECT d.datname, owner.rolname owner, description.description comment FROM pg_database d JOIN pg_roles owner ON owner.oid=d.datdba LEFT JOIN pg_shdescription description ON description.objoid=d.oid AND description.classoid='pg_catalog.pg_database'::pg_catalog.regclass WHERE d.datname=$1`, [database]).then(result => result.rows[0]);

test('real PostgreSQL: two targets cloned from frozen S24 are independent and both clean up', { skip: real.skip }, async () => {
  await withRealRun(async ({ ctx }) => {
    const a = await provisionTarget(ctx, { file: 'tests/a.test.mjs', baseline: 'S24' });
    const b = await provisionTarget(ctx, { file: FILE_B, baseline: 'S24' });
    assert.equal(a.state, 'marked');
    assert.deepEqual([a.database, b.database], [`${GENERATED_DATABASE_PREFIX}${ctx.runid}_${digest('tests/a.test.mjs')}`, `${GENERATED_DATABASE_PREFIX}${ctx.runid}_${digest(FILE_B)}`]);
    const row = await catalogRow(ctx.bootstrapClient, a.database);
    assert.deepEqual(row, { datname: a.database, owner: TARGET_OWNER, comment: a.comment });
    const appA = await appClient(a.database, 'samosval_test_app', appPassword);
    const appB = await appClient(b.database, 'samosval_test_app', appPassword);
    const runtimeB = await appClient(b.database, 'samosval_test_runtime', runtimePassword);
    try {
      for (const client of [appA, appB]) {
        assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, client === appA ? a.database : b.database);
      }
      // The trusted verifiers read catalog tables (schema_migrations) that the
      // test role holds no privilege on by design; they run on a privileged
      // connection bound to the target database, never on the app session.
      const bound = async (database, work) => {
        const url = new URL(bootstrapUrl); url.pathname = `/${database}`;
        const c = new pg.Client({ connectionString: url.href });
        await c.connect();
        try { return await work(c); } finally { await c.end(); }
      };
      for (const target of [a.database, b.database]) {
        await bound(target, c => verifyS24Target((text, values) => c.query(text, values)));
        await bound(target, c => verifyTargetAuthority((text, values) => c.query(text, values)));
      }
      // Sentinel isolation: a schema change in one target is invisible in the
      // other. The test role holds no object privilege on a fresh clone
      // (authority contract), so the sentinel DDL runs on the bound owner session.
      await bound(a.database, c => c.query('CREATE TABLE public.sentinel_a(id int PRIMARY KEY)'));
      await assert.rejects(bound(b.database, c => c.query('SELECT count(*)::int n FROM public.sentinel_a')), /does not exist/i);
      await bound(b.database, c => c.query('CREATE TABLE public.sentinel_b(id int PRIMARY KEY)'));
      await assert.rejects(bound(a.database, c => c.query('SELECT count(*)::int n FROM public.sentinel_b')), /does not exist/i);
      await assert.rejects(appA.query(`DROP DATABASE "${b.database}"`), /must be owner/i);
    } finally { await appB.end(); await runtimeB.end(); }
    // appA stays open: cleanup terminates exactly that session, then drops.
    const report = await cleanupTarget(ctx, a.transition('running'), { phase: 'assertion' });
    assert.equal(report.dropped, a.database);
    // pg reports a server-side termination as a non-queryable client.
    await assert.rejects(appA.query('SELECT 1'), /connection error and is not queryable|terminated|closed/i);
    await appA.end().catch(() => {});
    assert.equal((await catalogRow(ctx.bootstrapClient, a.database)), undefined);
    assert.equal((await cleanupTarget(ctx, b, { phase: 'setup' })).dropped, b.database);
    const leak = await leakCheck(ctx, { tracked: [a, b] });
    assert.equal(leak.leaks.some(leak => leak.database === a.database || leak.database === b.database), false);
    assert.deepEqual(leak.leaks.map(leak => leak.reason), ['template', 'template', 'template'], 'frozen templates stay until the template phase');
  });
});

test('real PostgreSQL: cleanup leaves a tampered marker and a changed owner untouched and reports both', { skip: real.skip }, async () => {
  await withRealRun(async ({ ctx }) => {
    const a = (await provisionTarget(ctx, { file: 'tests/a.test.mjs', baseline: 'S24' })).transition('running');
    const b = (await provisionTarget(ctx, { file: FILE_B, baseline: 'S24' })).transition('running');
    const session = await appClient(a.database, 'samosval_test_app', appPassword);
    // Deliberate tamper by a privileged actor; the lifecycle must not repair it.
    await ctx.bootstrapClient.query(`COMMENT ON DATABASE "${a.database}" IS 'tampered by a privileged actor'`);
    await ctx.bootstrapClient.query(`ALTER DATABASE "${b.database}" OWNER TO samosval_test_orchestrator`);
    await assert.rejects(cleanupTarget(ctx, a, { phase: 'setup' }), error => error.code === 'ESAFETY');
    assert.equal((await catalogRow(ctx.bootstrapClient, a.database)).comment, 'tampered by a privileged actor');
    assert.equal((await session.query('SELECT 1 AS alive')).rows[0].alive, 1, 'a tampered target must not be terminated');
    await assert.rejects(cleanupTarget(ctx, b, { phase: 'timeout' }), error => error.code === 'ESAFETY');
    assert.equal((await catalogRow(ctx.bootstrapClient, b.database)).owner, 'samosval_test_orchestrator');
    await session.end();
    const leak = await leakCheck(ctx, { tracked: [a, b] });
    assert.equal(leak.clean, false);
    const tampered = [a.database, b.database].sort();
    assert.deepEqual(leak.leaks.filter(leak => leak.database === a.database || leak.database === b.database).map(leak => [leak.database, leak.reason]).sort(), [[tampered[0], 'identity'], [tampered[1], 'identity']]);
    assert.equal(JSON.stringify(leak).includes(ctx.capability), false);
  });
});

test('real PostgreSQL: partial create is recovered only with its same-run receipt', { skip: real.skip }, async () => {
  await withRealRun(async ({ identity, admin, ctx }) => {
    const database = makeTargetName(ctx.runid, 'tests/partial.test.mjs');
    const inner = admin.query.bind(admin);
    let remaining = 1;
    const hooked = { query: async (config, values) => { if (remaining > 0 && String(config?.text ?? config).startsWith('GRANT CONNECT')) { remaining -= 1; throw new Error('injected provisioning failure'); } return inner(config, values); }, end: () => admin.end() };
    const failing = { ...ctx, bootstrapClient: hooked };
    await assert.rejects(provisionTarget(failing, { file: 'tests/partial.test.mjs', baseline: 'S24' }), /failed closed/i);
    assert.equal((await catalogRow(admin, database)).owner, TARGET_OWNER);
    assert.equal((await catalogRow(admin, database)).comment, null, 'an unmarked partial create has no marker');
    // Ordinary cleanup refuses the below-marked object; recovery proves the receipt first.
    await assert.rejects(cleanupTarget(ctx, { database, state: 'created' }, { phase: 'setup' }), error => error.code === 'ESAFETY');
    assert.ok(await catalogRow(admin, database));
    const report = await recoverPartialTarget(ctx, { database, runid: ctx.runid });
    assert.equal(report.recovered, database);
    assert.equal(await catalogRow(admin, database), undefined);
    // A second recovery has no receipt to prove and fails closed.
    await assert.rejects(recoverPartialTarget(ctx, { database, runid: ctx.runid }), /receipt/i);
  });
});

test('real PostgreSQL: a TOCTOU marker change between identity reread and terminate aborts the drop', { skip: real.skip }, async () => {
  await withRealRun(async ({ admin, ctx }) => {
    const record = (await provisionTarget(ctx, { file: 'tests/a.test.mjs', baseline: 'S24' })).transition('running');
    const inner = admin.query.bind(admin);
    let armed = true;
    const hooked = {
      query: async (config, values) => {
        const result = await inner(config, values);
        if (armed && String(config?.text ?? config).includes('terminate_exact_target')) {
          armed = false;
          // Runs on the same held session after termination, before the drop
          // authorization: the reread must observe the drifted marker.
          await inner(`COMMENT ON DATABASE "${record.database}" IS 'toctou replacement'`);
        }
        return result;
      },
      end: () => admin.end(),
    };
    await assert.rejects(cleanupTarget({ ...ctx, bootstrapClient: hooked }, record, { phase: 'setup' }), error => error.code === 'ESAFETY');
    assert.equal((await catalogRow(admin, record.database)).comment, 'toctou replacement');
    assert.ok(await catalogRow(admin, record.database), 'the drifted target must survive');
  });
});

test('real PostgreSQL: leak check reports a foreign object under the run prefix and never drops it', { skip: real.skip }, async () => {
  await withRealRun(async ({ admin, ctx }) => {
    const foreign = `${GENERATED_DATABASE_PREFIX}${ctx.runid}_feedfacecafe`;
    await admin.query(`CREATE DATABASE "${foreign}" TEMPLATE template0 OWNER samosval_test_bootstrap_admin`);
    try {
      const leak = await leakCheck(ctx, { tracked: [] });
      assert.equal(leak.clean, false);
      assert.ok(leak.leaks.some(leak => leak.database === foreign && leak.reason === 'identity'), JSON.stringify(leak.leaks.map(l => l.database)));
      assert.ok(await catalogRow(admin, foreign), 'a leak check must not drop a foreign object');
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${foreign}" WITH (FORCE)`);
    }
  });
});

test('real PostgreSQL: a lost bootstrap connection in the drop phase is CLOSED_ERROR, the target survives and a retry cleans it up', { skip: real.skip }, async () => {
  await withRealRun(async ({ admin, ctx }) => {
    const record = (await provisionTarget(ctx, { file: 'tests/a.test.mjs', baseline: 'S24' })).transition('running');
    // A dedicated bootstrap session for the cleanup, so the test-side admin stays usable.
    const session = new pg.Client({ connectionString: bootstrapUrl, application_name: 'i4_lifecycle_break' });
    session.on('error', () => {});
    await session.connect();
    const inner = session.query.bind(session);
    const hooked = {
      query: async (config, values) => {
        if (String(config?.text ?? config).includes('authorize_drop_target')) {
          // Real transport failure: the server kills the held session itself,
          // as a restart, a failover or an operator would; every later
          // statement of the session fails, the fence release included.
          await inner('SELECT pg_terminate_backend(pg_backend_pid())');
          return inner(config, values);
        }
        return inner(config, values);
      },
      end: () => session.end(),
    };
    try {
      await assert.rejects(
        cleanupTarget({ ...ctx, bootstrapClient: hooked }, record, { phase: 'setup' }),
        error => error.code !== 'ESAFETY' && /failed closed/i.test(error.message),
      );
      const row = await catalogRow(admin, record.database);
      assert.equal(row.comment, record.comment, 'nothing was destroyed by an infrastructure failure');
      // An infrastructure failure carries no verdict, so the same cleanup may be retried.
      assert.equal((await cleanupTarget(ctx, record, { phase: 'setup' })).dropped, record.database);
      assert.equal(await catalogRow(admin, record.database), undefined);
    } finally {
      await session.end().catch(() => {});
    }
  });
});
