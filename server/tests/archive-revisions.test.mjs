// Task 9 (P9): finalize открытого restored-контекста в неизменяемую следующую
// ревизию архива (design §4.6 строка 243/255). Проверяется контракт целиком:
// hash-linked immutable revision, канонические байты, publication/receipt/audit,
// CAS latest-указателя, one-winner при конкурентности, replay/idempotency,
// отсутствие любых побочных эффектов и ACL только из session.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import pg from 'pg';

import {
  applyMigrationsThrough,
  requireIsolatedDatabase,
  resetIsolatedDatabase,
} from './helpers/isolated-db.mjs';
import {finalizeRestoredContext} from '../src/archive-revisions.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
let approved = false;
if (connectionString && process.env.SAMOSVAL_ISOLATED_TEST === '1') {
  try { requireIsolatedDatabase(connectionString); approved = true; } catch {}
}

const sha = value => createHash('sha256').update(value).digest('hex');
const bytesOf = value => Buffer.from(JSON.stringify(value), 'utf8');

// Независимая реализация JCS-подмножества (RFC 8785): сортировка ключей, без
// пробелов, ECMAScript-сериализация. Тест НЕ использует production-функцию, иначе
// побайтовая сверка байтов была бы проверкой функции самой себя.
function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

const WS = 'workspace_archive_revisions';
const FOREIGN_WS = 'workspace_archive_revisions_foreign';
const ADMIN = 'admin_rev';
const ARCHIVIST = 'archivist_rev';
const DISABLED = 'disabled_rev';
const VIEWER = 'viewer_rev';
const OLD_AUTHOR = 'old_author_rev';
const TRUCK1 = 'truck_rev1';
const TRUCK2 = 'truck_rev2';
const LIVE_SHIFT = 'live_shift_rev';

const ARC_MAIN = 'arc_main';
const ARC_CAS = 'arc_cas';
const ARC_STALE = 'arc_stale';
const ARC_RACE = 'arc_race';
const ARC_RACE_IDENT = 'arc_race_ident';
const ARC_REPLAY = 'arc_replay';
const ARC_REUSE = 'arc_reuse';
const ARC_ACL = 'arc_acl';
const ARC_NORECEIPT = 'arc_noreceipt';

const ctxOf = archiveId => `ctx_${archiveId}`;
const restoreOpOf = archiveId => `op_restore_${archiveId}`;

// Всё, что лежит ВНЕ archive chain/restored children: finalize обязан не менять
// здесь ни одной строки (никакой synthetic смены, статуса, material/tabel/reward).
const OUTSIDE_TABLES = [
  'shifts', 'line_logs', 'line_truck_statuses', 'tabel_records', 'game_records',
  'shift_material_markers', 'line_history', 'history_audit', 'history_receipts',
  'shift_operation_receipts', 'workspace_service_audit', 'workspace_service_receipts',
];

function archivePayload(archiveId) {
  return {
    sourceShiftId: `shift_${archiveId}`,
    objectId: 'site',
    objectName: 'Объект',
    date: '23.11.2026',
    closedAt: 1795453200000,
    closedBy: 'Старый Автор',
    logs: [
      {id: 'src_a', truckId: TRUCK1, truckName: 'Самосвал 1', volume: 24, timeStr: '10:00', timestamp: 20,
        arrivalTimestamp: null, returnedAt: null, createdBy: 'Старый Автор', createdByEmail: '', isGAI: false, comment: 'первый'},
      {id: 'src_b', truckId: TRUCK1, truckName: 'Самосвал 1', volume: 12, timeStr: '11:00', timestamp: 30,
        arrivalTimestamp: null, returnedAt: null, createdBy: 'Старый Автор', createdByEmail: '', isGAI: false, comment: 'второй'},
      {id: 'src_g', truckId: TRUCK2, truckName: 'Самосвал 2', volume: 5, timeStr: '12:00', timestamp: 40,
        arrivalTimestamp: null, returnedAt: null, createdBy: 'Старый Автор', createdByEmail: '', isGAI: true, comment: 'гаи'},
    ],
    activeLineIds: [TRUCK1, TRUCK2],
    ttnStatus: {[TRUCK1]: 'pending', [TRUCK2]: 'pending'},
    totalVolume: 36,
    totalTrips: 2,
  };
}

