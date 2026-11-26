import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BOOTSTRAP_MARKER, GENERATED_DATABASE_PREFIX, quoteIdentifier, validateAdminUrl, validateGeneratedIdentifier } from './safety.mjs';
import { EXPECTED_S24_HASH, EXPECTED_S25_HASH } from './templates.mjs';

const MARKER_SETTING = 'samosval.isolated_db_bootstrap';
const EXPECTED_SERVER_MAJOR = 16;
const CAPABILITY = /^[a-f0-9]{64}$/;
const OWNER = 'samosval_test_prepared_owner';
export const CLOSED_ERROR = 'admin operation failed closed';
function closedError(message = CLOSED_ERROR) { return Object.assign(new Error(message), { code: 'CLOSED_ERROR' }); }
const FINGERPRINT_FIELDS = Object.freeze([
  'databaseOid', 'ownerOid', 'ownerName', 'commentText', 'commentHash',
  'receiptGeneration', 'receiptState', 'capabilityBinding',
]);

export function generateRunCapability() {
  return randomBytes(32).toString('hex');
}

function validateCapability(value) {
  if (!CAPABILITY.test(value)) throw new Error('admin operation is not approved');
  return value;
}

async function redacted(work) {
  try { return await work(); } catch { throw closedError(); }
}

function immutableFingerprint(result) {
  const fingerprint = result?.rows?.[0]?.fingerprint;
  if (!fingerprint || typeof fingerprint !== 'object' || Array.isArray(fingerprint)
      || Object.keys(fingerprint).sort().join() !== [...FINGERPRINT_FIELDS].sort().join()
      || FINGERPRINT_FIELDS.some(field => typeof fingerprint[field] !== 'string' || fingerprint[field].length === 0)) {
    throw closedError();
  }
  return Object.freeze(Object.fromEntries(FINGERPRINT_FIELDS.map(field => [field, fingerprint[field]])));
}

function sameFingerprint(expected, actual) {
  return FINGERPRINT_FIELDS.every(field => expected[field] === actual[field]);
}

async function withTargetSessionLock(client, target, work) {
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0)) AS locked', [target]);
    locked = true;
    return await work();
  } finally {
    if (locked) {
      try {
        const result = await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked', [target]);
        if (result.rows[0]?.unlocked !== true) throw closedError();
      } catch (error) {
        await client.end?.().catch(() => {});
        throw error;
      }
    }
  }
}

export async function adminPreflight(client, adminUrl, { expectedRole = 'samosval_test_orchestrator', expectedServerAddress } = {}) {
  const url = validateAdminUrl(adminUrl);
  const result = await client.query(`
    SELECT current_database() AS database, current_user AS role,
           current_setting('server_version_num')::int AS version_num,
           current_setting($1, true) AS marker,
           inet_server_addr()::text AS address, inet_server_port() AS port
  `, [MARKER_SETTING]);
  if (result.rows.length !== 1) throw new Error('admin preflight failed closed');
  const row = result.rows[0];
  const serverMajor = Math.floor(Number(row.version_num) / 10000);
  const approvedAddresses = expectedServerAddress ? new Set([expectedServerAddress]) : url.hostname === '[::1]' ? new Set(['::1']) : url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? new Set(['127.0.0.1', '::1']) : new Set([url.hostname]);
  const addressMatches = approvedAddresses.has(row.address);
  const portMatches = url.hostname === 'postgres' ? Number(row.port) === 5432 : Number(row.port) === 5432 && url.port === '55432';
  if (row.database !== 'postgres' || row.role !== expectedRole || serverMajor !== EXPECTED_SERVER_MAJOR || row.marker !== BOOTSTRAP_MARKER || !addressMatches || !portMatches) throw closedError('admin preflight failed closed');
  return { serverMajor, marker: row.marker, address: row.address, port: Number(row.port) };
}

// The one exact target marker. kind=target keeps it apart from every
// template marker; the marker carries no capability.
export function targetComment(database, runid) {
  validateGeneratedIdentifier(database, { runid, kind: 'target' });
  return `samosval-isolated-db:v1;kind=target;runid=${runid};hash=${database.slice(-12)};owner=${OWNER}`;
}

