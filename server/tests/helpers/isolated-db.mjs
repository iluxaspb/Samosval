import pg from 'pg';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { transformLegacyMigrationGuard } from '../../scripts/isolated-db/legacy-guards.mjs';

const APPROVED_DATABASE = 'samosval_parallel_shifts_test';
// The harness clones each db root into a generated target
// `samosval_parallel_shifts_test_<runid>_<hash>`, so a db child must accept
// both the exact legacy name and that exact generated shape.
export const HARNESS_DATABASE = /^samosval_parallel_shifts_test_[a-f0-9]{12,20}_[a-f0-9]{12}$/;
const APPROVED_HOSTS = new Set(['postgres', 'localhost', '127.0.0.1', '[::1]']);

export function isApprovedIsolatedDatabase(name) {
  return name === APPROVED_DATABASE || HARNESS_DATABASE.test(name);
}

export function requireIsolatedDatabase(url) {
  if (process.env.SAMOSVAL_ISOLATED_TEST !== '1') {
    throw new Error('SAMOSVAL_ISOLATED_TEST=1 is required');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('isolated database target is not approved');
  }

  let database;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error('isolated database target is not approved');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !APPROVED_HOSTS.has(parsed.hostname)
    || !isApprovedIsolatedDatabase(database)
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new Error('isolated database target is not approved');
  }
  return parsed;
}

function isolatedPool() {
  const url = requireIsolatedDatabase(process.env.TEST_DATABASE_URL);
  return new pg.Pool({ connectionString: url.href, max: 2 });
}

function databaseOf(parsed) {
  try {
    return decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error('isolated database target is not approved');
  }
}

/**
 * Connection used for schema DDL (spec 3.10/§6). A db child runs as
 * `samosval_test_app`, which holds only USAGE on `public` plus DML and can
 * never DROP/CREATE SCHEMA, CREATE TABLE, transfer ownership or switch to a
 * runtime role. When the manifest declared `bootstrap-url`, the child receives
 * the bootstrap-admin connection already scoped to its own generated target and
 * every DDL step runs there; the assertions keep running on
 * `TEST_DATABASE_URL`. Without `bootstrap-url` the legacy single-connection
 * path is preserved unchanged.
 */
export function adminUrl() {
  const target = requireIsolatedDatabase(process.env.TEST_DATABASE_URL);
  const targetDatabase = databaseOf(target);
  const raw = process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;
  if (raw === undefined || raw === '') return target;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('isolated bootstrap target is not approved');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !APPROVED_HOSTS.has(parsed.hostname)
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new Error('isolated bootstrap target is not approved');
  }
  const adminDatabase = databaseOf(parsed);
  // The bootstrap connection is scoped to the child's own generated target: it
  // may neither name a shared/common database nor a different run's target.
  if (!isApprovedIsolatedDatabase(adminDatabase) || adminDatabase !== targetDatabase) {
    throw new Error('isolated bootstrap target is not approved');
  }
  return parsed;
}

export function hasPrivilegedSetup() {
  const raw = process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;
  return raw !== undefined && raw !== '';
}

function setupPool() {
  return new pg.Pool({ connectionString: adminUrl().href, max: 1 });
}

/**
 * Fixture DDL a test performs itself (extra import tables, simulated schema
 * drift, session-authorization probes) cannot run as `samosval_test_app`.
 * Those statements use this privileged connection; the assertions keep using
 * `TEST_DATABASE_URL`. Without a bootstrap URL it is the legacy connection.
 *
 * Pass `{ grant: true }` when the statements create tables the app connection
 * must then use: the helper refreshes the app/runtime grants afterwards, the
 * same way the runner does between provisioning and the child process. Probes
 * that intentionally inspect privilege boundaries leave it off.
 */
export async function withAdminClient(fn, { grant = false } = {}) {
  const client = new pg.Client({ connectionString: adminUrl().href });
  await client.connect();
  try {
    const result = await fn(client);
    if (grant && hasPrivilegedSetup()) await grantUnprivilegedAccess(client);
    return result;
  } finally {
    await client.end();
  }
}

// Migration DDL is executed by the privileged connection, so objects it creates
// are owned by that role. The unprivileged roles the assertions and the runtime
// probes use need explicit grants afterwards.
async function grantUnprivilegedAccess(pool) {
  await pool.query('GRANT USAGE ON SCHEMA public TO samosval_test_app, samosval_test_runtime');
  await pool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO samosval_test_app');
  await pool.query('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO samosval_test_app');
  await pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO samosval_test_runtime');
}