// Последнее редактируемое состояние рейсов контекста. `log_a` уже содержит
// результат trip.update (volume 20, время 09:30) — finalize публикует именно его.
const CONTEXT_LOGS = [
  ['log_a', TRUCK1, {id: 'log_a', truckId: TRUCK1, timestamp: 20, volume: 20, timeStr: '09:30', comment: 'исправлен'}, 'src_a'],
  ['log_b', TRUCK1, {id: 'log_b', truckId: TRUCK1, timestamp: 30, volume: 12, timeStr: '11:00', comment: 'второй'}, 'src_b'],
  ['log_g', TRUCK2, {id: 'log_g', truckId: TRUCK2, timestamp: 40, volume: 5, timeStr: '12:00', comment: 'гаи', isGAI: true}, 'src_g'],
];

// Полная упорядоченная история коррекций открытого контекста (revision 2..4).
const HISTORY = [
  {actionId: 'act_2', uid: ARCHIVIST, type: 'ttn.update', revision: 2, undone: false,
    beforeLog: null, afterLog: null,
    beforeStatusSnapshot: {truckId: TRUCK2, ttnStatus: 'pending'},
    afterStatusSnapshot: {truckId: TRUCK2, ttnStatus: true},
    createdAt: '2026-11-26T05:00:00.123456Z'},
  {actionId: 'act_3', uid: ARCHIVIST, type: 'trip.update', revision: 3, undone: false,
    beforeLog: {id: 'log_a', truckId: TRUCK1, timestamp: 20, volume: 24, timeStr: '10:00', comment: 'первый'},
    afterLog: {id: 'log_a', truckId: TRUCK1, timestamp: 20, volume: 20, timeStr: '09:30', comment: 'исправлен'},
    beforeStatusSnapshot: null, afterStatusSnapshot: null,
    createdAt: '2026-11-26T05:01:00.654321Z'},
  {actionId: 'act_4', uid: ARCHIVIST, type: 'ttn.delete', revision: 4, undone: false,
    beforeLog: null, afterLog: null,
    beforeStatusSnapshot: {truckId: TRUCK1, ttnStatus: 'pending'},
    afterStatusSnapshot: {truckId: TRUCK1, ttnStatus: null},
    createdAt: '2026-11-26T05:02:00.000001Z'},
];

// Точная ожидаемая формула байтов ревизии 2 для ARC_MAIN, собранная вручную:
// base payload + эффективные рейсы/TTN + конверт finalize + полная история.
function expectedMainPayload(baseSha) {
  const base = archivePayload(ARC_MAIN);
  return {
    ...base,
    logs: CONTEXT_LOGS.map(([, , payload]) => payload),
    // Снимок: TRUCK1/TRUCK2 pending. Журнал: TRUCK2 → true, TRUCK1 → null (удалён).
    ttnStatus: {[TRUCK2]: true},
    totalTrips: 2,
    totalVolume: 32,
    archiveRevision: 2,
    previousRevision: 1,
    previousSha256: baseSha,
    restoredContext: {
      restoredContextId: ctxOf(ARC_MAIN),
      restoreOperationId: restoreOpOf(ARC_MAIN),
      finalizeOperationId: 'fin_main',
      baseRevision: 1,
      baseSha256: baseSha,
      contextRevision: 5,
      history: HISTORY,
    },
  };
}

const seededSha = new Map();