export async function runAdminStatement(client, request) {
  if (!request || typeof request !== 'object' || Object.hasOwn(request, 'comment')) throw new Error('admin operation is not approved');
  if (request.operation === 'commentDatabase') {
    validateGeneratedIdentifier(request.database, { runid: request.runid, kind: 'target' });
    validateCapability(request.capability);
    if (request.kind !== 'target') throw new Error('admin operation is not approved');
    const comment = targetComment(request.database, request.runid);
    return redacted(async () => {
      const result = await client.query('SELECT samosval_isolated_admin.mark_reserved_target($1,$2) AS comment', [request.database, request.capability]);
      if (result.rows[0]?.comment !== comment) throw closedError();
      return result;
    });
  }
  throw new Error('admin operation is not approved');
}

function quoteLiteral(value) {
  if (typeof value !== 'string' || !/^samosval-isolated-db:v1;kind=template;runid=[a-f0-9]{12,20};baseline=(empty|S24|S25);version=(0|24|25);registry=(empty|[a-f0-9]{64});owner=samosval_test_prepared_owner$/.test(value)) {
    throw new Error('template operation is not approved');
  }
  return `'${value.replaceAll("'", "''")}'`;
}

// Closed baseline table: version, exact registry hash and the template a clone
// must be created from. S25 is a clone of S24 and never of `empty`, so a run
// can only ever apply the single 025 migration on top of a verified S24.
const TEMPLATE_BASELINES = Object.freeze({
  empty: { version: 0, registry: 'empty' },
  S24: { version: 24, registry: EXPECTED_S24_HASH },
  S25: { version: 25, registry: EXPECTED_S25_HASH },
});

function templateSource(suffix, runid) {
  if (suffix === 'empty') return 'template0';
  const parent = suffix === 'S24' ? 'empty' : 'S24';
  return `${GENERATED_DATABASE_PREFIX}${runid}_tpl_${parent.toLowerCase()}`;
}

