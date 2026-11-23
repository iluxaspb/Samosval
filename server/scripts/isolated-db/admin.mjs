import { randomBytes } from 'node:crypto';
import { BOOTSTRAP_MARKER, quoteIdentifier, validateAdminUrl, validateGeneratedIdentifier } from './safety.mjs';

const MARKER_SETTING = 'samosval.isolated_db_bootstrap';
const EXPECTED_SERVER_MAJOR = 16;
const CAPABILITY = /^[a-f0-9]{64}$/;
const OWNER = 'samosval_test_prepared_owner';
const CLOSED_ERROR = 'admin operation failed closed';

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

export function createProvisioningBroker({ adminClient, bootstrapClient }) {
  if (!adminClient?.query || !bootstrapClient?.query) throw new Error('provisioning broker configuration rejected');
  return Object.freeze({
    async run(request) {
      if (!request || !['createReservedTarget','dropReservedTarget'].includes(request.operation) || Object.keys(request).some(key => !['operation','database','runid','capability'].includes(key))) {
        throw new Error('provisioning operation is not approved');
      }
      validateGeneratedIdentifier(request.database, { runid: request.runid, kind: 'target' });
      validateCapability(request.capability);
      const identifier = quoteIdentifier(request.database);
      return redacted(async () => {
        if (request.operation === 'dropReservedTarget') {
          await adminClient.query('SELECT samosval_isolated_admin.authorize_drop_target($1,$2)', [request.database, request.capability]);
          return bootstrapClient.query({ text: `DROP DATABASE ${identifier}`, queryMode: 'simple' });
        }
        await adminClient.query('SELECT samosval_isolated_admin.reserve_target($1,$2,$3)', [request.database, request.runid, request.capability]);
        await bootstrapClient.query({ text: `CREATE DATABASE ${identifier}`, queryMode: 'simple' });
        await bootstrapClient.query({ text: `ALTER DATABASE ${identifier} OWNER TO ${OWNER}`, queryMode: 'simple' });
        await bootstrapClient.query({ text: `GRANT CONNECT ON DATABASE ${identifier} TO samosval_test_app, samosval_test_runtime`, queryMode: 'simple' });
        return runAdminStatement(adminClient, { operation: 'commentDatabase', database: request.database, runid: request.runid, capability: request.capability, kind: 'target' });
      });
    },
  });
}
