// Finalize открытого restored-контекста в следующую неизменяемую ревизию архива
// (design §4.6, строки 243/255). Это ЕДИНСТВЕННАЯ операция публикации: она не
// вызывает closeShift, не трогает активные смены/статусы/рейсы и не создаёт
// material/tabel/reward/game эффектов. Меняется только archive chain:
// новая immutable revision + publication + archive receipt/audit, контекст
// `open → finalized`, `latest_finalized_*` двигается через CAS.
//
// Канонические байты новой ревизии строятся из ТОЧНЫХ байтов базовой ревизии
// (они не пересобираются из колонок) плюс полная упорядоченная история контекста.
// Формула зафиксирована в `buildFinalizePayload` и повторена независимо в тесте.
import {createHash} from 'node:crypto';
import {fail,map} from './tabel-access.mjs';
import {serviceActor,validId} from './service-command.mjs';
import {archiveCommandHash} from './archive-store.mjs';
import {canonicalJson} from './legacy-historicalization.mjs';

const WS=process.env.WORKSPACE_ID||'main_workspace';
const SHA_RE=/^[0-9a-f]{64}$/;
// Публикация — архивная правка: тот же ACL, что у restore/corrections (design §6).
const PERMISSION='archive_edit';
// Версия источника новой ревизии: она создана finalize, а не close/import.
export const FINALIZE_SOURCE_KIND='restored-context-finalize';

const sha256Hex=value=>createHash('sha256').update(value).digest('hex');
const num=value=>Number(value);

// Тело запроса на права не влияет: в command hash входит только нормализованная
// команда, поэтому лишние поля (в том числе `uid`) не могут ни дать прав, ни
// изменить идентичность операции.
function normalizeFinalize(command){
  if(!map(command))throw fail('invalid-archive-operation');
  if(!validId(command.operationId)||command.protocolVersion!==2)throw fail('invalid-archive-operation');
  if(!Number.isSafeInteger(command.expectedContextRevision)||command.expectedContextRevision<1)throw fail('invalid-archive-operation');
  if(!Number.isSafeInteger(command.expectedBaseArchiveRevision)||command.expectedBaseArchiveRevision<1)throw fail('invalid-archive-operation');
  if(typeof command.expectedBaseSha256!=='string'||!SHA_RE.test(command.expectedBaseSha256))throw fail('invalid-archive-operation');
  return {
    id:command.operationId,
    type:'restored.finalize',
    expectedContextRevision:command.expectedContextRevision,
    expectedBaseArchiveRevision:command.expectedBaseArchiveRevision,
    expectedBaseSha256:command.expectedBaseSha256,
  };
}

// Replay ищется ДО любой работы (append-only receipt нельзя «захватить и потом
// дописать», урок 24): идентичная операция возвращает записанный результат, а
// чужой/иной operation id — стабильный `operation-id-reused`.
async function replayReceipt(client,workspaceId,operationId,{archiveId,contextId,uid,commandHash}){
  const row=(await client.query(
    'SELECT archive_id,uid,command_hash,result FROM archive_operation_receipts WHERE workspace_id=$1 AND operation_id=$2',
    [workspaceId,operationId],
  )).rows[0];
  if(!row)return null;
  if(row.uid!==uid||row.archive_id!==archiveId||row.command_hash!==commandHash
    ||row.result?.contextId!==contextId)throw fail('operation-id-reused',409);
  return row.result;
}