export function createTemplateBroker({ bootstrapClient, runid, capability }) {
  if (!bootstrapClient?.query || !bootstrapClient?.end) throw new Error('template broker configuration rejected');
  validateCapability(capability);
  validateGeneratedIdentifier(`${GENERATED_DATABASE_PREFIX}${runid}_tpl_empty`, { runid, kind: 'template' });
  const boundRunid = runid;
  const boundCapability = capability;
  let pending = Promise.resolve();
  return Object.freeze({
    async run(request) {
      const allowedKeys = request?.operation === 'createTemplate'
        ? ['operation', 'database', 'source', 'capability']
        : request?.operation === 'freezeTemplate'
          ? ['operation', 'database', 'registryHash', 'capability']
          : ['operation', 'database', 'capability'];
      if (!request || !['createTemplate', 'freezeTemplate', 'dropTemplate'].includes(request.operation)
          || Object.keys(request).some(key => !allowedKeys.includes(key))
          || request.runid !== undefined) throw new Error('template operation is not approved');
      if (typeof request.capability !== 'string' || Buffer.byteLength(request.capability, 'utf8') !== Buffer.byteLength(boundCapability, 'utf8')
          || !timingSafeEqual(Buffer.from(request.capability, 'utf8'), Buffer.from(boundCapability, 'utf8'))) {
        throw new Error('template operation is not approved');
      }
      validateGeneratedIdentifier(request.database, { runid: boundRunid, kind: 'template' });
      const suffix = request.database.endsWith('_tpl_empty') ? 'empty'
        : request.database.endsWith('_tpl_s24') ? 'S24'
          : request.database.endsWith('_tpl_s25') ? 'S25' : null;
      if (!suffix) throw new Error('template operation is not approved');
      if (request.operation === 'createTemplate') {
        const expectedSource = templateSource(suffix, boundRunid);
        if (request.source !== expectedSource) throw new Error('template operation is not approved');
      } else if (request.operation === 'dropTemplate') {
        if (request.database.endsWith('_tpl_empty') && suffix !== 'empty') throw new Error('template operation is not approved');
      } else if (request.registryHash !== TEMPLATE_BASELINES[suffix].registry) {
        throw new Error('template operation is not approved');
      }
      const identifier = quoteIdentifier(request.database);
      const operation = pending.then(() => redacted(() => withTargetSessionLock(bootstrapClient, request.database, async () => {
        if (request.operation === 'createTemplate') {
          const source = request.source === 'template0' ? '"template0"' : quoteIdentifier(request.source);
          await bootstrapClient.query({ text: `CREATE DATABASE ${identifier} TEMPLATE ${source} OWNER ${OWNER}`, queryMode: 'simple' });
          await bootstrapClient.query({ text: `REVOKE CONNECT ON DATABASE ${identifier} FROM PUBLIC`, queryMode: 'simple' });
          return Object.freeze({ database: request.database });
        }
        if (request.operation === 'dropTemplate') {
          const expectedRegistry = suffix === 'empty' ? 'empty' : TEMPLATE_BASELINES[suffix].registry;
          const expectedVersion = TEMPLATE_BASELINES[suffix].version;
          const expectedComment = `samosval-isolated-db:v1;kind=template;runid=${boundRunid};baseline=${suffix};version=${expectedVersion};registry=${expectedRegistry};owner=${OWNER}`;
          const identity = await bootstrapClient.query(`SELECT d.datname, d.datallowconn, owner.rolname AS owner, description.description AS comment, (SELECT count(*)::int FROM pg_stat_activity WHERE datname=d.datname) AS sessions FROM pg_database d JOIN pg_roles owner ON owner.oid=d.datdba LEFT JOIN pg_shdescription description ON description.objoid=d.oid AND description.classoid='pg_catalog.pg_database'::regclass WHERE d.datname=$1`, [request.database]);
          const row = identity.rows[0];
          if (!row || row.datname !== request.database || row.owner !== OWNER || row.comment !== expectedComment || row.datallowconn !== false || row.sessions !== 0) throw closedError();
          await bootstrapClient.query({ text: `DROP DATABASE ${identifier}`, queryMode: 'simple' });
          return Object.freeze({ database: request.database });
        }
        const expectedRegistry = suffix === 'empty' ? 'empty' : request.registryHash;
        if (suffix === 'empty' && request.registryHash !== 'empty') throw new Error('template operation is not approved');
        const version = TEMPLATE_BASELINES[suffix].version;
        const comment = `samosval-isolated-db:v1;kind=template;runid=${boundRunid};baseline=${suffix};version=${version};registry=${expectedRegistry};owner=${OWNER}`;
        const sessions = await bootstrapClient.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [request.database]);
        if (sessions.rows[0]?.count !== 0) throw closedError();
        await bootstrapClient.query({ text: `COMMENT ON DATABASE ${identifier} IS ${quoteLiteral(comment)}`, queryMode: 'simple' });
        await bootstrapClient.query({ text: `REVOKE CONNECT ON DATABASE ${identifier} FROM PUBLIC, samosval_test_orchestrator, samosval_test_app, samosval_test_runtime`, queryMode: 'simple' });
        await bootstrapClient.query({ text: `ALTER DATABASE ${identifier} ALLOW_CONNECTIONS false`, queryMode: 'simple' });
        return Object.freeze({ database: request.database, comment });
      })));
      pending = operation.catch(() => {});
      return operation;
    },
  });
}

// ---- I4 lifecycle operations -------------------------------------------------
// Enumerated and closed exactly like the I2 pair. An error that carries a
// fixed safety verdict (ESAFETY, constant text only) passes the wrapper
// unchanged so the lifecycle can report the leak; every other failure,
// including driver text, collapses to CLOSED_ERROR.

function safety(reason) {
  return Object.assign(new Error(`isolated target safety: ${reason}`), { code: 'ESAFETY' });
}

async function classified(work) {
  try { return await work(); } catch (error) { if (error?.code === 'ESAFETY') throw error; throw closedError(); }
}

// Reread of the exact target: pg_database owner and pg_shdescription marker.
const IDENTITY_SQL = `/* isolated-target-identity */
  SELECT d.datname, owner.rolname AS "owner", description.description AS "comment"
  FROM pg_catalog.pg_database d
  JOIN pg_catalog.pg_roles owner ON owner.oid=d.datdba
  LEFT JOIN pg_catalog.pg_shdescription description ON description.objoid=d.oid AND description.classoid='pg_catalog.pg_database'::pg_catalog.regclass
  WHERE d.datname=$1`;

// Creation receipt of a partial create joined with the live catalog truth.
// Readable only through the dedicated bootstrap session.
const PARTIAL_RECEIPT_SQL = `/* isolated-partial-receipt */
  SELECT receipt.runid, receipt.kind, receipt.state AS receipt_state, receipt.expected_owner,
         d.datname AS database, owner.rolname AS "owner", description.description AS "comment"
  FROM samosval_isolated_admin.target_receipts receipt
  JOIN pg_catalog.pg_database d ON d.datname=receipt.target_name
  JOIN pg_catalog.pg_roles owner ON owner.oid=d.datdba
  LEFT JOIN pg_catalog.pg_shdescription description ON description.objoid=d.oid AND description.classoid='pg_catalog.pg_database'::pg_catalog.regclass
  WHERE receipt.target_name=$1::name`;

