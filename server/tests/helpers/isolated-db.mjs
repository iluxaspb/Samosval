import pg from 'pg';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { transformLegacyMigrationGuard } from '../../scripts/isolated-db/legacy-guards.mjs';

const APPROVED_DATABASE = 'samosval_parallel_shifts_test';
const APPROVED_HOSTS = new Set(['postgres', 'localhost', '127.0.0.1', '[::1]']);

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
    || database !== APPROVED_DATABASE
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

export async function resetIsolatedDatabase() {
  const pool = isolatedPool();
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
  } finally {
    await pool.end();
  }
}

export function retargetLegacyGuard(sql, filename) {
  requireIsolatedDatabase(process.env.TEST_DATABASE_URL);
  return transformLegacyMigrationGuard(sql, filename, APPROVED_DATABASE, {
    legacyHelper: true,
    isolated: process.env.SAMOSVAL_ISOLATED_TEST === '1',
  });
}

export async function applyMigrationsThrough(number) {
  if (!Number.isInteger(number) || number < 1) throw new TypeError('migration number must be a positive integer');
  const pool = isolatedPool();
  try {
    return await applyMigrations(pool, {
      through: number,
      transformSource: retargetLegacyGuard,
    });
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
