import { createHash, randomBytes } from 'node:crypto';
import { GENERATED_DATABASE_PREFIX, MAX_RUNID_LENGTH, validateGeneratedIdentifier } from './safety.mjs';
import { createProvisioningBroker, generateRunCapability, targetComment } from './admin.mjs';

export { targetComment };
export const TARGET_COMMENT_PREFIX = 'samosval-isolated-db:v1;';
export const TARGET_OWNER = 'samosval_test_prepared_owner';

const CAPABILITY = /^[a-f0-9]{64}$/;
const RUNID = new RegExp(`^[a-f0-9]{12,${MAX_RUNID_LENGTH}}$`);
const RECORD_TYPE = 'samosval-target-record:v1';
const LEAK_TYPE = 'samosval-leak-report:v1';
// Monotonic lifecycle. A child may start only from "marked".
const NEXT_STATE = Object.freeze({ creating: 'created', created: 'marked', marked: 'running' });
const RECORD_STATES = new Set(Object.keys(NEXT_STATE).concat('running'));
const CLEANUP_PHASES = new Set(['setup', 'fixtures', 'running', 'assertion', 'timeout']);
const CLEANUP_STATES = new Set(['marked', 'running']);
const TEMPLATE_KINDS = new Set(['empty', 'S24', 'S25', 'S26']);
// Frozen baseline chain: version and the template each baseline is cloned from.
// S25 must come from S24 (never from `empty`), so exactly 025 is applied.
const TEMPLATE_CHAIN = Object.freeze({
  empty: { version: 0, source: 'template0' },
  S24: { version: 24, source: 'empty' },
  S25: { version: 25, source: 'S24' },
  S26: { version: 26, source: 'S25' },
});
const CONTEXT_KEYS = ['bootstrapClient', 'runid', 'capability', 'templates', 'onState'];
const TEMPLATE_KEYS = ['kind', 'database', 'source', 'version', 'registryHash', 'owner', 'comment', 'immutable'];
const RECORD_KEYS = ['type', 'database', 'runid', 'state', 'comment', 'file', 'baseline'];
const TRACKED_KEYS = [...RECORD_KEYS, 'transition'];
// Relative POSIX path of a test root: lowercase, at least one directory
// segment, no empty, "." or ".." segment (manifest roots live under tests/).
const FILE_PATH = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\.test\.mjs$/;
const TEMPLATE_COMMENT_START = (runid, kind) => `${TARGET_COMMENT_PREFIX}kind=template;runid=${runid};baseline=${kind};`;

function reject(label) { throw new Error(`${label} is not approved`); }

function safety(reason) {
  return Object.assign(new Error(`isolated target safety: ${reason}`), { code: 'ESAFETY' });
}

function onlyKeys(value, keys, label, unknown = `${label} is not approved`) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(label);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(unknown);
  }
  return value;
}

// One broker per dedicated bootstrap session, so every lifecycle action of a
// session shares one serialized chain.
const brokers = new WeakMap();

function brokerFor(bootstrapClient) {
  let broker = brokers.get(bootstrapClient);
  if (!broker) {
    broker = createProvisioningBroker({ bootstrapClient });
    brokers.set(bootstrapClient, broker);
  }
  return broker;
}

// Global provisioning semaphore, value 1 (spec 3.11). Clone and setup of
// every file of the run pass through it, whatever the execution concurrency is.
let provisioning = Promise.resolve();

export function provisioningSlot(work) {
  if (typeof work !== 'function') reject('provisioning slot');
  const result = provisioning.then(work, work);
  provisioning = result.catch(() => {});
  return result;
}

function templateRecord(runid, kind, record) {
  // A frozen I3 TemplateRecord, or the reduced {kind,database,immutable} view.
  // Anything else is refused before the first statement.
  const refused = () => reject('template');
  if (!TEMPLATE_KINDS.has(kind) || !record || typeof record !== 'object' || Array.isArray(record)) refused();
  if (Object.keys(record).some(key => !TEMPLATE_KEYS.includes(key))) refused();
  if (record.kind !== kind || record.immutable !== true) refused();
  try { validateGeneratedIdentifier(record.database, { runid, kind: 'template' }); } catch { refused(); }
  if (record.database !== `${GENERATED_DATABASE_PREFIX}${runid}_tpl_${kind.toLowerCase()}`) refused();
  if (record.owner !== undefined && record.owner !== TARGET_OWNER) refused();
  if (record.version !== undefined && record.version !== TEMPLATE_CHAIN[kind].version) refused();
  if (record.source !== undefined) {
    const parent = TEMPLATE_CHAIN[kind].source;
    if (record.source !== (parent === 'template0' ? 'template0' : `${GENERATED_DATABASE_PREFIX}${runid}_tpl_${parent.toLowerCase()}`)) refused();
  }
  if (record.registryHash !== undefined && typeof record.registryHash !== 'string') refused();
  if (record.comment !== undefined && (typeof record.comment !== 'string' || !record.comment.startsWith(TEMPLATE_COMMENT_START(runid, kind)))) refused();
  return record;
}