// A partial create carries no marker. Both sides of the comparison spell the
// proven absence as one constant, so "no comment" is fingerprintable.
const ABSENT_COMMENT = '<absent>';

const PARTIAL_REVALIDATE_SQL = `/* isolated-drop-revalidate */
  SELECT jsonb_build_object(
    'databaseOid', d.oid::text,
    'ownerOid', owner.oid::text,
    'ownerName', owner.rolname,
    'commentText', COALESCE(description.description, '${ABSENT_COMMENT}'),
    'commentHash', encode(public.digest(COALESCE(description.description, ''), 'sha256'), 'hex'),
    'receiptGeneration', receipt.receipt_generation::text,
    'receiptState', receipt.state,
    'capabilityBinding', encode(receipt.capability_hash, 'hex')
  ) AS fingerprint
  FROM samosval_isolated_admin.target_receipts receipt
  JOIN pg_catalog.pg_database d ON d.datname=receipt.target_name
  JOIN pg_catalog.pg_roles owner ON owner.oid=d.datdba
  LEFT JOIN pg_catalog.pg_shdescription description ON description.objoid=d.oid AND description.classoid='pg_catalog.pg_database'::pg_catalog.regclass
  WHERE receipt.target_name=$1::name`;

// Exact prefix scan of the catalog. No LIKE and no regular expression: the
// prefix is matched literally, so wildcard characters have no meaning.
const CATALOG_SQL = `SELECT d.datname, owner.rolname AS "owner", description.description AS "comment"
  FROM pg_catalog.pg_database d
  JOIN pg_catalog.pg_roles owner ON owner.oid=d.datdba
  LEFT JOIN pg_catalog.pg_shdescription description ON description.objoid=d.oid AND description.classoid='pg_catalog.pg_database'::pg_catalog.regclass
  WHERE starts_with(datname, $1)
  ORDER BY d.datname`;

async function readIdentity(bootstrapClient, database) {
  const result = await bootstrapClient.query({ text: IDENTITY_SQL, values: [database] });
  const row = result?.rows?.[0];
  if (row === undefined) return null;
  if (result.rows.length !== 1 || row.datname !== database || typeof row.owner !== 'string') throw closedError();
  return row;
}

function requireIdentity(row, request) {
  if (row === null || row.owner !== OWNER || row.comment !== targetComment(request.database, request.runid)) {
    throw safety('identity mismatch for the exact target (marker or owner)');
  }
}

function requirePartialProof(row, request) {
  if (!row || row.database !== request.database) throw safety('partial-create receipt is missing: no creation receipt of this run is provable');
  if (row.runid !== request.runid || row.kind !== 'target' || row.receipt_state !== 'reserved') {
    throw safety('partial-create receipt is not a reserved creation receipt of this run');
  }
  if (row.owner !== OWNER || row.comment !== null) throw safety('identity mismatch on the partial-create target (marker or owner)');
}

// The I2 drop authority: authorize, reread the fingerprint, drop. The
// statement sequence is shared by the I2 drop and the I4 cleanup unchanged.
async function dropAuthorized(bootstrapClient, request, identifier) {
  const authorized = immutableFingerprint(await bootstrapClient.query(
    'SELECT samosval_isolated_admin.authorize_drop_target($1,$2) AS fingerprint',
    [request.database, request.capability],
  ));
  const revalidated = immutableFingerprint(await bootstrapClient.query({
    text: `/* isolated-drop-revalidate */
            SELECT jsonb_build_object(
              'databaseOid', d.oid::text,
              'ownerOid', owner.oid::text,
              'ownerName', owner.rolname,
              'commentText', description.description,
              'commentHash', encode(public.digest(description.description, 'sha256'), 'hex'),
              'receiptGeneration', receipt.receipt_generation::text,
              'receiptState', receipt.state,
              'capabilityBinding', encode(receipt.capability_hash, 'hex')
            ) AS fingerprint
            FROM samosval_isolated_admin.target_receipts receipt
            JOIN pg_catalog.pg_database d ON d.datname=receipt.target_name
            JOIN pg_catalog.pg_roles owner ON owner.oid=d.datdba
            JOIN pg_catalog.pg_shdescription description ON description.objoid=d.oid AND description.classoid='pg_catalog.pg_database'::pg_catalog.regclass
            WHERE receipt.target_name=$1::name`,
    values: [request.database],
  }));
  if (!sameFingerprint(authorized, revalidated)) throw closedError();
  return bootstrapClient.query({ text: `DROP DATABASE ${identifier}`, queryMode: 'simple' });
}

