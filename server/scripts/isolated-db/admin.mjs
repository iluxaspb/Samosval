import { BOOTSTRAP_MARKER, quoteIdentifier, validateAdminUrl, validateGeneratedIdentifier } from './safety.mjs';

const MARKER_SETTING = 'samosval.isolated_db_bootstrap';
const EXPECTED_SERVER_MAJOR = 16;

export async function adminPreflight(client, adminUrl, { expectedRole = 'samosval_test_orchestrator' } = {}) {
  validateAdminUrl(adminUrl);
  const result = await client.query(`
    SELECT current_database() AS database,
           current_user AS role,
           current_setting('server_version_num')::int AS version_num,
           current_setting($1, true) AS marker,
           inet_server_addr()::text AS address
  `, [MARKER_SETTING]);
  if (result.rows.length !== 1) throw new Error('admin preflight failed closed');
  const row = result.rows[0];
  const serverMajor = Math.floor(Number(row.version_num) / 10000);
  if (row.database !== 'postgres' || row.role !== expectedRole || serverMajor !== EXPECTED_SERVER_MAJOR || row.marker !== BOOTSTRAP_MARKER) {
    throw new Error('admin preflight failed closed');
  }
  return { serverMajor, marker: row.marker, address: row.address };
}

export async function runAdminStatement(client, request) {
  if (!request || typeof request !== 'object') throw new Error('admin operation is not approved');
  if (request.operation === 'commentDatabase') {
    validateGeneratedIdentifier(request.database, { runid: request.runid, kind: 'target' });
    if (typeof request.comment !== 'string' || !/^samosval-isolated-db:v1;kind=target;runid=[a-f0-9]{12,24};hash=[a-f0-9]{12};owner=[a-z][a-z0-9_]*$/.test(request.comment)) {
      throw new Error('admin operation is not approved');
    }
    return client.query(`COMMENT ON DATABASE ${quoteIdentifier(request.database)} IS $1`, [request.comment]);
  }
  throw new Error('admin operation is not approved');
}