function lifecycleContext(context) {
  onlyKeys(context, CONTEXT_KEYS, 'lifecycle context');
  const { bootstrapClient, runid, capability, templates, onState } = context;
  if (!bootstrapClient?.query || !bootstrapClient?.end) reject('lifecycle context');
  if (typeof runid !== 'string' || !RUNID.test(runid)) reject('lifecycle context');
  if (typeof capability !== 'string' || !CAPABILITY.test(capability)) reject('lifecycle context');
  if (onState !== undefined && typeof onState !== 'function') reject('lifecycle context');
  if (!(templates instanceof Map) || templates.size === 0 || templates.size > TEMPLATE_KINDS.size) reject('template');
  for (const [kind, record] of templates) templateRecord(runid, kind, record);
  return { bootstrapClient, runid, capability, onState, templates, broker: brokerFor(bootstrapClient) };
}

// Only a database of this very run may be named: exact prefix, exact runid,
// 12-hex suffix. Reserved, template and foreign-run names never pass.
function exactTarget(context, database) {
  try { validateGeneratedIdentifier(database, { runid: context.runid, kind: 'target' }); }
  catch { throw safety('database identifier is not approved for this run'); }
  return database;
}

function targetRecord(fields) {
  return Object.freeze({
    ...fields,
    transition(next) {
      if (typeof next !== 'string' || NEXT_STATE[this.state] !== next) reject('transition');
      return targetRecord({ ...fields, state: next });
    },
  });
}

export function makeRunIdentity() {
  const runid = randomBytes(8).toString('hex');
  return Object.freeze({ runid, prefix: `${GENERATED_DATABASE_PREFIX}${runid}`, capability: generateRunCapability() });
}

export function makeTargetName(runid, filePath) {
  if (typeof runid !== 'string' || !RUNID.test(runid)) reject('run identity');
  if (typeof filePath !== 'string' || !FILE_PATH.test(filePath)) reject('file path');
  return validateGeneratedIdentifier(`${GENERATED_DATABASE_PREFIX}${runid}_${createHash('sha256').update(filePath).digest('hex').slice(0, 12)}`, { runid, kind: 'target' });
}

export function targetUrl(record, options) {
  onlyKeys(record, TRACKED_KEYS, 'target record');
  if (record.state !== 'marked') throw new Error('a child may start only from marked');
  validateGeneratedIdentifier(record.database);
  onlyKeys(options, ['host', 'port'], 'target URL options');
  const { host, port } = options;
  if (typeof host !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:]+\])$/i.test(host)) reject('target URL host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) reject('target URL port');
  return `postgresql://${host}:${port}/${record.database}`;
}

// Clones the frozen template of the baseline inside one held broker fence.
// The record climbs creating -> created -> marked and stops there; the child
// is started by the runner from "marked" only.
export async function provisionTarget(context, spec) {
  const lifecycle = lifecycleContext(context);
  onlyKeys(spec, ['file', 'baseline'], 'provision spec', 'provision spec has an unknown field and is not approved');
  if (typeof spec.file !== 'string' || !FILE_PATH.test(spec.file)) reject('file path');
  if (!TEMPLATE_KINDS.has(spec.baseline)) reject('baseline');
  const template = templateRecord(lifecycle.runid, spec.baseline, lifecycle.templates.get(spec.baseline));
  const database = makeTargetName(lifecycle.runid, spec.file);
  const expected = targetComment(database, lifecycle.runid);
  const notify = state => lifecycle.onState?.(state);
  notify('creating');
  const request = { operation: 'cloneTarget', database, runid: lifecycle.runid, template: template.database, capability: lifecycle.capability };
  if (lifecycle.onState) request.onState = () => notify('created');
  const cloned = await provisioningSlot(() => lifecycle.broker.run(request));
  if (cloned?.database !== database || cloned?.comment !== expected) throw safety('identity: the exact COMMENT was not confirmed after marking');
  notify('marked');
  return targetRecord({ type: RECORD_TYPE, database, runid: lifecycle.runid, state: 'marked', comment: expected, file: spec.file, baseline: spec.baseline });
}