// The drop phase mirrors the terminate phase: a refusal observed inside the
// held fence is a safety verdict with constant text, so the caller can report
// the leak. A transport-level failure instead breaks the fence release, ends
// the dedicated session and reaches the caller as CLOSED_ERROR.
async function dropAuthorityRefusal(bootstrapClient, request, identifier) {
  try {
    return await dropAuthorized(bootstrapClient, request, identifier);
  } catch (error) {
    if (error?.code === 'ESAFETY') throw error;
    throw safety('the drop authority refused the exact target (identity, state or authority)');
  }
}

async function reservedTargetOperation(bootstrapClient, request, identifier) {
  if (request.operation === 'createReservedTarget') {
    await bootstrapClient.query('SELECT samosval_isolated_admin.reserve_target($1,$2,$3)', [request.database, request.runid, request.capability]);
    await bootstrapClient.query({ text: `CREATE DATABASE ${identifier}`, queryMode: 'simple' });
    await bootstrapClient.query({ text: `ALTER DATABASE ${identifier} OWNER TO ${OWNER}`, queryMode: 'simple' });
    await bootstrapClient.query({ text: `GRANT CONNECT ON DATABASE ${identifier} TO samosval_test_app, samosval_test_runtime`, queryMode: 'simple' });
    return runAdminStatement(bootstrapClient, { operation: 'commentDatabase', database: request.database, runid: request.runid, capability: request.capability, kind: 'target' });
  }
  return dropAuthorized(bootstrapClient, request, identifier);
}

// reserve -> clone from the frozen template -> owner -> grant -> mark -> reread.
async function cloneReservedTarget(bootstrapClient, request, identifier, templateIdentifier) {
  await bootstrapClient.query('SELECT samosval_isolated_admin.reserve_target($1,$2,$3)', [request.database, request.runid, request.capability]);
  await bootstrapClient.query({ text: `CREATE DATABASE ${identifier} TEMPLATE ${templateIdentifier}`, queryMode: 'simple' });
  if (request.onState) await request.onState('created');
  await bootstrapClient.query({ text: `ALTER DATABASE ${identifier} OWNER TO ${OWNER}`, queryMode: 'simple' });
  await bootstrapClient.query({ text: `GRANT CONNECT ON DATABASE ${identifier} TO samosval_test_app, samosval_test_runtime`, queryMode: 'simple' });
  const marked = await runAdminStatement(bootstrapClient, { operation: 'commentDatabase', database: request.database, runid: request.runid, capability: request.capability, kind: 'target' });
  requireIdentity(await readIdentity(bootstrapClient, request.database), request);
  return Object.freeze({ database: request.database, comment: marked.rows[0].comment });
}

// state check -> reread -> terminate the exact target -> drop authority. The
// record state is refused inside the held fence, so the refusal is auditable
// on the session; an already absent target has nothing left to destroy.
async function cleanupReservedTarget(bootstrapClient, request, identifier) {
  if (request.state !== 'marked' && request.state !== 'running') {
    throw safety(`state ${String(request.state)} is below marked; ordinary cleanup is not approved`);
  }
  const identity = await readIdentity(bootstrapClient, request.database);
  if (identity === null) return Object.freeze({ database: null });
  requireIdentity(identity, request);
  try {
    await bootstrapClient.query('SELECT samosval_isolated_admin.terminate_exact_target($1,$2) AS terminated', [request.database, request.capability]);
  } catch (error) {
    if (error?.code === 'ESAFETY') throw error;
    // The terminate predicate refused inside the same held fence: nothing was
    // destroyed and the object is reported instead of retried.
    throw safety('the terminate phase refused the exact target (identity, state or authority)');
  }
  await dropAuthorityRefusal(bootstrapClient, request, identifier);
  return Object.freeze({ database: request.database });
}

