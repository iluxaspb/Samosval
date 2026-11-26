import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { appendReplicaBatch } from '../src/replica-store.mjs';
import { normalizeReplicaOperation } from '../src/replica-materialize.mjs';
import {
  applyReplicaHeadTransition,
  promoteReplicaPending,
  verifyReplicaHeads,
} from '../src/replica-heads.mjs';
import {
  applyMigrationsThrough,
  requireIsolatedDatabase,
  seedParallelShiftFixture,
  withAdminClient,
} from './helpers/isolated-db.mjs';

// Task 13 — head/pending/delete materializer state machine (design §4.10).
//
// Every test works in its own workspace: 026 makes replica_stream append-only at
// the database level, so a test may not delete another test's history. The S24
// template is provisioned by the runner; the file seeds the legacy fixture on
// 024, then applies 025 and 026 itself, exactly like the sibling replica test.
const connectionString = process.env.TEST_DATABASE_URL;
let approved = false;
if (connectionString && process.env.SAMOSVAL_ISOLATED_TEST === '1') {
  try {
    requireIsolatedDatabase(connectionString);
    approved = true;
  } catch {}
}

const poolForTest = () => new pg.Pool({ connectionString, max: 4, application_name: 'zz_pending_materialize' });
let ids;
let counter = 0;

test.before(async () => {
  if (!approved) return;
  ids = await seedParallelShiftFixture({ suffix: 'pending_materialize' });
  await applyMigrationsThrough(25);
  await applyMigrationsThrough(26);
  const pool = poolForTest();
  try {
    // The seeded legacy rows are historical evidence, not live line parents.
    await pool.query(
      "UPDATE shifts SET state='historical',is_active=false WHERE workspace_id=$1",
      [ids.workspaceId],
    );
  } finally {
    await pool.end();
  }
});

const pathFor = (ws, collection, documentId) => collection === 'users'
  ? `users/${documentId}`
  : `workspaces/${ws}/${collection}/${documentId}`;

const setOp = (ws, id, collection, documentId, data) => ({
  id,
  protocolVersion: 2,
  kind: 'doc.set',
  payload: {
    collection,
    path: pathFor(ws, collection, documentId),
    data: { ...data, id: documentId },
  },
});

const deleteOp = (ws, id, collection, documentId) => ({
  id,
  protocolVersion: 2,
  kind: 'doc.delete',
  payload: { collection, path: pathFor(ws, collection, documentId) },
});

function shiftData(shiftId, objectId, workShift = 'day', startedAt = 1795420800000) {
  return {
    payloadSchemaVersion: 2,
    id: shiftId,
    shiftId,
    objectId,
    objectName: 'Replica object snapshot',
    startDate: '23.11.2026',
    date: '2026-11-23',
    startedAt,
    startedBy: 'Replica Admin',
    startedByUid: ids.adminUid,
    isActive: true,
    state: 'active',
    workShift,
    type: workShift,
  };
}

async function newWorkspace(pool, suffix) {
  const ws = `ws_pending_${suffix}_${++counter}`;
  await pool.query('INSERT INTO workspaces(id) VALUES($1) ON CONFLICT(id) DO NOTHING', [ws]);
  await pool.query(
    'INSERT INTO replica_cursor(workspace_id,f2s_seq,s2f_seq) VALUES($1,0,0)',
    [ws],
  );
  await pool.query(
    "INSERT INTO server_authority(workspace_id,provider,generation) VALUES($1,'firebase',1)",
    [ws],
  );
  return ws;
}

async function append(pool, ws, baseSeq, operations) {
  return appendReplicaBatch(pool, ids.adminUid, { baseSeq, operations }, ws);
}

async function head(pool, ws, collection, documentId) {
  return (await pool.query(
    `SELECT head_seq,head_kind,canonical_present,applied_seq,shift_id,truck_id,object_id,user_uid,updated_at
       FROM replica_document_heads
      WHERE workspace_id=$1 AND collection=$2 AND document_id=$3`,
    [ws, collection, documentId],
  )).rows[0];
}

async function objectRow(pool, ws, objectId) {
  return (await pool.query(
    'SELECT payload,revision FROM workspace_objects WHERE workspace_id=$1 AND object_id=$2',
    [ws, objectId],
  )).rows[0];
}

async function userRow(pool, uid) {
  return (await pool.query(
    'SELECT uid,email,display_name,role,status,profile,revision FROM app_users WHERE uid=$1',
    [uid],
  )).rows[0];
}

async function streamHash(pool, ws, seq) {
  return (await pool.query(
    "SELECT sha256 FROM replica_stream WHERE workspace_id=$1 AND direction='f2s' AND seq=$2",
    [ws, seq],
  )).rows[0]?.sha256;
}

async function pending(pool, ws, collection, documentId) {
  return (await pool.query(
    `SELECT stream_seq,shift_id,truck_id,log_id,missing_shift,missing_truck
       FROM replica_pending_documents
      WHERE workspace_id=$1 AND collection=$2 AND document_id=$3`,
    [ws, collection, documentId],
  )).rows[0];
}

async function statusRow(pool, ws, truckId) {
  return (await pool.query(
    'SELECT shift_id,payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2',
    [ws, truckId],
  )).rows[0];
}

async function logRow(pool, ws, logId) {
  return (await pool.query(
    'SELECT shift_id,truck_id,payload FROM line_logs WHERE workspace_id=$1 AND log_id=$2',
    [ws, logId],
  )).rows[0];
}

async function streamCount(pool, ws) {
  return Number((await pool.query(
    'SELECT count(*)::int AS n FROM replica_stream WHERE workspace_id=$1', [ws],
  )).rows[0].n);
}

async function cursor(pool, ws) {
  return Number((await pool.query(
    'SELECT f2s_seq FROM replica_cursor WHERE workspace_id=$1', [ws],
  )).rows[0].f2s_seq);
}

