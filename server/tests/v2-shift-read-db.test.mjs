import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyMigrationsThrough, withAdminClient } from './helpers/isolated-db.mjs';
import { loadActor } from '../src/shift-access-v2.mjs';
import {
  decodeShiftCursor,
  encodeShiftCursor,
  listVisibleShifts,
  readShiftSnapshot,
} from '../src/shift-read-v2.mjs';

// Visible shift list and scoped snapshot (design §5.1, §6, §8, plan Task 18).
//
// The root starts on the frozen S24 baseline on purpose: an unresolved
// historical row and a restored archive copy can only exist as legacy v1 rows
// that migration 025 classifies, so the fixture must be inserted before 025
// runs (docs/opyt-oshibok.md, lesson 19). 025/026/027 are then applied through
// the privileged bootstrap connection; every assertion stays on the app role.
//
// Trap B (acceptance, §12): list and snapshot of shift A never read or change
// shift B. B keeps its own object, foreman, statuses, logs and revision; its
// fingerprint is compared before and after every A read.

const WORKSPACE = 'main_workspace';
const OTHER_WORKSPACE = 'main_workspace_unused';
const DAY_START = 1795420800000; // 2026-11-23T11:00:00+03:00
const NIGHT_START = 1795453200000; // 2026-11-23T20:00:00+03:00
const LATE_NIGHT = 1795474800000; // 2026-11-24T02:00:00+03:00
const NEXT_DAY = 1795507200000; // 2026-11-24T11:00:00+03:00
const LAST_NIGHT = 1795543200000; // 2026-11-24T21:00:00+03:00

function moscowParts(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ms);
  const part = type => parts.find(item => item.type === type)?.value;
  return { date: `${part('year')}-${part('month')}-${part('day')}`, startDate: `${part('day')}.${part('month')}.${part('year')}` };
}

// Exact published v2 start document (025 requires precisely these 14 keys).
function shiftPayload({ id, objectId, workShift, startedAt, uid, name }) {
  const { date, startDate } = moscowParts(startedAt);
  return {
    payloadSchemaVersion: 2, id, shiftId: id, objectId,
    objectName: `Object ${objectId}`, startDate, date,
    workShift, type: workShift, state: 'active', isActive: true, startedAt,
    startedByUid: uid, startedBy: name,
  };
}

// The exact legacy v1 start document (no payloadSchemaVersion, no UID, no type).
function legacyPayload({ id, objectId, startedAt, isActive, extra = {} }) {
  const { startDate } = moscowParts(startedAt);
  return {
    id, objectId, objectName: `Legacy ${objectId}`, startDate, startedAt,
    startedBy: 'Legacy author', isActive, ...extra,
  };
}

const LIST_ITEM_FIELDS = [
  'shiftId', 'objectId', 'objectName', 'workDate', 'shiftType', 'state',
  'openedAt', 'shiftRevision', 'memberRevisionSummary', 'pendingServerReceipts',
];