// receipt proof -> partial drop authority -> drop. The reserved predicate is
// a separate SQL function; it can never authorize a marked target.
async function recoverReservedTarget(bootstrapClient, request, identifier) {
  const proof = await bootstrapClient.query({ text: PARTIAL_RECEIPT_SQL, values: [request.database] });
  if (!Array.isArray(proof?.rows) || proof.rows.length > 1) throw closedError();
  requirePartialProof(proof.rows[0], request);
  const authorized = immutableFingerprint(await bootstrapClient.query(
    'SELECT samosval_isolated_admin.authorize_partial_drop($1,$2) AS fingerprint',
    [request.database, request.capability],
  ));
  const revalidated = immutableFingerprint(await bootstrapClient.query({ text: PARTIAL_REVALIDATE_SQL, values: [request.database] }));
  if (!sameFingerprint(authorized, revalidated)) throw closedError();
  await bootstrapClient.query({ text: `DROP DATABASE ${identifier}`, queryMode: 'simple' });
  return Object.freeze({ database: request.database });
}

async function catalogRunDatabases(bootstrapClient, request) {
  const result = await bootstrapClient.query({ text: CATALOG_SQL, values: [`${GENERATED_DATABASE_PREFIX}${request.runid}`] });
  if (!Array.isArray(result?.rows) || result.rows.some(row => typeof row?.datname !== 'string')) throw closedError();
  return result.rows.map(row => Object.freeze({ datname: row.datname, owner: row.owner ?? null, comment: row.comment ?? null }));
}

const TARGET_KEYS = ['operation', 'database', 'runid', 'capability'];
const PROVISIONING_OPERATIONS = Object.freeze({
  createReservedTarget: { keys: TARGET_KEYS, fence: true },
  dropReservedTarget: { keys: TARGET_KEYS, fence: true },
  cloneTarget: { keys: [...TARGET_KEYS, 'template', 'onState'], required: [...TARGET_KEYS, 'template'], fence: true, classified: true, template: true, run: cloneReservedTarget },
  cleanupTarget: { keys: [...TARGET_KEYS, 'state'], required: [...TARGET_KEYS, 'state'], fence: true, classified: true, run: cleanupReservedTarget },
  recoverTarget: { keys: TARGET_KEYS, required: TARGET_KEYS, fence: true, classified: true, run: recoverReservedTarget },
  listRunDatabases: { keys: ['operation', 'runid'], required: ['operation', 'runid'], classified: true, catalog: true, run: catalogRunDatabases },
});

export function createProvisioningBroker({ bootstrapClient }) {
  if (!bootstrapClient?.query || !bootstrapClient?.end) throw new Error('provisioning broker configuration rejected');
  let pending = Promise.resolve();
  return Object.freeze({
    async run(request) {
      const approved = request && Object.hasOwn(PROVISIONING_OPERATIONS, request.operation) ? PROVISIONING_OPERATIONS[request.operation] : null;
      if (!approved || Object.keys(request).some(key => !approved.keys.includes(key))
          || (approved.required ?? []).some(key => !Object.hasOwn(request, key))
          || (request.onState !== undefined && typeof request.onState !== 'function')) {
        throw new Error('provisioning operation is not approved');
      }
      if (approved.catalog) {
        validateGeneratedIdentifier(`${GENERATED_DATABASE_PREFIX}${request.runid}_tpl_empty`, { runid: request.runid, kind: 'template' });
      } else {
        validateGeneratedIdentifier(request.database, { runid: request.runid, kind: 'target' });
        validateCapability(request.capability);
        if (approved.template) validateGeneratedIdentifier(request.template, { runid: request.runid, kind: 'template' });
      }
      const identifier = approved.catalog ? null : quoteIdentifier(request.database);
      const templateIdentifier = approved.template ? quoteIdentifier(request.template) : null;
      // Every mutating operation holds the per-target session fence. The
      // read-only catalog scan stays fence-free and never blocks a cleanup.
      const work = () => (approved.fence
        ? withTargetSessionLock(bootstrapClient, request.database, () => (approved.run
          ? approved.run(bootstrapClient, request, identifier, templateIdentifier)
          : reservedTargetOperation(bootstrapClient, request, identifier)))
        : approved.run(bootstrapClient, request));
      const guarded = pending.then(() => (approved.classified ? classified(work) : redacted(work)));
      pending = guarded.catch(() => {});
      return guarded;
    },
  });
}