// ---------------------------------------------------------------------------
// Pending permutations: status/log may arrive before shift or truck.
// ---------------------------------------------------------------------------
test('status before both parents stays pending, shift then truck promotes once', { skip: !approved }, async () => {
  const pool = poolForTest();
  const ws = await newWorkspace(pool, 'status_first');
  const shiftId = 'shift_late';
  const truckId = 'truck_late';
  try {
    await append(pool, ws, 0, [
      setOp(ws, 'op-status-1', 'truckStatus', truckId, { shiftId, onLine: true }),
    ]);
    let h = await head(pool, ws, 'truckStatus', truckId);
    assert.equal(Number(h.head_seq), 1);
    assert.equal(h.head_kind, 'doc.set');
    assert.equal(h.canonical_present, false);
    assert.equal(h.applied_seq, null);
    let p = await pending(pool, ws, 'truckStatus', truckId);
    assert.equal(Number(p.stream_seq), 1);
    assert.equal(p.missing_shift, true);
    assert.equal(p.missing_truck, true);
    assert.equal(await statusRow(pool, ws, truckId), undefined);

    const objectId = 'object_late';
    await append(pool, ws, 1, [
      setOp(ws, 'op-obj-late', 'objects', objectId, { name: 'Object' }),
      setOp(ws, 'op-shift-late', 'shift', shiftId, shiftData(shiftId, objectId)),
    ]);
    p = await pending(pool, ws, 'truckStatus', truckId);
    assert.equal(p.missing_shift, false);
    assert.equal(p.missing_truck, true);
    assert.equal(await statusRow(pool, ws, truckId), undefined);

    await append(pool, ws, 3, [
      setOp(ws, 'op-truck-late', 'trucks', truckId, { name: 'Truck' }),
    ]);
    h = await head(pool, ws, 'truckStatus', truckId);
    assert.equal(Number(h.head_seq), 1, 'promotion keeps the status stream generation');
    assert.equal(h.canonical_present, true);
    assert.equal(Number(h.applied_seq), 1);
    assert.equal(await pending(pool, ws, 'truckStatus', truckId), undefined);
    const status = await statusRow(pool, ws, truckId);
    assert.equal(status.shift_id, shiftId);
  } finally {
    await pool.end();
  }
});

test('truck before status before shift: pending routing uses both indexes', { skip: !approved }, async () => {
  const pool = poolForTest();
  const ws = await newWorkspace(pool, 'truck_first');
  const shiftId = 'shift_second';
  const truckId = 'truck_first';
  const objectId = 'object_second';
  try {
    await append(pool, ws, 0, [
      setOp(ws, 'op-truck-1', 'trucks', truckId, { name: 'Truck' }),
      setOp(ws, 'op-status-1', 'truckStatus', truckId, { shiftId, onLine: true }),
    ]);
    const p = await pending(pool, ws, 'truckStatus', truckId);
    assert.equal(p.missing_shift, true);
    assert.equal(p.missing_truck, false);
    assert.equal(await statusRow(pool, ws, truckId), undefined);

    await append(pool, ws, 2, [
      setOp(ws, 'op-obj-1', 'objects', objectId, { name: 'Object' }),
      setOp(ws, 'op-shift-1', 'shift', shiftId, shiftData(shiftId, objectId)),
    ]);
    assert.equal(await pending(pool, ws, 'truckStatus', truckId), undefined);
    assert.equal((await statusRow(pool, ws, truckId)).shift_id, shiftId);
  } finally {
    await pool.end();
  }
});