function cleanupTargetInput(context, record) {
  const lifecycle = lifecycleContext(context);
  onlyKeys(record, TRACKED_KEYS, 'cleanup target');
  const { database, state } = record;
  if (typeof state !== 'string' || !RECORD_STATES.has(state)) reject('cleanup state');
  exactTarget(lifecycle, database);
  // creating|created is the partial-create zone: the refusal itself happens
  // inside the held broker fence and the object goes to recovery or to the
  // leak report instead.
  return { lifecycle, database, state };
}

function cleanupOptions(options) {
  onlyKeys(options, ['phase'], 'cleanup options', 'cleanup options are not approved');
  if (!CLEANUP_PHASES.has(options.phase)) reject('cleanup phase');
  return options.phase;
}

// Terminates and drops the exact target inside one held broker fence. The
// broker revalidates identity before every destructive statement and fails
// closed on any drift; a changed marker or owner leaves the database in place
// and the error carries ESAFETY so the caller can report the leak.
export async function cleanupTarget(context, record, options) {
  const { lifecycle, database, state } = cleanupTargetInput(context, record);
  const phase = cleanupOptions(options);
  const result = await lifecycle.broker.run({ operation: 'cleanupTarget', database, runid: lifecycle.runid, capability: lifecycle.capability, state });
  return Object.freeze({ type: 'samosval-cleanup-report:v1', dropped: result?.database ?? null, phase });
}

// A partial create (creating|created) is dropped only when the same admin
// session can prove the exact generated name, the exact owner and the
// current-run creation receipt. Without that proof it stays and is reported.
export async function recoverPartialTarget(context, request) {
  const lifecycle = lifecycleContext(context);
  onlyKeys(request, ['database', 'runid'], 'partial recovery request', 'partial recovery request has an unknown field and is not approved');
  if (request.runid !== lifecycle.runid) reject('run identity');
  exactTarget(lifecycle, request.database);
  const result = await lifecycle.broker.run({ operation: 'recoverTarget', database: request.database, runid: lifecycle.runid, capability: lifecycle.capability });
  return Object.freeze({ type: 'samosval-recovery-report:v1', recovered: result?.database ?? null });
}

function trackedTarget(context, record) {
  onlyKeys(record, TRACKED_KEYS, 'tracked target');
  if (typeof record.state !== 'string' || !CLEANUP_STATES.has(record.state)) reject('tracked target state');
  return exactTarget(context, record.database);
}

function classifyRow(runid, row, tracked) {
  const name = row.datname;
  const template = `${GENERATED_DATABASE_PREFIX}${runid}_tpl_`;
  if (name === `${template}empty` || name === `${template}s24` || name === `${template}s25` || name === `${template}s26`) return 'template';
  // Anything else under the run prefix must be an exact marked target of this
  // run that the run tracker knows. Every other hit — a drifted marker or
  // owner, a foreign suffix, or a valid marker the run never tracked — is
  // reported as an identity mismatch and never touched.
  try { validateGeneratedIdentifier(name, { runid, kind: 'target' }); } catch { return 'identity'; }
  if (row.owner !== TARGET_OWNER || row.comment !== targetComment(name, runid)) return 'identity';
  return tracked.has(name) ? 'tracked target still present' : 'identity';
}

// Read-only: unions the tracked names with the exact prefix scan of
// pg_database, validates every hit and reports mismatches. Never deletes.
export async function leakCheck(context, options) {
  const lifecycle = lifecycleContext(context);
  onlyKeys(options, ['tracked'], 'leak options');
  if (!Array.isArray(options.tracked)) reject('leak options');
  const tracked = new Set(options.tracked.map(record => trackedTarget(lifecycle, record)));
  const rows = await lifecycle.broker.run({ operation: 'listRunDatabases', runid: lifecycle.runid });
  if (!Array.isArray(rows)) throw new Error('leak catalog failed closed');
  const leaks = [];
  for (const row of rows) {
    const reason = classifyRow(lifecycle.runid, row, tracked);
    if (reason) leaks.push(Object.freeze({ database: row.datname, reason }));
  }
  return Object.freeze({ type: LEAK_TYPE, clean: leaks.length === 0, leaks: Object.freeze(leaks) });
}