async function seedArchive(client, {archiveId, state = 'open', contextRevision = 1, withReceipt = true, withHistory = false}) {
  const contextId = ctxOf(archiveId);
  const payload = archivePayload(archiveId);
  const bytes = bytesOf(payload);
  const digest = sha(bytes);
  seededSha.set(archiveId, digest);
  await client.query(
    'INSERT INTO shift_archive_series(workspace_id,archive_id,source_shift_id) VALUES($1,$2,$3)',
    [WS, archiveId, `shift_${archiveId}`],
  );
  await client.query(
    `INSERT INTO shift_archive_revisions(
       workspace_id,archive_id,archive_revision,payload_bytes,payload_sha256,
       payload_schema_version,source_kind,source_locator,created_by_uid)
     VALUES($1,$2,1,$3,$4,2,'legacy-import',$5,$6)`,
    [WS, archiveId, bytes, digest, `legacy:${archiveId}:1`, ADMIN],
  );
  await client.query(
    'UPDATE shift_archive_series SET latest_finalized_revision=1,latest_finalized_sha256=$3 WHERE workspace_id=$1 AND archive_id=$2',
    [WS, archiveId, digest],
  );
  await client.query(
    `INSERT INTO restored_shift_contexts(
       workspace_id,restored_context_id,archive_id,source_shift_id,mode,context_state,
       original_opened_by_uid,original_opened_by_name_snapshot,original_identity_resolution,
       original_shift_type,original_shift_type_resolution,
       restored_by_uid,restored_by_name_snapshot,restored_at,
       archive_revision,context_revision,restore_operation_id,
       source_state_snapshot,source_shift_revision,opened_at_snapshot,
       object_id,object_name,work_date)
     VALUES($1,$2,$3,$4,'standalone',$5,$6,'Старый Автор','source','day','source',$7,'Восстановивший',now(),
            1,$8,$9,'{"source":"archive"}'::jsonb,7,now(),'site','Объект',DATE '2026-11-23')`,
    [WS, contextId, archiveId, `shift_${archiveId}`, state, OLD_AUTHOR, ADMIN, contextRevision, restoreOpOf(archiveId)],
  );
  for (const [logId, truckId, logPayload, sourceLogId] of CONTEXT_LOGS) {
    await client.query(
      `INSERT INTO restored_context_logs(workspace_id,restored_context_id,log_id,truck_id,payload,log_revision,source_log_id,created_from_archive_revision)
       VALUES($1,$2,$3,$4,$5,1,$6,1)`,
      [WS, contextId, logId, truckId, logPayload, sourceLogId],
    );
  }
  await client.query(
    `INSERT INTO restored_context_status_snapshots(workspace_id,restored_context_id,truck_id,payload,status_revision,cycle_revision,ttn_revision)
     VALUES($1,$2,$3,$4,3,2,4),($1,$2,$5,$6,3,2,4)`,
    [WS, contextId, TRUCK1, {truckId: TRUCK1, ttnStatus: 'pending', lastLoadTimestamp: 30},
      TRUCK2, {truckId: TRUCK2, ttnStatus: 'pending'}],
  );
  if (withHistory) {
    for (const entry of HISTORY) {
      await client.query(
        `INSERT INTO restored_context_history(
           workspace_id,action_id,restored_context_id,uid,type,before_log,after_log,
           before_status_snapshot,after_status_snapshot,revision,undone,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11::timestamptz)`,
        [WS, entry.actionId, contextId, entry.uid, entry.type,
          entry.beforeLog === null ? null : JSON.stringify(entry.beforeLog),
          entry.afterLog === null ? null : JSON.stringify(entry.afterLog),
          entry.beforeStatusSnapshot === null ? null : JSON.stringify(entry.beforeStatusSnapshot),
          entry.afterStatusSnapshot === null ? null : JSON.stringify(entry.afterStatusSnapshot),
          entry.revision,
          entry.createdAt.replace('Z', '+00')],
      );
    }
  }
  if (withReceipt) {
    // Receipt операции restore — входной precondition публикации: publication
    // ссылается на него через DEFERRABLE FK, и без него finalize не коммитится.
    await client.query(
      `INSERT INTO archive_operation_receipts(workspace_id,operation_id,archive_id,uid,command_hash,result)
       VALUES($1,$2,$3,$4,$5,'{"outcome":"confirmed"}')`,
      [WS, restoreOpOf(archiveId), archiveId, ADMIN, 'a'.repeat(64)],
    );
  }
  return {contextId, digest};
}

// Дополнительный open-контекст той же серии, восстановленный из уже
// опубликованной базы: нужен, чтобы доказать отказ при сдвинутом latest.
async function seedExtraContext(client, {archiveId, contextId, baseRevision}) {
  await client.query(
    `INSERT INTO restored_shift_contexts(
       workspace_id,restored_context_id,archive_id,source_shift_id,mode,context_state,
       original_opened_by_uid,original_opened_by_name_snapshot,original_identity_resolution,
       original_shift_type,original_shift_type_resolution,
       restored_by_uid,restored_by_name_snapshot,restored_at,
       archive_revision,context_revision,restore_operation_id,
       source_state_snapshot,source_shift_revision,opened_at_snapshot,
       object_id,object_name,work_date)
     VALUES($1,$2,$3,$4,'standalone','open',$5,'Старый Автор','source','day','source',$6,'Восстановивший',now(),
            $7,1,$8,'{"source":"archive"}'::jsonb,7,now(),'site','Объект',DATE '2026-11-23')`,
    [WS, contextId, archiveId, `shift_${archiveId}`, OLD_AUTHOR, ADMIN, baseRevision, `op_restore_${contextId}`],
  );
  await client.query(
    `INSERT INTO archive_operation_receipts(workspace_id,operation_id,archive_id,uid,command_hash,result)
     VALUES($1,$2,$3,$4,$5,'{"outcome":"confirmed"}')`,
    [WS, `op_restore_${contextId}`, archiveId, ADMIN, 'a'.repeat(64)],
  );
}