export async function resetIsolatedDatabase() {
  const pool = setupPool();
  const privileged = hasPrivilegedSetup();
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    if (privileged) await grantUnprivilegedAccess(pool);
  } finally {
    await pool.end();
  }
}

export function retargetLegacyGuard(sql, filename) {
  const url = requireIsolatedDatabase(process.env.TEST_DATABASE_URL);
  const database = decodeURIComponent(url.pathname.slice(1));
  return transformLegacyMigrationGuard(sql, filename, database, {
    // The legacy helper exemption exists only for the exact legacy name; a
    // generated harness target is validated as a normal generated identifier
    // and the guard is retargeted to that target's own name.
    legacyHelper: database === APPROVED_DATABASE,
    isolated: process.env.SAMOSVAL_ISOLATED_TEST === '1',
  });
}

export async function applyMigrationsThrough(number) {
  if (!Number.isInteger(number) || number < 1) throw new TypeError('migration number must be a positive integer');
  const pool = setupPool();
  const privileged = hasPrivilegedSetup();
  try {
    const applied = await applyMigrations(pool, {
      through: number,
      transformSource: retargetLegacyGuard,
    });
    if (privileged) await grantUnprivilegedAccess(pool);
    return applied;
  } finally {
    await pool.end();
  }
}

export async function seedParallelShiftFixture(options = {}) {
  const pool = isolatedPool();
  const suffix = options.suffix ?? 'parallel_fixture';
  const ids = {
    workspaceId: options.workspaceId ?? `workspace_${suffix}`,
    adminUid: options.adminUid ?? `admin_${suffix}`,
    foremanUid: options.foremanUid ?? `foreman_${suffix}`,
    objectAId: options.objectAId ?? `object_a_${suffix}`,
    objectBId: options.objectBId ?? `object_b_${suffix}`,
    truckId: options.truckId ?? `truck_${suffix}`,
    shiftAId: options.shiftAId ?? `shift_a_${suffix}`,
    shiftBId: options.shiftBId ?? `shift_b_${suffix}`,
  };
  try {
    await pool.query('INSERT INTO workspaces(id) VALUES($1) ON CONFLICT(id) DO NOTHING', [ids.workspaceId]);
    for (const [uid, role] of [[ids.adminUid, 'admin'], [ids.foremanUid, 'foreman']]) {
      await pool.query(
        `INSERT INTO app_users(uid,email,display_name,role,status)
         VALUES($1,$2,$3,$4,'active') ON CONFLICT(uid) DO NOTHING`,
        [uid, `${uid}@example.test`, uid, role]
      );
    }
    for (const objectId of [ids.objectAId, ids.objectBId]) {
      await pool.query(
        `INSERT INTO workspace_objects(workspace_id,object_id,payload)
         VALUES($1,$2,$3) ON CONFLICT(workspace_id,object_id) DO NOTHING`,
        [ids.workspaceId, objectId, { id: objectId, name: objectId }]
      );
    }
    await pool.query(
      `INSERT INTO line_trucks(workspace_id,truck_id,payload)
       VALUES($1,$2,$3) ON CONFLICT(workspace_id,truck_id) DO NOTHING`,
      [ids.workspaceId, ids.truckId, { id: ids.truckId, name: ids.truckId }]
    );
    for (const [shiftId, objectId, workShift, startedAt, actorUid] of [
      [ids.shiftAId, ids.objectAId, 'day', 1795420800000, ids.adminUid],
      [ids.shiftBId, ids.objectBId, 'night', 1795464000000, ids.foremanUid],
    ]) {
      await pool.query(
        `INSERT INTO shifts(workspace_id,shift_id,is_active,payload)
         VALUES($1,$2,true,$3) ON CONFLICT(workspace_id,shift_id) DO NOTHING`,
        [ids.workspaceId, shiftId, {
          id: shiftId,
          objectId,
          objectName: objectId,
          startDate: '23.11.2026',
          startedAt,
          startedBy: actorUid,
          startedByUid: actorUid,
          isActive: true,
          workShift,
        }]
      );
    }
    return ids;
  } finally {
    await pool.end();
  }
}
