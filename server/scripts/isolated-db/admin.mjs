import { randomBytes } from 'node:crypto';
import { BOOTSTRAP_MARKER, quoteIdentifier, validateAdminUrl, validateGeneratedIdentifier } from './safety.mjs';

const MARKER_SETTING = 'samosval.isolated_db_bootstrap';
const EXPECTED_SERVER_MAJOR = 16;
const CAPABILITY = /^[a-f0-9]{64}$/;
const OWNER = 'samosval_test_prepared_owner';
const CLOSED_ERROR = 'admin operation failed closed';
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
  try { return await work(); } catch { throw new Error(CLOSED_ERROR); }
}

function immutableFingerprint(result) {
  const fingerprint = result?.rows?.[0]?.fingerprint;
  if (!fingerprint || typeof fingerprint !== 'object' || Array.isArray(fingerprint)
      || Object.keys(fingerprint).sort().join() !== [...FINGERPRINT_FIELDS].sort().join()
      || FINGERPRINT_FIELDS.some(field => typeof fingerprint[field] !== 'string' || fingerprint[field].length === 0)) {
    throw new Error(CLOSED_ERROR);
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
        if (result.rows[0]?.unlocked !== true) throw new Error(CLOSED_ERROR);
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
  if (row.database !== 'postgres' || row.role !== expectedRole || serverMajor !== EXPECTED_SERVER_MAJOR || row.marker !== BOOTSTRAP_MARKER || !addressMatches || !portMatches) throw new Error('admin preflight failed closed');
  return { serverMajor, marker: row.marker, address: row.address, port: Number(row.port) };
}

export async function runAdminStatement(client, request) {
  if (!request || typeof request !== 'object' || Object.hasOwn(request, 'comment')) throw new Error('admin operation is not approved');
  if (request.operation === 'commentDatabase') {
    validateGeneratedIdentifier(request.database, { runid: request.runid, kind: 'target' });
    validateCapability(request.capability);
    if (request.kind !== 'target') throw new Error('admin operation is not approved');
    const hash = request.database.slice(-12);
    const comment = `samosval-isolated-db:v1;kind=target;runid=${request.runid};hash=${hash};owner=${OWNER}`;
    return redacted(async () => {
      const result = await client.query('SELECT samosval_isolated_admin.mark_reserved_target($1,$2) AS comment', [request.database, request.capability]);
      if (result.rows[0]?.comment !== comment) throw new Error(CLOSED_ERROR);
      return result;
    });
  }
  throw new Error('admin operation is not approved');
}

export function createProvisioningBroker({ bootstrapClient }) {
  if (!bootstrapClient?.query || !bootstrapClient?.end) throw new Error('provisioning broker configuration rejected');
  let pending = Promise.resolve();
  return Object.freeze({
    async run(request) {
      if (!request || !['createReservedTarget','dropReservedTarget'].includes(request.operation) || Object.keys(request).some(key => !['operation','database','runid','capability'].includes(key))) {
        throw new Error('provisioning operation is not approved');
      }
      validateGeneratedIdentifier(request.database, { runid: request.runid, kind: 'target' });
      validateCapability(request.capability);
      const identifier = quoteIdentifier(request.database);
      const operation = pending.then(() => redacted(() => withTargetSessionLock(bootstrapClient, request.database, async () => {
        if (request.operation === 'createReservedTarget') {
          await bootstrapClient.query('SELECT samosval_isolated_admin.reserve_target($1,$2,$3)', [request.database, request.runid, request.capability]);
          await bootstrapClient.query({ text: `CREATE DATABASE ${identifier}`, queryMode: 'simple' });
          await bootstrapClient.query({ text: `ALTER DATABASE ${identifier} OWNER TO ${OWNER}`, queryMode: 'simple' });
          await bootstrapClient.query({ text: `GRANT CONNECT ON DATABASE ${identifier} TO samosval_test_app, samosval_test_runtime`, queryMode: 'simple' });
          return runAdminStatement(bootstrapClient, { operation: 'commentDatabase', database: request.database, runid: request.runid, capability: request.capability, kind: 'target' });
        }
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
        if (!sameFingerprint(authorized, revalidated)) throw new Error(CLOSED_ERROR);
        return bootstrapClient.query({ text: `DROP DATABASE ${identifier}`, queryMode: 'simple' });
      })));
      pending = operation.catch(() => {});
      return operation;
    },
  });
}