async function outsideDigest(client) {
  const parts = [];
  for (const table of OUTSIDE_TABLES) {
    const exists = (await client.query('SELECT to_regclass($1) AS oid', [`public.${table}`])).rows[0].oid;
    if (!exists) continue;
    const rows = (await client.query(
      `SELECT row_to_json(t)::text AS row FROM (SELECT * FROM ${table} WHERE workspace_id=$1) t ORDER BY 1`,
      [WS],
    )).rows;
    parts.push([table, rows.map(row => row.row)]);
  }
  return sha(JSON.stringify(parts));
}

async function contextRow(client, archiveId) {
  return (await client.query(
    `SELECT context_state,context_revision::text AS context_revision,archive_revision::text AS archive_revision,
            restore_operation_id
       FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2`,
    [WS, ctxOf(archiveId)],
  )).rows[0];
}

async function seriesRow(client, archiveId) {
  return (await client.query(
    `SELECT latest_finalized_revision::text AS latest_finalized_revision,latest_finalized_sha256,
            series_revision::text AS series_revision
       FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2`,
    [WS, archiveId],
  )).rows[0];
}

async function archiveCounts(client, archiveId) {
  return (await client.query(
    `SELECT (SELECT count(*)::int FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2) revisions,
            (SELECT count(*)::int FROM archive_revision_publications WHERE workspace_id=$1 AND archive_id=$2) publications,
            (SELECT count(*)::int FROM archive_operation_receipts WHERE workspace_id=$1 AND archive_id=$2) receipts,
            (SELECT count(*)::int FROM archive_audit WHERE workspace_id=$1 AND archive_id=$2) audits`,
    [WS, archiveId],
  )).rows[0];
}

// Нормализованная команда — ровно то, что уходит в command_hash (порядок полей
// тот же, что в normalizeFinalize: id,type,expectedContextRevision,expectedBase*).
function finalizeCommand(operationId, expectedContextRevision, baseRevision, baseSha) {
  return {
    operationId, protocolVersion: 2, expectedContextRevision,
    expectedBaseArchiveRevision: baseRevision, expectedBaseSha256: baseSha,
  };
}

function commandHashOf(command) {
  return sha(JSON.stringify({
    id: command.operationId,
    type: 'restored.finalize',
    expectedContextRevision: command.expectedContextRevision,
    expectedBaseArchiveRevision: command.expectedBaseArchiveRevision,
    expectedBaseSha256: command.expectedBaseSha256,
  }));
}

const rejected = (promise, code, status) => assert.rejects(promise, error => {
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
});

let pool;
let outsideBefore = '';
let mainResult;

test.before(async () => {
  if (!approved) return;
  await resetIsolatedDatabase();
  await applyMigrationsThrough(25);
  pool = new pg.Pool({connectionString, max: 8});
  const client = await pool.connect();
  try {
    await client.query('INSERT INTO workspaces(id) VALUES($1),($2)', [WS, FOREIGN_WS]);
    for (const [uid, role, status] of [
      [ADMIN, 'admin', 'active'],
      [ARCHIVIST, 'archivist', 'active'],
      [DISABLED, 'archivist', 'disabled'],
      [VIEWER, 'viewer', 'active'],
      // Автор исходной архивной смены: FK restored_shift_contexts требует живого uid.
      [OLD_AUTHOR, 'foreman', 'disabled'],
    ]) {
      await client.query(
        'INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$1,$3,$4)',
        [uid, `${uid}@example.test`, role, status],
      );
    }
    await client.query("INSERT INTO role_permissions(role,action,allowed) VALUES('archivist','archive_edit',true)");
    for (const truck of [TRUCK1, TRUCK2]) {
      await client.query('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)',
        [WS, truck, {id: truck, brand: 'Fixture', number: truck}]);
    }
    await client.query('INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',
      [WS, 'site', {id: 'site', name: 'Объект'}]);

    await seedArchive(client, {archiveId: ARC_MAIN, withHistory: true, contextRevision: 4});
    await seedArchive(client, {archiveId: ARC_CAS});
    await seedArchive(client, {archiveId: ARC_STALE});
    await seedArchive(client, {archiveId: ARC_RACE});
    await seedArchive(client, {archiveId: ARC_RACE_IDENT});
    await seedArchive(client, {archiveId: ARC_REPLAY});
    await seedArchive(client, {archiveId: ARC_REUSE});
    await seedArchive(client, {archiveId: ARC_ACL});
    await seedArchive(client, {archiveId: ARC_NORECEIPT, withReceipt: false});

    // Живая линия живёт параллельно: её данные не должны измениться ни на байт.
    // Пишется полный v2 payload: 025 запрещает новые legacy-v1 строки.
    await client.query('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)',
      [WS, LIVE_SHIFT, {
        payloadSchemaVersion: 2, id: LIVE_SHIFT, shiftId: LIVE_SHIFT,
        objectId: 'site', objectName: 'Объект',
        startDate: '26.11.2026', date: '2026-11-26',
        workShift: 'day', type: 'day', state: 'active', isActive: true,
        startedAt: Date.UTC(2026, 10, 26, 5, 0, 0), startedBy: 'Живой прораб', startedByUid: ADMIN,
      }]);
    await client.query('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)',
      [WS, 'log_live_a', LIVE_SHIFT, TRUCK1, {id: 'log_live_a', shiftId: LIVE_SHIFT, truckId: TRUCK1, timestamp: 99, volume: 7}]);
    await client.query('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)',
      [WS, 'log_live_b', LIVE_SHIFT, TRUCK2, {id: 'log_live_b', shiftId: LIVE_SHIFT, truckId: TRUCK2, timestamp: 98, volume: 5}]);
    await client.query('INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES($1,$2,$3,$4)',
      [WS, TRUCK1, LIVE_SHIFT, {id: TRUCK1, shiftId: LIVE_SHIFT, onLine: true, ttnStatus: 'pending'}]);
    await client.query(
      "INSERT INTO tabel_records(workspace_id,record_id,object_id,record_key,payload) VALUES($1,'tabel_r','site','site/day:2026-11-26:day','{}'::jsonb)",
      [WS],
    );
    await client.query(
      "INSERT INTO game_records(workspace_id,record_id,collection,payload) VALUES($1,'game_r','audit','{}'::jsonb)",
      [WS],
    );
    outsideBefore = await outsideDigest(client);
  } finally {
    client.release();
  }
});