test('log before shift/truck stays pending and promotes when both arrive', { skip: !approved }, async () => {
  const pool = poolForTest();
  const ws = await newWorkspace(pool, 'log_first');
  const shiftId = 'shift_log';
  const truckId = 'truck_log';
  const logId = 'log_late';
  const objectId = 'object_log';
  try {
    await append(pool, ws, 0, [
      setOp(ws, 'op-log-1', 'logs', logId, { shiftId, truckId, volume: 24, timestamp: 1795465000000 }),
    ]);
    const p = await pending(pool, ws, 'logs', logId);
    assert.equal(Number(p.stream_seq), 1);
    assert.equal(p.missing_shift, true);
    assert.equal(p.missing_truck, true);
    assert.equal(await logRow(pool, ws, logId), undefined);

    await append(pool, ws, 1, [
      setOp(ws, 'op-obj-log', 'objects', objectId, { name: 'Object' }),
      setOp(ws, 'op-shift-log', 'shift', shiftId, shiftData(shiftId, objectId)),
    ]);
    assert.equal((await pending(pool, ws, 'logs', logId)).missing_truck, true);
    await append(pool, ws, 3, [
      setOp(ws, 'op-truck-log', 'trucks', truckId, { name: 'Truck' }),
    ]);
    assert.equal(await pending(pool, ws, 'logs', logId), undefined);
    const row = await logRow(pool, ws, logId);
    assert.equal(row.shift_id, shiftId);
    assert.equal(row.truck_id, truckId);
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Generation state machine: pending set→set, pending→delete, delete→set reuse.
// ---------------------------------------------------------------------------
test('pending set→newer set replaces the staged generation; delete then recreate starts a new one', { skip: !approved }, async () => {
  const pool = poolForTest();
  const ws = await newWorkspace(pool, 'generations');
  const shiftId = 'shift_gen';
  const truckId = 'truck_gen';
  const logId = 'log_gen';
  try {
    await append(pool, ws, 0, [
      setOp(ws, 'op-status-1', 'truckStatus', truckId, { shiftId, onLine: true, version: 1 }),
    ]);
    assert.equal(Number((await pending(pool, ws, 'truckStatus', truckId)).stream_seq), 1);

    await append(pool, ws, 1, [
      setOp(ws, 'op-status-2', 'truckStatus', truckId, { shiftId, onLine: true, version: 2 }),
    ]);
    let h = await head(pool, ws, 'truckStatus', truckId);
    assert.equal(Number(h.head_seq), 2);
    assert.equal(h.canonical_present, false);
    const p = await pending(pool, ws, 'truckStatus', truckId);
    assert.equal(Number(p.stream_seq), 2);
    assert.equal(await statusRow(pool, ws, truckId), undefined, 'the stale canonical generation must be gone');

    await append(pool, ws, 2, [
      deleteOp(ws, 'op-status-3', 'truckStatus', truckId),
    ]);
    h = await head(pool, ws, 'truckStatus', truckId);
    assert.equal(Number(h.head_seq), 3);
    assert.equal(h.head_kind, 'doc.delete');
    assert.equal(h.canonical_present, false);
    assert.equal(Number(h.applied_seq), 3);
    assert.equal(await pending(pool, ws, 'truckStatus', truckId), undefined);

    await append(pool, ws, 3, [
      setOp(ws, 'op-status-4', 'truckStatus', truckId, { shiftId, onLine: true, version: 4 }),
    ]);
    h = await head(pool, ws, 'truckStatus', truckId);
    assert.equal(Number(h.head_seq), 4);
    assert.equal(h.canonical_present, false);
    assert.equal(Number((await pending(pool, ws, 'truckStatus', truckId)).stream_seq), 4);

    // A log id is reusable: delete then set is a new generation, not a ban.
    const objectId = 'object_gen';
    await append(pool, ws, 4, [
      setOp(ws, 'op-obj-gen', 'objects', objectId, { name: 'Object' }),
      setOp(ws, 'op-shift-gen', 'shift', shiftId, shiftData(shiftId, objectId)),
      setOp(ws, 'op-truck-gen', 'trucks', truckId, { name: 'Truck' }),
      setOp(ws, 'op-log-gen-1', 'logs', logId, { shiftId, truckId, volume: 10 }),
    ]);
    assert.ok(await logRow(pool, ws, logId));
    await append(pool, ws, 8, [
      deleteOp(ws, 'op-log-gen-2', 'logs', logId),
    ]);
    assert.equal(await logRow(pool, ws, logId), undefined);
    await append(pool, ws, 9, [
      setOp(ws, 'op-log-gen-3', 'logs', logId, { shiftId, truckId, volume: 12 }),
    ]);
    assert.equal((await logRow(pool, ws, logId)).payload.volume, 12);
    assert.equal(Number((await head(pool, ws, 'logs', logId)).head_seq), 10);
  } finally {
    await pool.end();
  }
});

test('status A becomes pending B, arrival A does nothing and arrival B promotes', { skip: !approved }, async () => {
  const pool = poolForTest();
  const ws = await newWorkspace(pool, 'status_a_to_b');
  const shiftA = 'shift_a_live';
  const shiftB = 'shift_b_late';
  const objectA = 'object_a_live';
  const objectB = 'object_b_late';
  const truckId = 'truck_ab';
  try {
    await append(pool, ws, 0, [
      setOp(ws, 'op-obj-a', 'objects', objectA, { name: 'A' }),
      setOp(ws, 'op-obj-b', 'objects', objectB, { name: 'B' }),
      setOp(ws, 'op-shift-a', 'shift', shiftA, shiftData(shiftA, objectA, 'day')),
      setOp(ws, 'op-truck-ab', 'trucks', truckId, { name: 'Truck' }),
      setOp(ws, 'op-status-a', 'truckStatus', truckId, { shiftId: shiftA, onLine: true }),
    ]);
    assert.equal((await statusRow(pool, ws, truckId)).shift_id, shiftA);

    await append(pool, ws, 5, [
      setOp(ws, 'op-status-b', 'truckStatus', truckId, { shiftId: shiftB, onLine: true }),
    ]);
    assert.equal(await statusRow(pool, ws, truckId), undefined, 'A is removed before B commits');
    let h = await head(pool, ws, 'truckStatus', truckId);
    assert.equal(Number(h.head_seq), 6);
    assert.equal(h.canonical_present, false);
    assert.equal(Number((await pending(pool, ws, 'truckStatus', truckId)).stream_seq), 6);

    // A late arrival of A and a replay of B are both no-ops: they cannot resurrect.
    const replayA = await append(pool, ws, 6, [
      setOp(ws, 'op-status-a', 'truckStatus', truckId, { shiftId: shiftA, onLine: true }),
    ]);
    assert.equal(replayA.applied, 0);
    const replayB = await append(pool, ws, 6, [
      setOp(ws, 'op-status-b', 'truckStatus', truckId, { shiftId: shiftB, onLine: true }),
    ]);
    assert.equal(replayB.applied, 0);
    assert.equal(await statusRow(pool, ws, truckId), undefined);

    await append(pool, ws, 6, [
      setOp(ws, 'op-shift-b', 'shift', shiftB, shiftData(shiftB, objectB, 'night')),
    ]);
    assert.equal((await statusRow(pool, ws, truckId)).shift_id, shiftB);
    assert.equal(await pending(pool, ws, 'truckStatus', truckId), undefined);
  } finally {
    await pool.end();
  }
});

test('delete before parents settles a tombstone and no later parent resurrects it', { skip: !approved }, async () => {
  const pool = poolForTest();
  const ws = await newWorkspace(pool, 'delete_first');
  const shiftId = 'shift_after_delete';
  const truckId = 'truck_after_delete';
  const objectId = 'object_after_delete';
  try {
    await append(pool, ws, 0, [
      deleteOp(ws, 'op-delete-1', 'truckStatus', truckId),
    ]);
    let h = await head(pool, ws, 'truckStatus', truckId);
    assert.equal(h.head_kind, 'doc.delete');
    assert.equal(h.canonical_present, false);
    assert.equal(Number(h.applied_seq), 1);
    assert.equal(h.truck_id, truckId);
    assert.equal(await pending(pool, ws, 'truckStatus', truckId), undefined);

    await append(pool, ws, 1, [
      setOp(ws, 'op-obj-after', 'objects', objectId, { name: 'Object' }),
      setOp(ws, 'op-shift-after', 'shift', shiftId, shiftData(shiftId, objectId)),
      setOp(ws, 'op-truck-after', 'trucks', truckId, { name: 'Truck' }),
    ]);
    assert.equal(await statusRow(pool, ws, truckId), undefined, 'parent arrival must not resurrect a delete');
    assert.equal(await pending(pool, ws, 'truckStatus', truckId), undefined);
    assert.equal(Number((await head(pool, ws, 'truckStatus', truckId)).head_seq), 1);

    await append(pool, ws, 4, [
      setOp(ws, 'op-status-new', 'truckStatus', truckId, { shiftId, onLine: true }),
    ]);
    assert.equal((await statusRow(pool, ws, truckId)).shift_id, shiftId);
    await append(pool, ws, 5, [
      deleteOp(ws, 'op-status-delete', 'truckStatus', truckId),
    ]);
    assert.equal(await statusRow(pool, ws, truckId), undefined);
    assert.equal(Number((await head(pool, ws, 'truckStatus', truckId)).head_seq), 6);
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Head CAS: lower and equal generations.
// ---------------------------------------------------------------------------
test('lower generation is a stale no-op, equal hash is a replay and equal seq with another hash conflicts', { skip: !approved }, async () => {
  const pool = poolForTest();
  const ws = await newWorkspace(pool, 'head_cas');
  const truckId = 'truck_cas';
  const first = setOp(ws, 'op-cas-1', 'trucks', truckId, { name: 'first' });
  const second = setOp(ws, 'op-cas-2', 'trucks', truckId, { name: 'second' });
  try {
    await append(pool, ws, 0, [first, second]);
    const before = await head(pool, ws, 'trucks', truckId);
    const revision = (await pool.query(
      'SELECT revision FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [ws, truckId],
    )).rows[0].revision;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const stale = await applyReplicaHeadTransition(client, ws, first, {
        seq: 1,
        normalized: normalizeReplicaOperation(first),
      });
      assert.equal(stale.status, 'stale');
      const replay = await applyReplicaHeadTransition(client, ws, second, {
        seq: 2,
        normalized: normalizeReplicaOperation(second),
      });
      assert.equal(replay.status, 'replay');
      await assert.rejects(
        () => applyReplicaHeadTransition(client, ws, setOp(ws, 'op-cas-2', 'trucks', truckId, { name: 'forged' }), {
          seq: 2,
          normalized: normalizeReplicaOperation(setOp(ws, 'op-cas-2', 'trucks', truckId, { name: 'forged' })),
        }),
        error => error.code === 'replica-head-generation-conflict',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const after = await head(pool, ws, 'trucks', truckId);
    assert.equal(Number(after.head_seq), Number(before.head_seq));
    assert.equal(Number((await pool.query(
      'SELECT revision FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [ws, truckId],
    )).rows[0].revision), Number(revision));
    assert.equal((await pool.query(
      'SELECT payload FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [ws, truckId],
    )).rows[0].payload.name, 'second');
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Verifier.
// ---------------------------------------------------------------------------
test('verifyReplicaHeads proves settled, pending and tombstone heads and reports a missing canonical row', { skip: !approved }, async () => {
  const pool = poolForTest();
  const ws = await newWorkspace(pool, 'verify');
  const truckId = 'truck_verify';
  const shiftId = 'shift_verify';
  const objectId = 'object_verify';
  try {
    await append(pool, ws, 0, [
      setOp(ws, 'op-obj-verify', 'objects', objectId, { name: 'Object' }),
      setOp(ws, 'op-truck-verify', 'trucks', truckId, { name: 'Truck' }),
      setOp(ws, 'op-status-verify', 'truckStatus', truckId, { shiftId, onLine: true }),
      deleteOp(ws, 'op-log-delete', 'logs', 'log_verify'),
    ]);
    const report = await verifyReplicaHeads(pool, ws);
    assert.equal(report.ok, true, JSON.stringify(report.violations));
    assert.equal(report.pending, 1);
    assert.equal(report.checked >= 4, true);

    await pool.query('DELETE FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [ws, truckId]);
    const broken = await verifyReplicaHeads(pool, ws);
    assert.equal(broken.ok, false);
    assert.ok(broken.violations.some(item => item.code === 'canonical-missing' && item.documentId === truckId));
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Real concurrency: the second writer observes the workspace lock.
// ---------------------------------------------------------------------------
test('concurrent append waits on the workspace lock and promotion happens exactly once', { skip: !approved }, async () => {
  const pool = poolForTest();
  const observer = poolForTest();
  const writer = new pg.Pool({ connectionString, max: 1, application_name: 'zz_concurrent_promote' });
  const ws = await newWorkspace(pool, 'concurrent');
  const shiftId = 'shift_concurrent';
  const truckId = 'truck_concurrent';
  const objectId = 'object_concurrent';
  const statusOp = setOp(ws, 'op-status-concurrent', 'truckStatus', truckId, { shiftId, onLine: true });
  try {
    await append(pool, ws, 0, [statusOp]);
    assert.equal(Number((await pending(pool, ws, 'truckStatus', truckId)).stream_seq), 1);

    const holder = await pool.connect();
    let blocked;
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", ['replica:' + ws + ':f2s']);
      await holder.query('SELECT f2s_seq FROM replica_cursor WHERE workspace_id=$1 FOR UPDATE', [ws]);
      const object = setOp(ws, 'op-obj-concurrent', 'objects', objectId, { name: 'Object' });
      const shift = setOp(ws, 'op-shift-concurrent', 'shift', shiftId, shiftData(shiftId, objectId));
      for (const [index, operation] of [object, shift].entries()) {
        const seq = index + 2;
        const normalized = normalizeReplicaOperation(operation);
        await holder.query(
          `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256,protocol_version,hash_version)
           VALUES($1,$2,'f2s',$3,$4,$5,$6,2,2)`,
          [ws, seq, operation.id, operation.kind, JSON.stringify(normalized.payload), normalized.hash],
        );
        await applyReplicaHeadTransition(holder, ws, operation, { seq, normalized, promote: false });
      }
      // The status is still pending: the holder deliberately skipped promotion.
      assert.equal((await pending(pool, ws, 'truckStatus', truckId)).stream_seq.toString(), '1');

      const truck = setOp(ws, 'op-truck-concurrent', 'trucks', truckId, { name: 'Truck' });
      const secondWriter = append(writer, ws, 3, [truck]);
      blocked = await waitForLockedBackend(observer, 'zz_concurrent_promote');
      assert.equal(blocked, true, 'the second append must be observed waiting on the workspace lock');

      await holder.query(
        'UPDATE replica_cursor SET f2s_seq=3,updated_at=now() WHERE workspace_id=$1', [ws],
      );
      await holder.query('COMMIT');
      const result = await secondWriter;
      assert.equal(result.applied, 1);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }

    assert.equal(await pending(pool, ws, 'truckStatus', truckId), undefined);
    const status = await statusRow(pool, ws, truckId);
    assert.equal(status.shift_id, shiftId);
    const heads = (await pool.query(
      'SELECT count(*)::int AS n FROM replica_document_heads WHERE workspace_id=$1 AND collection=$2 AND document_id=$3',
      [ws, 'truckStatus', truckId],
    )).rows[0].n;
    assert.equal(heads, 1, 'concurrent promotion leaves exactly one head');
  } finally {
    await writer.end();
    await observer.end();
    await pool.end();
  }
});

async function waitForLockedBackend(pool, applicationName) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = (await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name=$1 AND wait_event_type='Lock'`,
      [applicationName],
    )).rows[0];
    if (Number(row.n) > 0) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

// ---------------------------------------------------------------------------
// A fault at every transaction boundary rolls back stream, head, canonical,
// pending and cursor together.
// ---------------------------------------------------------------------------
test('a failure at each transaction boundary leaves no partial replica state', { skip: !approved }, async () => {
  const pool = poolForTest();
  let triggerCounter = 0;

  async function withFailingTrigger({ table, event, condition, work }) {
    const suffix = `${Date.now()}_${++triggerCounter}`;
    const trigger = `zz_fault_${suffix}`;
    const func = `zz_fault_fn_${suffix}`;
    await withAdminClient(async client => {
      await client.query(
        `CREATE FUNCTION public.${func}() RETURNS trigger LANGUAGE plpgsql AS $f$
         BEGIN
           ${condition ? `IF ${condition} THEN` : ''}
             RAISE EXCEPTION 'zz-injected-fault';
           ${condition ? 'END IF;' : ''}
           RETURN NEW;
         END $f$`,
      );
      await client.query(
        `CREATE TRIGGER ${trigger} BEFORE ${event} ON public.${table}
         FOR EACH ROW EXECUTE FUNCTION public.${func}()`,
      );
    });
    try {
      return await work();
    } finally {
      await withAdminClient(async client => {
        await client.query(`DROP TRIGGER IF EXISTS ${trigger} ON public.${table}`);
        await client.query(`DROP FUNCTION IF EXISTS public.${func}()`);
      });
    }
  }

  async function assertEmpty(ws, label) {
    assert.equal(await streamCount(pool, ws), 0, `${label}: stream must roll back`);
    assert.equal(await cursor(pool, ws), 0, `${label}: cursor must not advance`);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM replica_document_heads WHERE workspace_id=$1', [ws],
    )).rows[0].n, 0, `${label}: no head may survive`);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM replica_pending_documents WHERE workspace_id=$1', [ws],
    )).rows[0].n, 0, `${label}: no pending may survive`);
  }

  // 1. After the immutable stream insert, before the head is written.
  {
    const ws = await newWorkspace(pool, 'fault_stream');
    await withFailingTrigger({
      table: 'replica_document_heads', event: 'INSERT',
      work: async () => {
        await assert.rejects(
          () => append(pool, ws, 0, [setOp(ws, 'op-fault-1', 'trucks', 'truck_fault_1', { name: 'T' })]),
          /zz-injected-fault/,
        );
      },
    });
    await assertEmpty(ws, 'after stream insert');
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM line_trucks WHERE workspace_id=$1', [ws],
    )).rows[0].n, 0);
  }

  // 2. After the head advance, before the canonical row.
  {
    const ws = await newWorkspace(pool, 'fault_head');
    await withFailingTrigger({
      table: 'line_trucks', event: 'INSERT',
      work: async () => {
        await assert.rejects(
          () => append(pool, ws, 0, [setOp(ws, 'op-fault-2', 'trucks', 'truck_fault_2', { name: 'T' })]),
          /zz-injected-fault/,
        );
      },
    });
    await assertEmpty(ws, 'after head advance');
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM line_trucks WHERE workspace_id=$1', [ws],
    )).rows[0].n, 0);
  }

  // 3. After the pending head, before the pending row.
  {
    const ws = await newWorkspace(pool, 'fault_pending');
    await withFailingTrigger({
      table: 'replica_pending_documents', event: 'INSERT',
      work: async () => {
        await assert.rejects(
          () => append(pool, ws, 0, [
            setOp(ws, 'op-fault-3', 'truckStatus', 'truck_fault_3', { shiftId: 'shift_fault_3', onLine: true }),
          ]),
          /zz-injected-fault/,
        );
      },
    });
    await assertEmpty(ws, 'after pending head');
  }

  // 4. After the pending row, during promotion of that row.
  {
    const ws = await newWorkspace(pool, 'fault_promote');
    const shiftId = 'shift_fault_4';
    const truckId = 'truck_fault_4';
    const objectId = 'object_fault_4';
    await append(pool, ws, 0, [
      setOp(ws, 'op-obj-4', 'objects', objectId, { name: 'Object' }),
      setOp(ws, 'op-shift-4', 'shift', shiftId, shiftData(shiftId, objectId)),
      setOp(ws, 'op-status-4', 'truckStatus', truckId, { shiftId, onLine: true }),
    ]);
    assert.equal((await pending(pool, ws, 'truckStatus', truckId)).missing_truck, true);
    await withFailingTrigger({
      table: 'replica_document_heads', event: 'UPDATE',
      condition: "NEW.collection = 'truckStatus' AND NEW.canonical_present = true",
      work: async () => {
        await assert.rejects(
          () => append(pool, ws, 3, [setOp(ws, 'op-truck-4', 'trucks', truckId, { name: 'Truck' })]),
          /zz-injected-fault/,
        );
      },
    });
    assert.equal(await streamCount(pool, ws), 3, 'the failed truck batch must not add a stream row');
    assert.equal(await cursor(pool, ws), 3);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [ws, truckId],
    )).rows[0].n, 0);
    assert.equal((await pending(pool, ws, 'truckStatus', truckId)).stream_seq.toString(), '3');
    const statusHead = await head(pool, ws, 'truckStatus', truckId);
    assert.equal(statusHead.applied_seq, null);
    assert.equal(statusHead.canonical_present, false);
  }

  // 5. After every write, before the cursor: the whole batch is atomic.
  {
    const ws = await newWorkspace(pool, 'fault_cursor');
    await withFailingTrigger({
      table: 'replica_cursor', event: 'UPDATE',
      work: async () => {
        await assert.rejects(
          () => append(pool, ws, 0, [setOp(ws, 'op-fault-5', 'trucks', 'truck_fault_5', { name: 'T' })]),
          /zz-injected-fault/,
        );
      },
    });
    await assertEmpty(ws, 'before cursor');
  }
});

// ---------------------------------------------------------------------------
// Task 14 — objects/users tombstones and the collection-specific verifier.
//
// Design §4.10: `canonical_present=false` on a settled delete means "no live
// canonical projection", not "no physical row". objects keep a soft archive row
// and users keep a soft-disabled account row so provenance FKs stay valid; the
// verifier therefore dispatches by collection and never applies the forbidden
// generic rule "physical row exists iff canonical_present".
// ---------------------------------------------------------------------------
function shiftWithOpener(shiftId, objectId, openerUid) {
  return {
    ...shiftData(shiftId, objectId),
    startedByUid: openerUid,
    startedBy: openerUid,
  };
}

test('object and user tombstones keep collection provenance and a replay changes nothing', { skip: !approved }, async () => {
  const pool = poolForTest();
  const ws = await newWorkspace(pool, 'tombstone_provenance');
  const objectId = 'object_tombstone';
  const userUid = 'user_tombstone_replica';
  const objectSet = setOp(ws, 'op-obj-tomb-1', 'objects', objectId, { name: 'Object' });
  const userSet = setOp(ws, 'op-user-tomb-1', 'users', userUid, {
    email: 'tombstone@example.invalid', role: 'driver', status: 'active', nickname: 'Tombstone',
  });
  const objectDelete = deleteOp(ws, 'op-obj-tomb-2', 'objects', objectId);
  const userDelete = deleteOp(ws, 'op-user-tomb-2', 'users', userUid);
  try {
    await append(pool, ws, 0, [objectSet, userSet]);
    await append(pool, ws, 2, [objectDelete, userDelete]);

    const objectHead = await head(pool, ws, 'objects', objectId);
    const userHead = await head(pool, ws, 'users', userUid);
    assert.equal(objectHead.head_kind, 'doc.delete');
    assert.equal(objectHead.canonical_present, false);
    assert.equal(Number(objectHead.applied_seq), Number(objectHead.head_seq));
    assert.equal(userHead.head_kind, 'doc.delete');
    assert.equal(userHead.canonical_present, false);
    assert.equal(Number(userHead.applied_seq), Number(userHead.head_seq));

    const object = await objectRow(pool, ws, objectId);
    assert.ok(object, 'the object physical row survives as a soft tombstone');
    assert.equal(object.payload.deleted, true);
    assert.equal(Number(object.payload.deletedSeq), Number(objectHead.head_seq));
    assert.equal(object.payload.deletedSha256, await streamHash(pool, ws, objectHead.head_seq));
    assert.equal(Number(object.revision), 2, 'the tombstone archives one revision');

    const user = await userRow(pool, userUid);
    assert.ok(user, 'the app_users row survives so every uid FK stays valid');
    assert.equal(user.status, 'disabled');
    assert.equal(user.profile.deleted, true);
    assert.equal(Number(user.profile.deletedSeq), Number(userHead.head_seq));
    assert.equal(user.profile.deletedSha256, await streamHash(pool, ws, userHead.head_seq));
    assert.equal(user.email, 'tombstone@example.invalid', 'provenance keeps the account identity');
    assert.equal(Number(user.revision), 2);

    const report = await verifyReplicaHeads(pool, ws);
    assert.equal(report.ok, true, JSON.stringify(report.violations));
    assert.equal(report.policyVersion, 1);

    // Same delete batch resent: duplicate operation ids are an idempotent no-op,
    // so revision, tombstone payload and head timestamp stay byte-identical.
    const resend = await append(pool, ws, 2, [objectDelete, userDelete]);
    assert.equal(resend.applied, 0);
    assert.equal(Number((await objectRow(pool, ws, objectId)).revision), 2);
    assert.equal(Number((await userRow(pool, userUid)).revision), 2);
    assert.deepEqual((await objectRow(pool, ws, objectId)).payload, object.payload);
    assert.deepEqual((await userRow(pool, userUid)).profile, user.profile);
    assert.deepEqual((await head(pool, ws, 'objects', objectId)).updated_at, objectHead.updated_at);
    assert.deepEqual((await head(pool, ws, 'users', userUid)).updated_at, userHead.updated_at);

    // The equal-seq/equal-hash transition is a replay, not a second tombstone.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const replay = await applyReplicaHeadTransition(client, ws, objectDelete, {
        seq: Number(objectHead.head_seq),
        normalized: normalizeReplicaOperation(objectDelete),
      });
      assert.equal(replay.status, 'replay');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    assert.equal(Number((await objectRow(pool, ws, objectId)).revision), 2);
  } finally {
    await pool.end();
  }
});

test('a recreate and a newer delete create a new tombstone generation', { skip: !approved }, async () => {
  const pool = poolForTest();
  const ws = await newWorkspace(pool, 'tombstone_generations');
  const objectId = 'object_generation';
  const userUid = 'user_generation_replica';
  try {
    await append(pool, ws, 0, [
      setOp(ws, 'op-gen-obj-1', 'objects', objectId, { name: 'First' }),
      setOp(ws, 'op-gen-user-1', 'users', userUid, {
        email: 'generation@example.invalid', role: 'driver', status: 'active', nickname: 'Gen',
      }),
    ]);
    await append(pool, ws, 2, [
      deleteOp(ws, 'op-gen-obj-2', 'objects', objectId),
      deleteOp(ws, 'op-gen-user-2', 'users', userUid),
    ]);
    const firstObjectHead = await head(pool, ws, 'objects', objectId);
    const firstUserHead = await head(pool, ws, 'users', userUid);
    const firstObject = await objectRow(pool, ws, objectId);
    const firstUser = await userRow(pool, userUid);

    await append(pool, ws, 4, [
      setOp(ws, 'op-gen-obj-3', 'objects', objectId, { name: 'Second' }),
      setOp(ws, 'op-gen-user-3', 'users', userUid, {
        email: 'generation@example.invalid', role: 'foreman', status: 'active', nickname: 'Gen',
      }),
    ]);
    const liveObject = await objectRow(pool, ws, objectId);
    assert.notEqual(liveObject.payload.deleted, true, 'a recreate restores the live projection');
    assert.equal(liveObject.payload.name, 'Second');
    const liveUser = await userRow(pool, userUid);
    assert.equal(liveUser.status, 'active');
    assert.equal(liveUser.profile.deleted, undefined);
    assert.equal(liveUser.role, 'foreman');

    await append(pool, ws, 6, [
      deleteOp(ws, 'op-gen-obj-4', 'objects', objectId),
      deleteOp(ws, 'op-gen-user-4', 'users', userUid),
    ]);
    const objectHead = await head(pool, ws, 'objects', objectId);
    const userHead = await head(pool, ws, 'users', userUid);
    assert.ok(Number(objectHead.head_seq) > Number(firstObjectHead.head_seq));
    assert.ok(Number(userHead.head_seq) > Number(firstUserHead.head_seq));

    const object = await objectRow(pool, ws, objectId);
    assert.equal(Number(object.payload.deletedSeq), Number(objectHead.head_seq));
    assert.notEqual(Number(object.payload.deletedSeq), Number(firstObject.payload.deletedSeq));
    assert.equal(object.payload.deletedSha256, await streamHash(pool, ws, objectHead.head_seq));
    assert.ok(Number(object.revision) > Number(firstObject.revision));
    const user = await userRow(pool, userUid);
    assert.equal(Number(user.profile.deletedSeq), Number(userHead.head_seq));
    assert.notEqual(Number(user.profile.deletedSeq), Number(firstUser.profile.deletedSeq));
    assert.equal(user.profile.deletedSha256, await streamHash(pool, ws, userHead.head_seq));
    assert.equal(user.status, 'disabled');
    assert.ok(Number(user.revision) > Number(firstUser.revision));

    const report = await verifyReplicaHeads(pool, ws);
    assert.equal(report.ok, true, JSON.stringify(report.violations));
  } finally {
    await pool.end();
  }
});

test('deleting an object referenced by a shift fails parent-in-use and rolls back', { skip: !approved }, async () => {
  const pool = poolForTest();
  const ws = await newWorkspace(pool, 'object_in_use');
  const objectId = 'object_in_use';
  const shiftId = 'shift_in_use';
  try {
    await append(pool, ws, 0, [
      setOp(ws, 'op-inuse-obj-1', 'objects', objectId, { name: 'Object' }),
      setOp(ws, 'op-inuse-shift-1', 'shift', shiftId, shiftData(shiftId, objectId)),
    ]);
    const streamBefore = await streamCount(pool, ws);
    const cursorBefore = await cursor(pool, ws);

    await assert.rejects(
      () => append(pool, ws, 2, [deleteOp(ws, 'op-inuse-obj-2', 'objects', objectId)]),
      error => error.code === 'parent-in-use' && error.status === 409,
      'a referenced object must be refused with the stable parent-in-use code',
    );
    assert.equal(await streamCount(pool, ws), streamBefore, 'the refused batch leaves no stream row');
    assert.equal(await cursor(pool, ws), cursorBefore);
    const live = await objectRow(pool, ws, objectId);
    assert.notEqual(live.payload.deleted, true, 'the object stays live after the rollback');
    const objectHead = await head(pool, ws, 'objects', objectId);
    assert.equal(objectHead.head_kind, 'doc.set');
    assert.equal(Number(objectHead.head_seq), 1);
    assert.equal(await verifyReplicaHeads(pool, ws).then(report => report.ok), true);

    // Once the referencing shift is gone the soft tombstone is allowed.
    await append(pool, ws, 2, [deleteOp(ws, 'op-inuse-shift-2', 'shift', shiftId)]);
    await append(pool, ws, 3, [deleteOp(ws, 'op-inuse-obj-3', 'objects', objectId)]);
    const archived = await objectRow(pool, ws, objectId);
    assert.equal(archived.payload.deleted, true);
    assert.equal(Number((await head(pool, ws, 'objects', objectId)).head_seq), 4);
    assert.equal(await verifyReplicaHeads(pool, ws).then(report => report.ok), true);

    // A tombstoned object is not a canonical parent: a new shift cannot bind to it.
    await assert.rejects(
      () => append(pool, ws, 4, [
        setOp(ws, 'op-inuse-shift-3', 'shift', 'shift_after_tombstone', shiftData('shift_after_tombstone', objectId)),
      ]),
      error => error.code === 'replica-shift-object-missing',
      'a deleted object must not become a live shift parent',
    );
  } finally {
    await pool.end();
  }
});

test('a user tombstone soft-disables the account and a physical delete is refused by FK', { skip: !approved }, async () => {
  const pool = poolForTest();
  const ws = await newWorkspace(pool, 'user_soft_disable');
  const objectId = 'object_user_fk';
  const shiftId = 'shift_user_fk';
  const userUid = 'user_fk_replica';
  try {
    await append(pool, ws, 0, [
      setOp(ws, 'op-userfk-obj-1', 'objects', objectId, { name: 'Object' }),
      setOp(ws, 'op-userfk-user-1', 'users', userUid, {
        email: 'fk@example.invalid', role: 'foreman', status: 'active', nickname: 'FK',
      }),
      setOp(ws, 'op-userfk-shift-1', 'shift', shiftId, shiftWithOpener(shiftId, objectId, userUid)),
    ]);
    // The shift opener and a membership both reference the uid.
    await pool.query(
      'INSERT INTO shift_members(workspace_id,shift_id,uid,assigned_at,assigned_by_uid) VALUES($1,$2,$3,now(),$4)',
      [ws, shiftId, userUid, ids.adminUid],
    );
    const opener = (await pool.query(
      'SELECT opened_by_uid FROM shifts WHERE workspace_id=$1 AND shift_id=$2', [ws, shiftId],
    )).rows[0];
    assert.equal(opener.opened_by_uid, userUid);

    await append(pool, ws, 3, [deleteOp(ws, 'op-userfk-user-2', 'users', userUid)]);
    const user = await userRow(pool, userUid);
    assert.ok(user, 'the app_users row is never physically removed');
    assert.equal(user.status, 'disabled');
    assert.equal(user.profile.deleted, true);
    assert.equal(Number((await head(pool, ws, 'users', userUid)).head_seq), 4);

    // Every uid FK still resolves to the tombstoned row.
    const references = (await pool.query(
      `SELECT s.opened_by_uid, m.uid AS member_uid
         FROM shifts s JOIN shift_members m
           ON m.workspace_id=s.workspace_id AND m.shift_id=s.shift_id
        WHERE s.workspace_id=$1 AND s.shift_id=$2`,
      [ws, shiftId],
    )).rows[0];
    assert.equal(references.opened_by_uid, userUid);
    assert.equal(references.member_uid, userUid);

    // Online physical delete is refused by the declared FK closure.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        () => client.query('DELETE FROM app_users WHERE uid=$1', [userUid]),
        error => error.code === '23503',
        'physical user delete must violate a provenance FK',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    assert.ok(await userRow(pool, userUid), 'the rolled back delete leaves the account row');
    assert.equal(await verifyReplicaHeads(pool, ws).then(report => report.ok), true);
  } finally {
    await pool.end();
  }
});

test('stale parent or concurrent promotion cannot resurrect a deleted document', { skip: !approved }, async () => {
  const pool = poolForTest();
  const observer = poolForTest();
  const waiterPool = new pg.Pool({ connectionString, max: 1, application_name: 'zz_stale_promote' });
  const ws = await newWorkspace(pool, 'no_resurrect');
  const objectId = 'object_no_resurrect';
  const shiftId = 'shift_no_resurrect';
  const truckId = 'truck_no_resurrect';
  const statusId = 'status_no_resurrect';
  const oldStatus = setOp(ws, 'op-res-status-1', 'truckStatus', statusId, { shiftId, onLine: true });
  try {
    // A delete settles before any parent exists: a later parent cannot revive it.
    await append(pool, ws, 0, [oldStatus, deleteOp(ws, 'op-res-status-2', 'truckStatus', statusId)]);
    let statusHead = await head(pool, ws, 'truckStatus', statusId);
    assert.equal(statusHead.head_kind, 'doc.delete');
    assert.equal(Number(statusHead.head_seq), 2);
    assert.equal(await statusRow(pool, ws, statusId), undefined);

    await append(pool, ws, 2, [
      setOp(ws, 'op-res-obj-1', 'objects', objectId, { name: 'Object' }),
      setOp(ws, 'op-res-shift-1', 'shift', shiftId, shiftData(shiftId, objectId)),
      setOp(ws, 'op-res-truck-1', 'trucks', truckId, { name: 'Truck' }),
    ]);
    assert.equal(await statusRow(pool, ws, statusId), undefined, 'parent arrival must not resurrect');
    assert.equal(await pending(pool, ws, 'truckStatus', statusId), undefined);
    assert.equal(Number((await head(pool, ws, 'truckStatus', statusId)).head_seq), 2);
    assert.equal(await promoteReplicaPending(pool, ws, { truckId }), 0);

    // Replaying the old set is a no-op; a lower generation is stale.
    const replay = await append(pool, ws, 5, [oldStatus]);
    assert.equal(replay.applied, 0);
    const stale = await applyReplicaHeadTransition(pool, ws, oldStatus, {
      seq: 1,
      normalized: normalizeReplicaOperation(oldStatus),
    });
    assert.equal(stale.status, 'stale');
    assert.equal(await statusRow(pool, ws, statusId), undefined);
    assert.equal(Number((await head(pool, ws, 'truckStatus', statusId)).head_seq), 2);

    // Concurrent promotion: a second writer blocked on the head lock observes the
    // settled tombstone and cannot materialize the stale generation.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", ['replica:' + ws + ':f2s']);
      await holder.query('SELECT f2s_seq FROM replica_cursor WHERE workspace_id=$1 FOR UPDATE', [ws]);
      await holder.query(
        `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256,protocol_version,hash_version)
         VALUES($1,6,'f2s','op-res-status-3','doc.delete',$2,$3,2,2)`,
        [ws, JSON.stringify(normalizeReplicaOperation(deleteOp(ws, 'op-res-status-3', 'truckStatus', statusId)).payload),
          normalizeReplicaOperation(deleteOp(ws, 'op-res-status-3', 'truckStatus', statusId)).hash],
      );
      await applyReplicaHeadTransition(holder, ws, deleteOp(ws, 'op-res-status-3', 'truckStatus', statusId), {
        seq: 6,
        normalized: normalizeReplicaOperation(deleteOp(ws, 'op-res-status-3', 'truckStatus', statusId)),
      });
      const blocked = applyReplicaHeadTransition(waiterPool, ws, oldStatus, {
        seq: 1,
        normalized: normalizeReplicaOperation(oldStatus),
      });
      const waiting = await waitForLockedBackend(observer, 'zz_stale_promote');
      assert.equal(waiting, true, 'the stale writer must wait on the head row lock');
      await holder.query('UPDATE replica_cursor SET f2s_seq=6,updated_at=now() WHERE workspace_id=$1', [ws]);
      await holder.query('COMMIT');
      assert.equal((await blocked).status, 'stale');
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
    statusHead = await head(pool, ws, 'truckStatus', statusId);
    assert.equal(statusHead.head_kind, 'doc.delete');
    assert.equal(Number(statusHead.head_seq), 6);
    assert.equal(await statusRow(pool, ws, statusId), undefined);
    assert.equal(await pending(pool, ws, 'truckStatus', statusId), undefined);

    // The same CAS protects object/user tombstones from a stale recreate.
    const staleObjectId = 'object_stale_resurrect';
    await append(pool, ws, 6, [
      setOp(ws, 'op-res-obj-stale-1', 'objects', staleObjectId, { name: 'Stale' }),
      deleteOp(ws, 'op-res-obj-stale-2', 'objects', staleObjectId),
    ]);
    const staleObjectHead = await head(pool, ws, 'objects', staleObjectId);
    assert.equal(staleObjectHead.head_kind, 'doc.delete');
    assert.equal(Number(staleObjectHead.head_seq), 8);
    const staleObject = await applyReplicaHeadTransition(pool, ws,
      setOp(ws, 'op-res-obj-stale-1', 'objects', staleObjectId, { name: 'Stale' }),
      {
        seq: 7,
        normalized: normalizeReplicaOperation(setOp(ws, 'op-res-obj-stale-1', 'objects', staleObjectId, { name: 'Stale' })),
      });
    assert.equal(staleObject.status, 'stale');
    assert.equal((await objectRow(pool, ws, staleObjectId)).payload.deleted, true);
    assert.equal(Number((await head(pool, ws, 'objects', staleObjectId)).head_seq), 8);
    assert.equal(await verifyReplicaHeads(pool, ws).then(report => report.ok), true);
  } finally {
    await waiterPool.end();
    await observer.end();
    await pool.end();
  }
});

test('the verifier dispatches each collection declared set and delete policy', { skip: !approved }, async () => {
  const pool = poolForTest();
  const ws = await newWorkspace(pool, 'policy_dispatch');
  const objectLive = 'object_policy_live';
  const objectMissing = 'object_policy_missing';
  const objectFlag = 'object_policy_flag';
  const objectSha = 'object_policy_sha';
  const userLive = 'user_policy_live';
  const userTomb = 'user_policy_tomb';
  const shiftId = 'shift_policy';
  const truckId = 'truck_policy';
  const logId = 'log_policy';
  try {
    await append(pool, ws, 0, [
      setOp(ws, 'op-pol-obj-live', 'objects', objectLive, { name: 'Live' }),
      setOp(ws, 'op-pol-obj-miss', 'objects', objectMissing, { name: 'Missing' }),
      setOp(ws, 'op-pol-obj-flag', 'objects', objectFlag, { name: 'Flag' }),
      setOp(ws, 'op-pol-obj-sha', 'objects', objectSha, { name: 'Sha' }),
      setOp(ws, 'op-pol-user-live', 'users', userLive, {
        email: 'live@example.invalid', role: 'driver', status: 'active', nickname: 'Live',
      }),
      setOp(ws, 'op-pol-user-tomb', 'users', userTomb, {
        email: 'tomb@example.invalid', role: 'driver', status: 'active', nickname: 'Tomb',
      }),
      setOp(ws, 'op-pol-shift', 'shift', shiftId, shiftData(shiftId, objectLive)),
      setOp(ws, 'op-pol-truck', 'trucks', truckId, { name: 'Truck' }),
      setOp(ws, 'op-pol-status', 'truckStatus', truckId, { shiftId, onLine: true }),
      setOp(ws, 'op-pol-log', 'logs', logId, { shiftId, truckId, volume: 5 }),
    ]);
    // Physical deletes need children first: status/log, then truck/shift.
    await append(pool, ws, 10, [
      deleteOp(ws, 'op-pol-del-status', 'truckStatus', truckId),
      deleteOp(ws, 'op-pol-del-log', 'logs', logId),
    ]);
    await append(pool, ws, 12, [
      deleteOp(ws, 'op-pol-del-truck', 'trucks', truckId),
      deleteOp(ws, 'op-pol-del-shift', 'shift', shiftId),
    ]);
    await append(pool, ws, 14, [
      deleteOp(ws, 'op-pol-del-obj-miss', 'objects', objectMissing),
      deleteOp(ws, 'op-pol-del-obj-flag', 'objects', objectFlag),
      deleteOp(ws, 'op-pol-del-obj-sha', 'objects', objectSha),
      deleteOp(ws, 'op-pol-del-user-tomb', 'users', userTomb),
    ]);

    // The declared physical policies: those four collections leave no row, while
    // objects/users keep their documented tombstone row.
    assert.equal(await statusRow(pool, ws, truckId), undefined);
    assert.equal(await logRow(pool, ws, logId), undefined);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [ws, truckId],
    )).rows[0].n, 0);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM shifts WHERE workspace_id=$1 AND shift_id=$2', [ws, shiftId],
    )).rows[0].n, 0);
    assert.equal((await objectRow(pool, ws, objectMissing)).payload.deleted, true);
    assert.equal((await userRow(pool, userTomb)).status, 'disabled');
    assert.ok(await objectRow(pool, ws, objectLive), 'the untouched object stays live');

    let report = await verifyReplicaHeads(pool, ws);
    assert.equal(report.ok, true, JSON.stringify(report.violations));
    assert.equal(report.policyVersion, 1);

    // Each documented violation is reported by its collection-specific code.
    await pool.query('DELETE FROM workspace_objects WHERE workspace_id=$1 AND object_id=$2', [ws, objectMissing]);
    await pool.query(
      `UPDATE workspace_objects SET payload=jsonb_set(payload,'{deleted}','false'::jsonb)
        WHERE workspace_id=$1 AND object_id=$2`,
      [ws, objectFlag],
    );
    await pool.query(
      `UPDATE workspace_objects SET payload=jsonb_set(payload,'{deletedSha256}','"deadbeef"'::jsonb)
        WHERE workspace_id=$1 AND object_id=$2`,
      [ws, objectSha],
    );
    await pool.query("UPDATE app_users SET status='active' WHERE uid=$1", [userTomb]);
    await pool.query('DELETE FROM workspace_objects WHERE workspace_id=$1 AND object_id=$2', [ws, objectLive]);
    await pool.query(
      `INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,'{}'::jsonb)`,
      [ws, truckId],
    );

    report = await verifyReplicaHeads(pool, ws);
    assert.equal(report.ok, false);
    const codes = new Map(report.violations.map(item => [`${item.documentId}:${item.code}`, item]));
    assert.ok(codes.has(`${objectMissing}:object-tombstone-missing`), JSON.stringify(report.violations));
    assert.ok(codes.has(`${objectFlag}:object-tombstone-invalid`), JSON.stringify(report.violations));
    assert.ok(codes.has(`${objectSha}:tombstone-provenance-mismatch`), JSON.stringify(report.violations));
    assert.ok(codes.has(`${userTomb}:user-tombstone-invalid`), JSON.stringify(report.violations));
    assert.ok(codes.has(`${objectLive}:canonical-missing`), JSON.stringify(report.violations));
    assert.ok(codes.has(`${truckId}:canonical-present-after-delete`), JSON.stringify(report.violations));
  } finally {
    await pool.end();
  }
});