// Полная упорядоченная история контекста + эффективное состояние для публикации.
// Порядок — байтовый (`COLLATE "C"`), не локальный: одни и те же данные обязаны
// давать одни и те же байты после восстановления в другой кластер.
async function loadContextState(client,workspaceId,restoredContextId,basePayload){
  const snapshots=(await client.query(
    'SELECT truck_id,payload FROM restored_context_status_snapshots WHERE workspace_id=$1 AND restored_context_id=$2 ORDER BY truck_id COLLATE "C"',
    [workspaceId,restoredContextId],
  )).rows;
  const logs=(await client.query(
    'SELECT log_id,payload FROM restored_context_logs WHERE workspace_id=$1 AND restored_context_id=$2 ORDER BY log_id COLLATE "C"',
    [workspaceId,restoredContextId],
  )).rows;
  const history=(await client.query(
    `SELECT action_id,uid,type,revision,undone,before_log,after_log,
            before_status_snapshot,after_status_snapshot,
            to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM restored_context_history WHERE workspace_id=$1 AND restored_context_id=$2
      ORDER BY revision,action_id COLLATE "C"`,
    [workspaceId,restoredContextId],
  )).rows;

  const entries=history.map(row=>({
    actionId:row.action_id,uid:row.uid,type:row.type,revision:num(row.revision),
    undone:row.undone===true,
    beforeLog:row.before_log,afterLog:row.after_log,
    beforeStatusSnapshot:row.before_status_snapshot,afterStatusSnapshot:row.after_status_snapshot,
    createdAt:row.created_at,
  }));

  // Эффективная ТТН = неизменяемый снимок источника + журнал коррекций поверх него.
  const ttn=new Map();
  for(const snap of snapshots)ttn.set(snap.truck_id,snap.payload?.ttnStatus??null);
  for(const entry of entries){
    if(entry.undone||(entry.type!=='ttn.update'&&entry.type!=='ttn.delete'))continue;
    const next=entry.afterStatusSnapshot;
    if(!map(next)||typeof next.truckId!=='string')continue;
    ttn.set(next.truckId,next.ttnStatus??null);
  }
  for(const [truckId,status] of Object.entries(map(basePayload.ttnStatus)?basePayload.ttnStatus:{})){
    if(!ttn.has(truckId))ttn.set(truckId,status??null);
  }
  const ttnStatus={};
  for(const [truckId,status] of ttn)if(status!==null&&status!==undefined)ttnStatus[truckId]=status;

  return {logs:logs.map(row=>row.payload),ttnStatus,history:entries};
}

// ТОЧНАЯ формула канонических байтов ревизии N+1:
//
//   payload = {
//     ...<parsed payload базовой ревизии>,      // ни одно поле базы не теряется
//     logs:      <restored_context_logs по log_id COLLATE "C">,
//     ttnStatus: <эффективный TTN: снимок + журнал, только непустые значения>,
//     totalTrips:  <обычные (не ГАИ) рейсы>,
//     totalVolume: <сумма обычных объёмов>,
//     archiveRevision:  N+1,
//     previousRevision: N,
//     previousSha256:   <sha256 базовой ревизии>,
//     restoredContext: {
//       restoredContextId, restoreOperationId, finalizeOperationId,
//       baseRevision: N, baseSha256, contextRevision: <следующая ревизия контекста>,
//       history: [ {actionId,uid,type,revision,undone,beforeLog,afterLog,
//                   beforeStatusSnapshot,afterStatusSnapshot,createdAt} ... ]
//     }
//   }
//   bytes = UTF-8(canonicalJson(payload))        // JCS: сортировка ключей, без пробелов
//
// Поля `archiveRevision/previous*` и блок `restoredContext` — конверт finalize:
// благодаря им байты новой ревизии никогда не совпадают с базой (UNIQUE по
// payload_sha256 внутри серии) и публикация сама называет своё происхождение.
export function buildFinalizePayload({
  basePayload,logs,ttnStatus,history,baseRevision,baseSha256,nextRevision,
  restoredContextId,restoreOperationId,finalizeOperationId,nextContextRevision,
}){
  if(!map(basePayload))throw fail('invalid-archive-payload',500);
  const ordinary=logs.filter(log=>log?.isGAI!==true);
  return {
    ...basePayload,
    logs,
    ttnStatus,
    totalTrips:ordinary.length,
    totalVolume:ordinary.reduce((sum,log)=>sum+Number(log.volume??0),0),
    archiveRevision:nextRevision,
    previousRevision:baseRevision,
    previousSha256:baseSha256,
    restoredContext:{
      restoredContextId,
      restoreOperationId,
      finalizeOperationId,
      baseRevision,
      baseSha256,
      contextRevision:nextContextRevision,
      history,
    },
  };
}