test.after(async () => { if (pool) await pool.end(); });

test('restored context finalize publishes one immutable archive revision', {skip: !approved}, async t => {
  const withClient = async fn => {
    const client = await pool.connect();
    try { return await fn(client); } finally { client.release(); }
  };

  await t.test('ACL comes from the session only: viewer/disabled/unknown/foreign workspace are refused without a row', async () => {
    const command = finalizeCommand('fin_acl', 1, 1, seededSha.get(ARC_ACL));
    await rejected(finalizeRestoredContext(pool, {uid: VIEWER, workspaceId: WS}, ctxOf(ARC_ACL), command), 'forbidden', 403);
    await rejected(finalizeRestoredContext(pool, {uid: DISABLED, workspaceId: WS}, ctxOf(ARC_ACL), command), 'forbidden', 403);
    await rejected(finalizeRestoredContext(pool, {uid: 'nobody_at_all', workspaceId: WS}, ctxOf(ARC_ACL), command), 'forbidden', 403);
    await rejected(finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: FOREIGN_WS}, ctxOf(ARC_ACL), command), 'archive-context-not-found', 404);
    await withClient(async client => {
      const counts = await archiveCounts(client, ARC_ACL);
      assert.deepEqual(counts, {revisions: 1, publications: 0, receipts: 1, audits: 0});
      assert.equal((await contextRow(client, ARC_ACL)).context_state, 'open');
      assert.equal((await seriesRow(client, ARC_ACL)).latest_finalized_revision, '1');
    });
  });

  await t.test('finalize writes exactly one revision, publication, receipt and audit and moves the latest pointer', async () => {
    const baseSha = seededSha.get(ARC_MAIN);
    const command = {...finalizeCommand('fin_main', 4, 1, baseSha), uid: 'forged_admin'};
    mainResult = await finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS}, ctxOf(ARC_MAIN), command);
    assert.equal(mainResult.archiveId, ARC_MAIN);
    assert.equal(mainResult.revision, 2);
    assert.equal(mainResult.contextId, ctxOf(ARC_MAIN));
    assert.equal(mainResult.contextRevision, 5);
    assert.match(mainResult.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    await withClient(async client => {
      const revision = (await client.query(
        `SELECT archive_revision::text AS archive_revision,previous_revision::text AS previous_revision,previous_sha256,
                payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_by_uid
           FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=2`,
        [WS, ARC_MAIN],
      )).rows[0];
      assert.equal(revision.previous_revision, '1');
      assert.equal(revision.previous_sha256, baseSha);
      assert.equal(revision.payload_sha256, sha(revision.payload_bytes));
      assert.equal(mainResult.sha256, revision.payload_sha256);
      assert.equal(revision.payload_schema_version, 2);
      assert.equal(revision.source_kind, 'restored-context-finalize');
      // Actor — только из session: тело с `uid: forged_admin` проигнорировано.
      assert.equal(revision.created_by_uid, ARCHIVIST);
      assert.equal(revision.source_locator, `finalize:${ARC_MAIN}:${ctxOf(ARC_MAIN)}:2`);

      const publication = (await client.query(
        `SELECT archive_revision::text AS archive_revision,restored_context_id,restore_operation_id,
                finalize_operation_id,base_revision::text AS base_revision,base_sha256,command_hash,
                published_by_uid,published_at
           FROM archive_revision_publications WHERE workspace_id=$1 AND restored_context_id=$2`,
        [WS, ctxOf(ARC_MAIN)],
      )).rows[0];
      assert.equal(publication.archive_revision, '2');
      assert.equal(publication.restore_operation_id, restoreOpOf(ARC_MAIN));
      assert.equal(publication.finalize_operation_id, 'fin_main');
      assert.equal(publication.base_revision, '1');
      assert.equal(publication.base_sha256, baseSha);
      assert.equal(publication.command_hash, commandHashOf(command));
      assert.equal(publication.published_by_uid, ARCHIVIST);
      assert.equal(publication.published_at.toISOString(), mainResult.publishedAt);

      const receipt = (await client.query(
        'SELECT uid,archive_id,command_hash,result FROM archive_operation_receipts WHERE workspace_id=$1 AND operation_id=$2',
        [WS, 'fin_main'],
      )).rows[0];
      assert.equal(receipt.uid, ARCHIVIST);
      assert.equal(receipt.archive_id, ARC_MAIN);
      assert.equal(receipt.command_hash, commandHashOf(command));
      assert.deepEqual(receipt.result, {
        archiveId: ARC_MAIN, revision: 2, sha256: mainResult.sha256,
        contextId: ctxOf(ARC_MAIN), contextRevision: 5, publishedAt: mainResult.publishedAt,
      });

      const audit = (await client.query(
        'SELECT source_shift_id,before_state,after_state,actor_uid FROM archive_audit WHERE workspace_id=$1 AND archive_id=$2',
        [WS, ARC_MAIN],
      )).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].source_shift_id, `shift_${ARC_MAIN}`);
      assert.equal(audit[0].actor_uid, ARCHIVIST);
      assert.equal(audit[0].before_state.contextState, 'open');
      assert.equal(audit[0].before_state.contextRevision, 4);
      assert.equal(audit[0].after_state.contextState, 'finalized');
      assert.equal(audit[0].after_state.archiveRevision, 2);

      assert.deepEqual(await archiveCounts(client, ARC_MAIN), {revisions: 2, publications: 1, receipts: 2, audits: 1});
      const context = await contextRow(client, ARC_MAIN);
      assert.equal(context.context_state, 'finalized');
      assert.equal(context.context_revision, '5');
      const series = await seriesRow(client, ARC_MAIN);
      assert.equal(series.latest_finalized_revision, '2');
      assert.equal(series.latest_finalized_sha256, mainResult.sha256);
      assert.equal(series.series_revision, '2');
      // Оригинал не переписан.
      const base = (await client.query(
        'SELECT payload_bytes,payload_sha256 FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=1',
        [WS, ARC_MAIN],
      )).rows[0];
      assert.equal(base.payload_sha256, baseSha);
      assert.ok(base.payload_bytes.equals(bytesOf(archivePayload(ARC_MAIN))));
    });
  });

  await t.test('published bytes are exactly the canonical base revision plus the ordered context history', async () => {
    const expected = Buffer.from(canonical(expectedMainPayload(seededSha.get(ARC_MAIN))), 'utf8');
    await withClient(async client => {
      const row = (await client.query(
        'SELECT payload_bytes,payload_sha256 FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=2',
        [WS, ARC_MAIN],
      )).rows[0];
      // Побайтовая сверка, не только hash.
      assert.ok(row.payload_bytes.equals(expected), 'published bytes differ from the independently built canonical string');
      assert.equal(row.payload_sha256, sha(expected));
      const parsed = JSON.parse(row.payload_bytes.toString('utf8'));
      assert.deepEqual(parsed, expectedMainPayload(seededSha.get(ARC_MAIN)));
      assert.deepEqual(parsed.restoredContext.history.map(entry => entry.actionId), ['act_2', 'act_3', 'act_4']);
      assert.deepEqual(parsed.ttnStatus, {[TRUCK2]: true});
      assert.deepEqual(parsed.logs.map(log => log.id), ['log_a', 'log_b', 'log_g']);
      assert.equal(parsed.previousSha256, seededSha.get(ARC_MAIN));
    });
  });

  await t.test('the base and the published revision are immutable', async () => {
    for (const revision of [1, 2]) {
      await rejected(withClient(client => client.query(
        "UPDATE shift_archive_revisions SET payload_bytes='tampered' WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=$3",
        [WS, ARC_MAIN, revision],
      )), '23514');
      await rejected(withClient(client => client.query(
        'DELETE FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=$3',
        [WS, ARC_MAIN, revision],
      )), '23514');
    }
    await withClient(async client => {
      const base = (await client.query(
        'SELECT payload_sha256 FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=1',
        [WS, ARC_MAIN],
      )).rows[0];
      assert.equal(base.payload_sha256, seededSha.get(ARC_MAIN));
      assert.deepEqual(await archiveCounts(client, ARC_MAIN), {revisions: 2, publications: 1, receipts: 2, audits: 1});
    });
  });

  await t.test('stale expectations give archive-changed and leave no partial row', async () => {
    const baseSha = seededSha.get(ARC_CAS);
    const cases = [
      ['fin_cas_ctx', {...finalizeCommand('fin_cas_ctx', 2, 1, baseSha)}],
      ['fin_cas_base', {...finalizeCommand('fin_cas_base', 1, 2, baseSha)}],
      ['fin_cas_sha', {...finalizeCommand('fin_cas_sha', 1, 1, 'b'.repeat(64))}],
    ];
    for (const [, command] of cases) {
      await rejected(finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS}, ctxOf(ARC_CAS), command), 'archive-changed', 409);
      await withClient(async client => {
        assert.deepEqual(await archiveCounts(client, ARC_CAS), {revisions: 1, publications: 0, receipts: 1, audits: 0});
        const context = await contextRow(client, ARC_CAS);
        assert.equal(context.context_state, 'open');
        assert.equal(context.context_revision, '1');
        const series = await seriesRow(client, ARC_CAS);
        assert.equal(series.latest_finalized_revision, '1');
        assert.equal(series.latest_finalized_sha256, baseSha);
      });
    }
  });

  await t.test('a moved latest pointer refuses the older base', async () => {
    const baseSha = seededSha.get(ARC_STALE);
    const first = await finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS},
      ctxOf(ARC_STALE), finalizeCommand('fin_stale_1', 1, 1, baseSha));
    assert.equal(first.revision, 2);
    // Второй контекст той же серии восстановлен из уже опубликованной базы 1:
    // latest уже 2, поэтому публикация обязана отказать и не оставить ни строки.
    await withClient(client => seedExtraContext(client, {archiveId: ARC_STALE, contextId: 'ctx_arc_stale_old', baseRevision: 1}));
    await rejected(finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS},
      'ctx_arc_stale_old', finalizeCommand('fin_stale_old', 1, 1, baseSha)), 'archive-changed', 409);
    await withClient(async client => {
      const series = await seriesRow(client, ARC_STALE);
      assert.equal(series.latest_finalized_revision, '2');
      assert.equal(series.latest_finalized_sha256, first.sha256);
      const context = (await client.query(
        `SELECT context_state,context_revision::text AS context_revision FROM restored_shift_contexts
          WHERE workspace_id=$1 AND restored_context_id='ctx_arc_stale_old'`, [WS],
      )).rows[0];
      assert.equal(context.context_state, 'open');
      assert.equal(context.context_revision, '1');
      assert.deepEqual(await archiveCounts(client, ARC_STALE), {revisions: 2, publications: 1, receipts: 3, audits: 1});
    });
  });

  await t.test('concurrent finalize has one latest winner', async () => {
    const baseSha = seededSha.get(ARC_RACE);
    const results = await Promise.allSettled([
      finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS}, ctxOf(ARC_RACE), finalizeCommand('fin_race_a', 1, 1, baseSha)),
      finalizeRestoredContext(pool, {uid: ADMIN, workspaceId: WS}, ctxOf(ARC_RACE), finalizeCommand('fin_race_b', 1, 1, baseSha)),
    ]);
    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejectedResults = results.filter(result => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejectedResults.length, 1);
    assert.equal(rejectedResults[0].reason.code, 'archive-changed');
    await withClient(async client => {
      assert.deepEqual(await archiveCounts(client, ARC_RACE), {revisions: 2, publications: 1, receipts: 2, audits: 1});
      assert.equal((await contextRow(client, ARC_RACE)).context_state, 'finalized');
      const series = await seriesRow(client, ARC_RACE);
      assert.equal(series.latest_finalized_revision, '2');
      assert.equal(series.latest_finalized_sha256, fulfilled[0].value.sha256);
    });
  });

  await t.test('an identical concurrent finalize replays instead of publishing twice', async () => {
    const baseSha = seededSha.get(ARC_RACE_IDENT);
    const command = finalizeCommand('fin_race_same', 1, 1, baseSha);
    const results = await Promise.all([
      finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS}, ctxOf(ARC_RACE_IDENT), command),
      finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS}, ctxOf(ARC_RACE_IDENT), command),
    ]);
    assert.equal(results[0].revision, results[1].revision);
    assert.equal(results[0].sha256, results[1].sha256);
    assert.equal(results.filter(result => result.replayed === true).length, 1);
    await withClient(async client => {
      assert.deepEqual(await archiveCounts(client, ARC_RACE_IDENT), {revisions: 2, publications: 1, receipts: 2, audits: 1});
      assert.equal((await contextRow(client, ARC_RACE_IDENT)).context_revision, '2');
    });
  });

  await t.test('identical replay returns the same revision; another hash or context is operation-id-reused', async () => {
    const baseSha = seededSha.get(ARC_REPLAY);
    const command = finalizeCommand('fin_replay', 1, 1, baseSha);
    const first = await finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS}, ctxOf(ARC_REPLAY), command);
    // Повтор с лишним полем тела: hash считается по нормализованной команде.
    const replay = await finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS}, ctxOf(ARC_REPLAY), {...command, uid: 'other_actor'});
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision, first.revision);
    assert.equal(replay.sha256, first.sha256);
    assert.equal(replay.publishedAt, first.publishedAt);
    await rejected(finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS},
      ctxOf(ARC_REPLAY), {...command, expectedContextRevision: 2}), 'operation-id-reused', 409);
    // Тот же operation id на другом контексте того же workspace — тоже отказ.
    await rejected(finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS},
      ctxOf(ARC_REUSE), command), 'operation-id-reused', 409);
    await withClient(async client => {
      assert.deepEqual(await archiveCounts(client, ARC_REPLAY), {revisions: 2, publications: 1, receipts: 2, audits: 1});
      assert.deepEqual(await archiveCounts(client, ARC_REUSE), {revisions: 1, publications: 0, receipts: 1, audits: 0});
    });
  });

  await t.test('a finalized context cannot be finalized again', async () => {
    const stale = finalizeCommand('fin_again_stale', 4, 1, seededSha.get(ARC_MAIN));
    await rejected(finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS}, ctxOf(ARC_MAIN), stale), 'archive-changed', 409);
    const published = await withClient(client => client.query(
      'SELECT payload_sha256 FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=2',
      [WS, ARC_MAIN],
    ).then(result => result.rows[0]));
    await assert.rejects(finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS},
      ctxOf(ARC_MAIN), finalizeCommand('fin_again_fresh', 5, 2, published.payload_sha256)), error => {
      assert.equal(error.code, 'archive-context-finalized');
      assert.equal(error.status, 409);
      return true;
    });
    await withClient(async client => {
      assert.deepEqual(await archiveCounts(client, ARC_MAIN), {revisions: 2, publications: 1, receipts: 2, audits: 1});
    });
  });

  await t.test('a dangling restore receipt cannot be committed by the deferred FK', async () => {
    const baseSha = seededSha.get(ARC_NORECEIPT);
    await rejected(finalizeRestoredContext(pool, {uid: ARCHIVIST, workspaceId: WS},
      ctxOf(ARC_NORECEIPT), finalizeCommand('fin_noreceipt', 1, 1, baseSha)), '23503');
    await withClient(async client => {
      assert.deepEqual(await archiveCounts(client, ARC_NORECEIPT), {revisions: 1, publications: 0, receipts: 0, audits: 0});
      const context = await contextRow(client, ARC_NORECEIPT);
      assert.equal(context.context_state, 'open');
      assert.equal(context.context_revision, '1');
      assert.equal((await seriesRow(client, ARC_NORECEIPT)).latest_finalized_revision, '1');
    });
  });

  await t.test('finalize has no active shift, material, tabel, reward or game side effects', async () => {
    await withClient(async client => {
      assert.equal(await outsideDigest(client), outsideBefore);
      const live = (await client.query(
        'SELECT count(*)::int AS n FROM shifts WHERE workspace_id=$1', [WS],
      )).rows[0].n;
      assert.equal(live, 1);
      const synthetic = (await client.query(
        "SELECT count(*)::int AS n FROM shifts WHERE workspace_id=$1 AND shift_id<>$2", [WS, LIVE_SHIFT],
      )).rows[0].n;
      assert.equal(synthetic, 0);
    });
  });
});
