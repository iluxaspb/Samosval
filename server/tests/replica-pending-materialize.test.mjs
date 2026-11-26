import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { appendReplicaBatch } from '../src/replica-store.mjs';
import { normalizeReplicaOperation } from '../src/replica-materialize.mjs';
import { applyReplicaHeadTransition, verifyReplicaHeads } from '../src/replica-heads.mjs';
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
    `SELECT head_seq,head_kind,canonical_present,applied_seq,shift_id,truck_id,object_id,user_uid
       FROM replica_document_heads
      WHERE workspace_id=$1 AND collection=$2 AND document_id=$3`,
    [ws, collection, documentId],
  )).rows[0];
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