test('v2 shift read: visible list, scoped snapshots and trap B', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
  pool.on('error', () => {});
  const prefix = 'read_' + randomUUID().replaceAll('-', '');
  const ids = {
    admin: prefix + '_admin',
    foreman: prefix + '_foreman',
    foremanB: prefix + '_foreman_b',
    outsider: prefix + '_outsider',
  };
  const shift = {
    a: prefix + '_shift_a',
    a2: prefix + '_shift_a2',
    b: prefix + '_shift_b',
    c: prefix + '_shift_c',
    d: prefix + '_shift_d',
    e: prefix + '_shift_e',
    f: prefix + '_shift_f',
    historical: prefix + '_shift_historical',
    restored: prefix + '_shift_restored',
  };
  const object = {
    a: prefix + '_object_a',
    a2: prefix + '_object_a2',
    b: prefix + '_object_b',
    c: prefix + '_object_c',
    d: prefix + '_object_d',
    e: prefix + '_object_e',
    f: prefix + '_object_f',
    historical: prefix + '_object_historical',
    restored: prefix + '_object_restored',
  };
  const truck = {
    a: prefix + '_truck_a',
    b: prefix + '_truck_b',
    detachedA: prefix + '_truck_da',
    detachedB: prefix + '_truck_db',
    detachedDone: prefix + '_truck_dd',
    detachedOther: prefix + '_truck_do',
  };
  const log = { a1: prefix + '_log_a1', a2: prefix + '_log_a2', b1: prefix + '_log_b1', b2: prefix + '_log_b2' };

  const capture = async promise => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error;
    }
  };
  const expectError = async (promise, code, status) => {
    const error = await capture(promise);
    assert.ok(error, `expected ${code}`);
    assert.equal(error.name, 'V2Error', `expected a V2Error, got ${error?.message}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return error;
  };

  try {
    // --- fixture before 025: only a legacy v1 row can become historical ---------
    await applyMigrationsThrough(24);
    await pool.query("INSERT INTO workspaces(id) VALUES ($1) ON CONFLICT(id) DO NOTHING", [WORKSPACE]);
    for (const [uid, name, role] of [
      [ids.admin, 'Read admin', 'admin'],
      [ids.foreman, 'Read foreman', 'foreman'],
      [ids.foremanB, 'Read foreman B', 'foreman'],
      [ids.outsider, 'Read outsider', 'foreman'],
    ]) {
      await pool.query(
        'INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,$4,$5)',
        [uid, `${uid}@example.test`, name, role, 'active'],
      );
    }
    for (const objectId of Object.values(object)) {
      await pool.query(
        'INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',
        [WORKSPACE, objectId, { id: objectId, name: `Object ${objectId}` }],
      );
    }
    for (const truckId of Object.values(truck)) {
      await pool.query(
        'INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)',
        [WORKSPACE, truckId, { id: truckId, number: truckId }],
      );
    }
    // Unresolved historical: no workShift and not active -> historical + NULL type.
    await pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,false,$3)',
      [WORKSPACE, shift.historical, legacyPayload({ id: shift.historical, objectId: object.historical, startedAt: DAY_START, isActive: false })],
    );
    // Restored archive copy: 025 D7 makes it historical regardless of isActive.
    await pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)',
      [WORKSPACE, shift.restored, legacyPayload({
        id: shift.restored, objectId: object.restored, startedAt: DAY_START, isActive: true,
        extra: { restored: true, workShift: 'day' },
      })],
    );

    await applyMigrationsThrough(27);

    // --- live v2 shifts --------------------------------------------------------
    const createShift = (shiftId, objectId, workShift, startedAt) => pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)',
      [WORKSPACE, shiftId, shiftPayload({ id: shiftId, objectId, workShift, startedAt, uid: ids.admin, name: 'Read admin' })],
    );
    await createShift(shift.a, object.a, 'day', NIGHT_START);
    await createShift(shift.a2, object.a2, 'day', NIGHT_START); // same opened_at: tie-break by shift_id
    await createShift(shift.b, object.b, 'night', LAST_NIGHT);
    await createShift(shift.c, object.c, 'night', LATE_NIGHT);
    await createShift(shift.d, object.d, 'day', NEXT_DAY);
    await createShift(shift.e, object.e, 'night', DAY_START);
    await createShift(shift.f, object.f, 'day', NEXT_DAY);

    const rewritePayload = async (shiftId, patch) => {
      const row = (await pool.query('SELECT payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2', [WORKSPACE, shiftId])).rows[0];
      await pool.query(
        'UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
        [WORKSPACE, shiftId, { ...row.payload, ...patch }],
      );
    };
    await rewritePayload(shift.c, { state: 'closing', closing: true, closingStartedAt: Date.now(), closingByUid: ids.admin });
    await rewritePayload(shift.f, { state: 'closed', isActive: false, closedAt: Date.now(), closedByUid: ids.admin });

    const addMember = (shiftId, uid) => pool.query(
      `INSERT INTO shift_members(workspace_id,shift_id,uid,assigned_at,assigned_by_uid)
       VALUES($1,$2,$3,now(),$4)
       ON CONFLICT(workspace_id,shift_id,uid)
       DO UPDATE SET removed_at=NULL, removed_by_uid=NULL, revision=shift_members.revision+1`,
      [WORKSPACE, shiftId, uid, ids.admin],
    );
    await addMember(shift.a, ids.foreman);
    await addMember(shift.c, ids.foreman);
    await addMember(shift.f, ids.foreman);
    await addMember(shift.b, ids.foremanB);

    // The isolated matrix starts nearly empty; the ordinary read right is
    // granted the same way the admin UI would grant it.
    for (const role of ['foreman', 'senior_foreman']) {
      await pool.query(
        `INSERT INTO role_permissions(role,action,allowed) VALUES($1,'tab_line',true)
         ON CONFLICT(role,action) DO UPDATE SET allowed=true`,
        [role],
      );
    }

    await pool.query(
      `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload,status_revision,cycle_revision,ttn_revision)
       VALUES($1,$2,$3,$4,3,2,1)`,
      [WORKSPACE, truck.a, shift.a, { arriveStatus: 'arrived', arriveTimestamp: NIGHT_START }],
    );
    await pool.query(
      `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload,status_revision,cycle_revision,ttn_revision)
       VALUES($1,$2,$3,$4,5,4,3)`,
      [WORKSPACE, truck.b, shift.b, { arriveStatus: 'loaded', arriveTimestamp: LAST_NIGHT }],
    );
    for (const [logId, shiftId, truckId, timestamp] of [
      [log.a1, shift.a, truck.a, NIGHT_START],
      [log.a2, shift.a, truck.a, NIGHT_START + 60000],
      [log.b1, shift.b, truck.b, LAST_NIGHT],
      [log.b2, shift.b, truck.b, LAST_NIGHT + 60000],
    ]) {
      await pool.query(
        'INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)',
        [WORKSPACE, logId, shiftId, truckId, { action: 'arrive', timestamp }],
      );
    }

    // §4.4 detached trips: Task 20 ships the migration; this root proves the
    // read contract against the fixed columns of the design.
    await withAdminClient(async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS detached_open_trips (
        workspace_id text NOT NULL,
        source_shift_id text NOT NULL,
        truck_id text NOT NULL,
        cycle_id text NOT NULL,
        destination_shift_id text NOT NULL,
        state text NOT NULL CHECK (state IN ('open','completed')),
        stage text NOT NULL,
        cycle_revision bigint NOT NULL CHECK (cycle_revision > 0),
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        detached_at timestamptz NOT NULL DEFAULT now(),
        detached_by_uid text,
        completed_at timestamptz,
        completed_by_uid text,
        PRIMARY KEY (workspace_id, source_shift_id, cycle_id)
      )`);
    }, { grant: true });
    for (const [sourceShiftId, destinationShiftId, truckId, cycleId, state, stage, revision] of [
      [shift.a, shift.b, truck.detachedA, prefix + '_cycle_a', 'open', 'load', 2],
      [shift.b, shift.a, truck.detachedB, prefix + '_cycle_b', 'open', 'arrive', 1],
      [shift.a, shift.b, truck.detachedDone, prefix + '_cycle_done', 'completed', 'ttn', 3],
      [shift.d, shift.e, truck.detachedOther, prefix + '_cycle_other', 'open', 'load', 1],
    ]) {
      await pool.query(
        `INSERT INTO detached_open_trips(workspace_id,source_shift_id,truck_id,cycle_id,destination_shift_id,state,stage,cycle_revision,detached_by_uid)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [WORKSPACE, sourceShiftId, truckId, cycleId, destinationShiftId, state, stage, revision, ids.admin],
      );
    }

    const admin = await loadActor(pool, ids.admin);
    const foreman = await loadActor(pool, ids.foreman);
    const foremanB = await loadActor(pool, ids.foremanB);
    const outsider = await loadActor(pool, ids.outsider);

    // Shift B fingerprint: counts, revisions and a stable payload checksum.
    const fingerprint = async shiftId => (await pool.query(
      `SELECT (SELECT count(*)::text FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2) AS statuses,
              (SELECT count(*)::text FROM line_logs WHERE workspace_id=$1 AND shift_id=$2) AS logs,
              (SELECT COALESCE(sum(status_revision+cycle_revision+ttn_revision),0)::text
                 FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2) AS status_revisions,
              (SELECT COALESCE(md5(string_agg(log_id || ':' || payload::text, ',' ORDER BY log_id)),'')
                 FROM line_logs WHERE workspace_id=$1 AND shift_id=$2) AS log_checksum,
              (SELECT revision::text FROM shifts WHERE workspace_id=$1 AND shift_id=$2) AS shift_revision,
              (SELECT COALESCE(sum(revision),0)::text FROM shift_members WHERE workspace_id=$1 AND shift_id=$2) AS member_revisions`,
      [WORKSPACE, shiftId],
    )).rows[0];

    await t.test('legacy fixtures are historical/unresolved and never listed', async () => {
      const rows = (await pool.query(
        'SELECT shift_id,state,shift_type,shift_type_resolution,is_active FROM shifts WHERE workspace_id=$1 AND shift_id = ANY($2::text[])',
        [WORKSPACE, [shift.historical, shift.restored]],
      )).rows;
      const byId = new Map(rows.map(row => [row.shift_id, row]));
      assert.equal(byId.get(shift.historical).state, 'historical');
      assert.equal(byId.get(shift.historical).shift_type, null);
      assert.equal(byId.get(shift.historical).shift_type_resolution, 'unresolved');
      assert.equal(byId.get(shift.restored).state, 'historical');
      assert.equal(byId.get(shift.restored).is_active, false);

      const all = await listVisibleShifts(pool, admin, { workspaceId: WORKSPACE, limit: 100 });
      const listed = all.items.map(item => item.shiftId);
      assert.equal(listed.includes(shift.historical), false, 'unresolved historical must never be listed');
      assert.equal(listed.includes(shift.restored), false, 'restored copy must never be listed');
      assert.deepEqual(listed, [shift.b, shift.d, shift.c, shift.a, shift.a2, shift.e]);
      // historical is not a list state at all: the whitelist refuses it.
      await expectError(listVisibleShifts(pool, admin, { workspaceId: WORKSPACE, state: 'historical' }), 'invalid-command', 400);
      await expectError(listVisibleShifts(pool, admin, { workspaceId: WORKSPACE, state: 'active,closed' }), 'invalid-command', 400);
    });

    await t.test('list is paginated, ordered by opened_at DESC then shift_id ASC and scoped', async () => {
      const collected = [];
      let cursor = null;
      let pages = 0;
      do {
        const page = await listVisibleShifts(pool, admin, { workspaceId: WORKSPACE, limit: 2, cursor });
        for (const item of page.items) {
          assert.deepEqual(Object.keys(item).sort(), [...LIST_ITEM_FIELDS].sort());
          assert.equal(typeof item.shiftRevision, 'number');
          assert.deepEqual(Object.keys(item.memberRevisionSummary).sort(), ['activeMembers', 'revisionSum']);
          assert.equal(item.pendingServerReceipts, 0);
        }
        collected.push(...page.items.map(item => item.shiftId));
        cursor = page.nextCursor;
        pages += 1;
        assert.ok(pages < 10, 'pagination must terminate');
      } while (cursor);
      assert.deepEqual(collected, [shift.b, shift.d, shift.c, shift.a, shift.a2, shift.e]);
      assert.equal(pages, 3);

      const first = await listVisibleShifts(pool, admin, { workspaceId: WORKSPACE, limit: 100 });
      const itemA = first.items.find(item => item.shiftId === shift.a);
      assert.equal(itemA.objectId, object.a);
      assert.equal(itemA.objectName, `Object ${object.a}`);
      assert.equal(itemA.workDate, '2026-11-23');
      assert.equal(itemA.shiftType, 'day');
      assert.equal(itemA.state, 'active');
      assert.equal(new Date(itemA.openedAt).getTime(), NIGHT_START);
      assert.equal(itemA.shiftRevision, 1);
      assert.deepEqual(itemA.memberRevisionSummary, { activeMembers: 1, revisionSum: 1 });
      const itemC = first.items.find(item => item.shiftId === shift.c);
      assert.equal(itemC.state, 'closing');

      // A foreman sees only active memberships; admin sees every workspace shift.
      const foremanList = await listVisibleShifts(pool, foreman, { workspaceId: WORKSPACE, limit: 100 });
      assert.deepEqual(foremanList.items.map(item => item.shiftId), [shift.c, shift.a]);
      const foremanBList = await listVisibleShifts(pool, foremanB, { workspaceId: WORKSPACE, limit: 100 });
      assert.deepEqual(foremanBList.items.map(item => item.shiftId), [shift.b]);
      const outsiderList = await listVisibleShifts(pool, outsider, { workspaceId: WORKSPACE, limit: 100 });
      assert.deepEqual(outsiderList.items, []);
      assert.equal(outsiderList.nextCursor, null);
      // Another workspace is never mixed into this one.
      const otherList = await listVisibleShifts(pool, admin, { workspaceId: OTHER_WORKSPACE, limit: 100 });
      assert.deepEqual(otherList.items, []);
    });

    await t.test('list validates state, limit and cursor without touching SQL', async () => {
      for (const state of ['closed', 'historical', 'active,historical', 'draft', 'active,,closing']) {
        await expectError(listVisibleShifts(pool, admin, { workspaceId: WORKSPACE, state }), 'invalid-command', 400);
      }
      for (const limit of [0, -1, 101, 1.5, 'abc', '10x', null]) {
        await expectError(listVisibleShifts(pool, admin, { workspaceId: WORKSPACE, limit }), 'invalid-command', 400);
      }
      for (const cursor of ['', 'not-a-cursor', 'v2.1.%%%', 'v1.0.eyJvIjoiMjAyNi0xMS0yM1QxNzowMDowMC4wMDBaIiwicyI6IngifQ', 'v2.1.' + Buffer.from('{"o":"yesterday","s":"x"}').toString('base64url')]) {
        await expectError(listVisibleShifts(pool, admin, { workspaceId: WORKSPACE, cursor }), 'invalid-command', 400);
      }
      // Defaults: active+closing, limit 50, and a stable opaque round-trip.
      const page = await listVisibleShifts(pool, admin, { workspaceId: WORKSPACE, limit: 1 });
      assert.equal(page.items.length, 1);
      const decoded = decodeShiftCursor(page.nextCursor);
      assert.equal(decoded.shiftId, shift.b);
      assert.equal(decoded.openedAt.getTime(), LAST_NIGHT);
      assert.equal(encodeShiftCursor(decoded), page.nextCursor);
      assert.match(page.nextCursor, /^v2\.1\.[A-Za-z0-9_-]+$/);
      await expectError(listVisibleShifts(pool, { uid: '', role: 'foreman' }, { workspaceId: WORKSPACE }), 'unauthenticated', 401);
    });

    await t.test('snapshot is scoped, complete and marks every entity with workspace and shift', async () => {
      const before = await fingerprint(shift.b);
      const snapshot = await readShiftSnapshot(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.a });
      const after = await fingerprint(shift.b);
      assert.deepEqual(after, before, 'snapshot of A must not change B');

      assert.equal(snapshot.protocolVersion, 2);
      assert.equal(snapshot.workspaceId, WORKSPACE);
      assert.equal(snapshot.shiftId, shift.a);
      assert.equal(snapshot.shiftRevision, 1);
      assert.equal(typeof snapshot.serverGeneration, 'number');
      assert.ok(snapshot.serverGeneration >= 1);

      assert.equal(snapshot.shift.workspaceId, WORKSPACE);
      assert.equal(snapshot.shift.shiftId, shift.a);
      assert.equal(snapshot.shift.objectId, object.a);
      assert.equal(snapshot.shift.workDate, '2026-11-23');
      assert.equal(snapshot.shift.shiftType, 'day');
      assert.equal(snapshot.shift.state, 'active');
      assert.equal(new Date(snapshot.shift.openedAt).getTime(), NIGHT_START);
      assert.equal(snapshot.shift.revision, 1);
      assert.equal(snapshot.shift.payload.shiftId, shift.a);

      assert.equal(snapshot.members.length, 1);
      assert.deepEqual(
        snapshot.members.map(member => [member.workspaceId, member.shiftId, member.uid]),
        [[WORKSPACE, shift.a, ids.foreman]],
      );
      assert.equal(snapshot.members[0].revision, 1);

      assert.deepEqual(snapshot.statuses.map(status => [status.workspaceId, status.shiftId, status.truckId]), [
        [WORKSPACE, shift.a, truck.a],
      ]);
      assert.equal(snapshot.statuses[0].statusRevision, 3);
      assert.equal(snapshot.statuses[0].cycleRevision, 2);
      assert.equal(snapshot.statuses[0].ttnRevision, 1);

      assert.deepEqual(snapshot.logs.map(entry => [entry.workspaceId, entry.shiftId, entry.logId]), [
        [WORKSPACE, shift.a, log.a1],
        [WORKSPACE, shift.a, log.a2],
      ]);
      // B never leaks into A: no status, log, member or truck of B. The only
      // legitimate reference to B is a detached-trip label (§5.1), checked
      // separately below, so it is excluded from this scoped payload check.
      const { detachedOpenTrips: _detached, ...scopedSnapshot } = snapshot;
      const serialized = JSON.stringify(scopedSnapshot);
      for (const forbidden of [log.b1, log.b2, truck.b, shift.b]) {
        assert.equal(serialized.includes(forbidden), false, `A snapshot must not contain B entity ${forbidden}`);
      }

      assert.deepEqual(snapshot.revisions, {
        shift: 1,
        members: 1,
        statuses: 3,
        cycles: 2,
        ttn: 1,
        logs: 2,
        detached: 2,
      });
      assert.deepEqual(after, before, 'snapshot of A must not change B (repeat)');
    });

    await t.test('detached open trips appear on both sides with both labels and safe fields only', async () => {
      const snapshotA = await readShiftSnapshot(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.a });
      assert.equal(snapshotA.detachedOpenTrips.length, 2);
      const tripsA = snapshotA.detachedOpenTrips.map(trip => trip.cycleId).sort();
      assert.deepEqual(tripsA, [prefix + '_cycle_a', prefix + '_cycle_b']);
      for (const trip of snapshotA.detachedOpenTrips) {
        assert.equal(trip.workspaceId, WORKSPACE);
        assert.equal(trip.state, 'open');
        assert.equal(typeof trip.stage, 'string');
        assert.equal(typeof trip.cycleRevision, 'number');
        assert.ok(trip.sourceShift.shiftId && trip.destinationShift.shiftId);
        assert.equal(trip.sourceShift.workspaceId, WORKSPACE);
        assert.equal(trip.destinationShift.workspaceId, WORKSPACE);
        assert.equal(trip.sourceShift.objectName.startsWith('Object '), true);
        assert.equal(trip.destinationShift.objectName.startsWith('Object '), true);
        assert.equal(trip.sourceShiftId, trip.sourceShift.shiftId);
        assert.equal(trip.destinationShiftId, trip.destinationShift.shiftId);
        // Safe UI fields only: no payload copy and no actor uid.
        for (const key of ['payload', 'detachedByUid', 'completedByUid']) {
          assert.equal(Object.hasOwn(trip, key), false, `detached trip must not expose ${key}`);
        }
        assert.deepEqual(Object.keys(trip).sort(), [
          'cycleId', 'cycleRevision', 'destinationShift', 'destinationShiftId', 'detachedAt',
          'sourceShift', 'sourceShiftId', 'stage', 'state', 'truckId', 'workspaceId',
        ]);
      }
      // The completed row and the unrelated pair stay out.
      assert.equal(snapshotA.detachedOpenTrips.some(trip => trip.cycleId === prefix + '_cycle_done'), false);
      assert.equal(snapshotA.detachedOpenTrips.some(trip => trip.cycleId === prefix + '_cycle_other'), false);

      const snapshotB = await readShiftSnapshot(pool, foremanB, { workspaceId: WORKSPACE, shiftId: shift.b });
      assert.deepEqual(snapshotB.detachedOpenTrips.map(trip => trip.cycleId).sort(), tripsA);
    });

    await t.test('a hidden, missing or foreign shift is 404 shift-not-visible', async () => {
      await expectError(readShiftSnapshot(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.b }), 'shift-not-visible', 404);
      await expectError(readShiftSnapshot(pool, outsider, { workspaceId: WORKSPACE, shiftId: shift.a }), 'shift-not-visible', 404);
      await expectError(readShiftSnapshot(pool, foreman, { workspaceId: WORKSPACE, shiftId: prefix + '_missing' }), 'shift-not-visible', 404);
      await expectError(readShiftSnapshot(pool, admin, { workspaceId: OTHER_WORKSPACE, shiftId: shift.a }), 'shift-not-visible', 404);
      // Admin reads any workspace shift without a membership.
      const adminSnapshot = await readShiftSnapshot(pool, admin, { workspaceId: WORKSPACE, shiftId: shift.b });
      assert.equal(adminSnapshot.shiftId, shift.b);
      assert.equal(adminSnapshot.statuses[0].truckId, truck.b);
    });

    await t.test('a closed shift answers 410 for commands but stays readable for its member', async () => {
      const snapshot = await readShiftSnapshot(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.f });
      assert.equal(snapshot.shift.state, 'closed');
      assert.equal(snapshot.shift.closedAt !== null, true);
      await expectError(readShiftSnapshot(pool, outsider, { workspaceId: WORKSPACE, shiftId: shift.f }), 'shift-not-visible', 404);
      // A historical legacy row has no membership and is not disclosed to a foreman.
      await expectError(readShiftSnapshot(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.historical }), 'shift-not-visible', 404);
      const historical = await readShiftSnapshot(pool, admin, { workspaceId: WORKSPACE, shiftId: shift.historical });
      assert.equal(historical.shift.state, 'historical');
      assert.equal(historical.shift.shiftType, null);
      assert.equal(historical.shift.shiftTypeResolution, 'unresolved');
    });

    await t.test('trap B: repeated A reads keep B fingerprint and never expose B rows', async () => {
      const before = await fingerprint(shift.b);
      for (let index = 0; index < 3; index += 1) {
        await listVisibleShifts(pool, foreman, { workspaceId: WORKSPACE, limit: 1 });
        const snapshot = await readShiftSnapshot(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.a });
        assert.equal(snapshot.logs.length, 2);
        assert.equal(snapshot.statuses.length, 1);
      }
      const after = await fingerprint(shift.b);
      assert.deepEqual(after, before);
      // B still has its own complete data, untouched.
      assert.equal(before.statuses, '1');
      assert.equal(before.logs, '2');
      assert.equal(before.status_revisions, '12');
      assert.equal(before.member_revisions, '1');
    });
  } finally {
    await pool.end();
  }
});