export function finalizeRevisionBytes(input){
  return Buffer.from(canonicalJson(buildFinalizePayload(input)),'utf8');
}

// Единственная публикация открытого restored-контекста. Вся работа — одна
// транзакция: revision → publication → receipt → audit → контекст → CAS указателя.
// Любая ошибка откатывает всё; контекст остаётся `open`, указатель не сдвинут.
export async function finalizeRestoredContext(pool,session,restoredContextId,command){
  if(!map(session)||!validId(session.uid))throw fail('forbidden',403);
  if(!validId(restoredContextId))throw fail('invalid-restored-context');
  const op=normalizeFinalize(command);
  const workspaceId=validId(session.workspaceId)?session.workspaceId:WS;
  const commandHash=archiveCommandHash(op);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    // ACL — только по текущей session, повторно в этой транзакции (design §4.6).
    await serviceActor(client,session.uid,PERMISSION);
    // Контекст адресуется только внутри своего workspace: чужой/неизвестный — 404
    // до любой записи. archive_id читается без блокировки лишь чтобы выбрать series.
    const known=(await client.query(
      'SELECT archive_id FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2',
      [workspaceId,restoredContextId],
    )).rows[0];
    if(!known)throw fail('archive-context-not-found',404);
    const archiveId=known.archive_id;

    const replayed=await replayReceipt(client,workspaceId,op.id,{archiveId,contextId:restoredContextId,uid:session.uid,commandHash});
    if(replayed){await client.query('COMMIT');return {...replayed,replayed:true};}

    // Порядок блокировок строго series → context: обратный даёт deadlock с
    // коррекциями P8, которые берут только контекст.
    const series=(await client.query(
      'SELECT source_shift_id,latest_finalized_revision,latest_finalized_sha256 FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2 FOR UPDATE',
      [workspaceId,archiveId],
    )).rows[0];
    if(!series)throw fail('archive-not-ready',409);
    const ctx=(await client.query(
      `SELECT archive_id,context_state,archive_revision,context_revision,restore_operation_id
         FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2 FOR UPDATE`,
      [workspaceId,restoredContextId],
    )).rows[0];
    if(!ctx)throw fail('archive-context-not-found',404);

    // Конкурентная идентичная операция уже закоммитила receipt, пока мы ждали
    // блокировку: возвращаем её результат, а не archive-changed.
    const raced=await replayReceipt(client,workspaceId,op.id,{archiveId,contextId:restoredContextId,uid:session.uid,commandHash});
    if(raced){await client.query('COMMIT');return {...raced,replayed:true};}

    const baseRevision=num(ctx.archive_revision),contextRevision=num(ctx.context_revision);
    const latestRevision=series.latest_finalized_revision===null?null:num(series.latest_finalized_revision);
    const latestSha256=series.latest_finalized_sha256;
    const base=(await client.query(
      'SELECT archive_revision,payload_bytes,payload_sha256,payload_schema_version FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=$3',
      [workspaceId,archiveId,baseRevision],
    )).rows[0];
    if(!base)throw fail('archive-changed',409);
    const baseSha256=base.payload_sha256;

    // Порядок проверок:
    // 1) ревизия контекста — самая точная CAS-гранула (конкурентный finalize того
    //    же контекста получает `archive-changed`, а не чужой код);
    // 2) состояние контекста — опубликованную ревизию нельзя опубликовать снова
    //    (стабильный `archive-context-finalized`);
    // 3) базовая ревизия/байты и latest-указатель серии — `archive-changed`.
    if(contextRevision!==op.expectedContextRevision)throw fail('archive-changed',409);
    if(ctx.context_state!=='open')throw fail('archive-context-finalized',409);
    if(baseRevision!==op.expectedBaseArchiveRevision
      ||baseSha256!==op.expectedBaseSha256
      ||latestRevision!==baseRevision
      ||latestSha256!==baseSha256)throw fail('archive-changed',409);

    const nextRevision=baseRevision+1,nextContextRevision=contextRevision+1;
    let basePayload;
    try{basePayload=JSON.parse(base.payload_bytes.toString('utf8'));}
    catch{throw fail('invalid-archive-payload',500);}
    const state=await loadContextState(client,workspaceId,restoredContextId,basePayload);
    const payloadBytes=finalizeRevisionBytes({
      basePayload,...state,
      baseRevision,baseSha256,nextRevision,
      restoredContextId,restoreOperationId:ctx.restore_operation_id,
      finalizeOperationId:op.id,nextContextRevision,
    });
    const payloadSha256=sha256Hex(payloadBytes);

    await client.query(
      `INSERT INTO shift_archive_revisions(
         workspace_id,archive_id,archive_revision,previous_revision,previous_sha256,
         payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_by_uid)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [workspaceId,archiveId,nextRevision,baseRevision,baseSha256,payloadBytes,payloadSha256,
        num(base.payload_schema_version),FINALIZE_SOURCE_KIND,
        `finalize:${archiveId}:${restoredContextId}:${nextRevision}`,session.uid],
    );
    // publication вставляется ДО своего receipt: оба FK на archive_operation_receipts
    // объявлены DEFERRABLE INITIALLY DEFERRED, поэтому dangling publication
    // невозможна — receipt обязан появиться до commit (design §4.6).
    const publication=(await client.query(
      `INSERT INTO archive_revision_publications(
         workspace_id,archive_id,archive_revision,restored_context_id,restore_operation_id,
         finalize_operation_id,base_revision,base_sha256,command_hash,published_by_uid)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING published_at`,
      [workspaceId,archiveId,nextRevision,restoredContextId,ctx.restore_operation_id,
        op.id,baseRevision,baseSha256,commandHash,session.uid],
    )).rows[0];

    const result={
      archiveId,
      revision:nextRevision,
      sha256:payloadSha256,
      contextId:restoredContextId,
      contextRevision:nextContextRevision,
      publishedAt:publication.published_at.toISOString(),
    };
    // Receipt — одна INSERT с готовым результатом (append-only, урок 24).
    const claimed=await client.query(
      `INSERT INTO archive_operation_receipts(workspace_id,operation_id,archive_id,uid,command_hash,result)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING operation_id`,
      [workspaceId,op.id,archiveId,session.uid,commandHash,result],
    );
    if(!claimed.rowCount){
      await client.query('ROLLBACK');
      const old=await replayReceipt(client,workspaceId,op.id,{archiveId,contextId:restoredContextId,uid:session.uid,commandHash});
      if(!old)throw fail('operation-id-reused',409);
      return {...old,replayed:true};
    }

    await client.query(
      `INSERT INTO archive_audit(workspace_id,archive_id,source_shift_id,before_state,after_state,actor_uid)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [workspaceId,archiveId,series.source_shift_id,
        JSON.stringify({contextState:'open',contextRevision,latestFinalizedRevision:latestRevision,latestFinalizedSha256:latestSha256}),
        JSON.stringify({contextState:'finalized',contextRevision:nextContextRevision,archiveRevision:nextRevision,archiveSha256:payloadSha256}),
        session.uid],
    );
    const finalized=await client.query(
      `UPDATE restored_shift_contexts SET context_state='finalized',context_revision=context_revision+1
        WHERE workspace_id=$1 AND restored_context_id=$2 AND context_state='open' AND context_revision=$3
        RETURNING context_revision`,
      [workspaceId,restoredContextId,contextRevision],
    );
    if(!finalized.rowCount)throw fail('archive-changed',409);
    // Указатель двигается только если он всё ещё называет ту же базу: иначе
    // другой finalize уже опубликовал следующую ревизию — откат целиком.
    const moved=await client.query(
      `UPDATE shift_archive_series
          SET latest_finalized_revision=$3,latest_finalized_sha256=$4,series_revision=series_revision+1
        WHERE workspace_id=$1 AND archive_id=$2
          AND latest_finalized_revision=$5 AND latest_finalized_sha256=$6`,
      [workspaceId,archiveId,nextRevision,payloadSha256,baseRevision,baseSha256],
    );
    if(!moved.rowCount)throw fail('archive-changed',409);

    await client.query('COMMIT');
    return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
