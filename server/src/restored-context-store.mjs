// Домен коррекций ОТКРЫТОГО restored-контекста (design §4.6, §5.2/§5.3).
//
// Здесь нет активации смены и нет записи в активные данные: правятся только
// dedicated-таблицы контекста (`restored_context_logs` — последнее редактируемое
// состояние рейса, append-only `restored_context_history/receipts/audit` —
// журнал коррекций). `restored_context_status_snapshots` — неизменяемый снимок
// источника: TTN-коррекции пишутся только в журнал, эффективное состояние
// получается наложением истории на снимок (это же будет строить finalize).
import {createHash} from 'node:crypto';
import {fail,map} from './tabel-access.mjs';
import {serviceActor,validId} from './service-command.mjs';
import {readLatestFinalizedArchive} from './archive-latest.mjs';

const WS=process.env.WORKSPACE_ID||'main_workspace';

// Разрешён ровно этот закрытый набор; любой другой type — стабильный отказ.
export const CORRECTION_TYPES=Object.freeze(['trip.update','trip.delete','ttn.update','ttn.delete']);
export const UNRESOLVED_AUTHOR='автор не установлен';
export const UNRESOLVED_SHIFT_TYPE='тип смены не подтверждён';
// Правка — archive_edit, удаление — archive_delete (design §6: архивный ACL не
// меняется и membership не требуется). Роль сама по себе права не даёт.
const PERMISSION=Object.freeze({'trip.update':'archive_edit','ttn.update':'archive_edit','trip.delete':'archive_delete','ttn.delete':'archive_delete'});

const TIME_RE=/^([01]\d|2[0-3]):[0-5]\d$/;
const SHA_RE=/^[0-9a-f]{64}$/;
const num=value=>Number(value);

function commandHash(op){return createHash('sha256').update(JSON.stringify(op)).digest('hex');}

// Идентификатор действия выводится из operation id: повтор не создаёт вторую
// запись, а разные операции не могут столкнуться по PK (workspace_id, action_id).
function actionIdFor(operationId){return 'restored_'+createHash('sha256').update(operationId).digest('hex').slice(0,40);}

function normalizeCorrection(command){
  if(!map(command))throw fail('invalid-archive-operation');
  const type=command.type;
  // Проверка типа — до любого обращения к БД: запрещённая операция не пишет ничего.
  if(!CORRECTION_TYPES.includes(type))throw fail('archive-operation-not-allowed');
  if(!validId(command.operationId)||command.protocolVersion!==2||!validId(command.recordId))throw fail('invalid-archive-operation');
  if(!Number.isSafeInteger(command.expectedContextRevision)||command.expectedContextRevision<1)throw fail('invalid-archive-operation');
  if(!Number.isSafeInteger(command.expectedBaseArchiveRevision)||command.expectedBaseArchiveRevision<1)throw fail('invalid-archive-operation');
  if(typeof command.expectedBaseSha256!=='string'||!SHA_RE.test(command.expectedBaseSha256))throw fail('invalid-archive-operation');
  const op={id:command.operationId,type,recordId:command.recordId,
    expectedContextRevision:command.expectedContextRevision,
    expectedBaseArchiveRevision:command.expectedBaseArchiveRevision,
    expectedBaseSha256:command.expectedBaseSha256};
  if(type==='trip.update'){
    const d=command.data;
    if(!map(d)||!Number.isFinite(d.volume)||d.volume<0||d.volume>1000
      ||typeof d.timeStr!=='string'||!TIME_RE.test(d.timeStr)
      ||typeof d.comment!=='string'||d.comment.length>2000)throw fail('invalid-archive-operation');
    op.data={volume:d.volume,timeStr:d.timeStr,comment:d.comment};
  }else if(type==='ttn.update'){
    const status=command.data?.ttnStatus;
    // Отметка ТТН в системе либо ожидает ('pending'), либо собрана (true).
    if(status!=='pending'&&status!==true)throw fail('invalid-archive-operation');
    op.data={ttnStatus:status};
  }
  return op;
}

async function loadBaseSha(client,workspaceId,archiveId,archiveRevision){
  const row=(await client.query('SELECT payload_sha256 FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=$3',[workspaceId,archiveId,archiveRevision])).rows[0];
  return row?.payload_sha256??null;
}

// Эффективная отметка ТТН = неизменяемый снимок источника + журнал коррекций.
async function effectiveTtn(client,workspaceId,restoredContextId,truckId){
  const snapshot=(await client.query('SELECT payload,ttn_revision FROM restored_context_status_snapshots WHERE workspace_id=$1 AND restored_context_id=$2 AND truck_id=$3',[workspaceId,restoredContextId,truckId])).rows[0];
  const last=(await client.query(
    "SELECT after_status_snapshot FROM restored_context_history WHERE workspace_id=$1 AND restored_context_id=$2 AND undone=false AND type IN ('ttn.update','ttn.delete') AND after_status_snapshot->>'truckId'=$3 ORDER BY revision DESC,created_at DESC,action_id DESC LIMIT 1",
    [workspaceId,restoredContextId,truckId],
  )).rows[0];
  const status=last?last.after_status_snapshot?.ttnStatus??null:snapshot?.payload?.ttnStatus??null;
  return {truckId,ttnStatus:status,ttnRevision:snapshot?num(snapshot.ttn_revision):0};
}

// Чтение контекста: сам контекст, его рейсы, TTN и provenance. Никаких догадок
// и fallback: unresolved остаётся unresolved с явным текстом для интерфейса.
export async function readRestoredContext(client,{workspaceId=WS,restoredContextId,archiveRevision,limit=100,cursor=null}={}){
  if(!validId(restoredContextId)||!validId(workspaceId))throw fail('invalid-restored-context');
  if(archiveRevision!==undefined&&(!Number.isSafeInteger(archiveRevision)||archiveRevision<1))throw fail('invalid-restored-context');
  if(!Number.isInteger(limit)||limit<1||limit>200)throw fail('invalid-restored-context');
  if(cursor!==null&&!validId(cursor))throw fail('invalid-restored-context');
  const ctx=(await client.query(
    `SELECT archive_id,source_shift_id,mode,context_state,original_opened_by_uid,
            original_opened_by_name_snapshot,original_identity_resolution,
            original_shift_type,original_shift_type_resolution,
            restored_by_uid,restored_by_name_snapshot,restored_at,archive_revision,
            context_revision,restore_operation_id,source_state_snapshot,source_shift_revision,
            opened_at_snapshot,object_id,object_name,work_date
       FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2`,
    [workspaceId,restoredContextId],
  )).rows[0];
  if(!ctx)throw fail('archive-context-not-found',404);
  // Справочный latest — только через единый резолвер: он делает JOIN с точной
  // ревизией, поэтому «указатель на несуществующую ревизию» даёт null, а не
  // выдуманную latest.
  const latest=await readLatestFinalizedArchive(client,workspaceId,ctx.archive_id);
  // Контекст читается ровно со своей базовой ревизии (той, из которой восстановлен):
  // это его собственные байты, они immutable. Явно запрошенная другая ревизия —
  // не этот контекст (`archive-changed`), а не «похожий» архив. Указатель latest
  // finalized отдаётся справочно: по нему finalize (Task 9) проверяет, что база
  // ещё актуальна, и только он может отказать `archive-changed`.
  const target=archiveRevision??num(ctx.archive_revision);
  const revision=(await client.query('SELECT archive_revision,payload_bytes,payload_sha256 FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=$3',[workspaceId,ctx.archive_id,target])).rows[0];
  if(!revision||num(revision.archive_revision)!==num(ctx.archive_revision))throw fail('archive-changed',409);
  const archive=JSON.parse(revision.payload_bytes.toString('utf8'));

  const rows=(await client.query(
    `SELECT log_id,truck_id,payload,log_revision,source_log_id,created_from_archive_revision
       FROM restored_context_logs WHERE workspace_id=$1 AND restored_context_id=$2
        AND ($3::text IS NULL OR log_id>$3) ORDER BY log_id LIMIT $4`,
    [workspaceId,restoredContextId,cursor,limit+1],
  )).rows;
  const page=rows.slice(0,limit);
  const trips=page.map(row=>({logId:row.log_id,truckId:row.truck_id,payload:row.payload,
    logRevision:num(row.log_revision),sourceLogId:row.source_log_id,
    createdFromArchiveRevision:num(row.created_from_archive_revision)}));

  const snapshots=(await client.query(
    'SELECT truck_id,payload,status_revision,cycle_revision,ttn_revision FROM restored_context_status_snapshots WHERE workspace_id=$1 AND restored_context_id=$2 ORDER BY truck_id',
    [workspaceId,restoredContextId],
  )).rows;
  const ttn=new Map(snapshots.map(row=>[row.truck_id,{
    truckId:row.truck_id,ttnStatus:row.payload?.ttnStatus??null,
    statusRevision:num(row.status_revision),cycleRevision:num(row.cycle_revision),
    ttnRevision:num(row.ttn_revision),source:'snapshot',
  }]));
  // Снимок источника неизменяем: всё, что после него, приходит из журнала.
  const actions=(await client.query(
    "SELECT after_status_snapshot FROM restored_context_history WHERE workspace_id=$1 AND restored_context_id=$2 AND undone=false AND type IN ('ttn.update','ttn.delete') ORDER BY revision,created_at,action_id",
    [workspaceId,restoredContextId],
  )).rows;
  for(const action of actions){
    const next=action.after_status_snapshot;
    if(!map(next)||typeof next.truckId!=='string')continue;
    const row=ttn.get(next.truckId)??{truckId:next.truckId,ttnStatus:null,statusRevision:0,cycleRevision:0,ttnRevision:0,source:'history'};
    ttn.set(next.truckId,{...row,ttnStatus:next.ttnStatus??null,source:'history'});
  }
  for(const [truckId,status] of Object.entries(map(archive.ttnStatus)?archive.ttnStatus:{})){
    if(ttn.has(truckId))continue;
    ttn.set(truckId,{truckId,ttnStatus:status??null,statusRevision:0,cycleRevision:0,ttnRevision:0,source:'archive'});
  }

  const unresolvedAuthor=!ctx.original_opened_by_uid;
  const unresolvedType=!ctx.original_shift_type;
  return {
    format:'samosval-restored-context',version:1,
    workspaceId,restoredContextId,
    archiveId:ctx.archive_id,sourceShiftId:ctx.source_shift_id,
    archiveRevision:num(revision.archive_revision),archiveSha256:revision.payload_sha256,
    baseArchiveRevision:num(ctx.archive_revision),baseArchiveSha256:revision.payload_sha256,
    // Справочно для finalize/UI: актуальна ли ещё база контекста.
    latestFinalizedRevision:latest?.revision??null,
    latestFinalizedSha256:latest?.sha256??null,
    baseIsLatest:latest?latest.revision===num(ctx.archive_revision):null,
    contextRevision:num(ctx.context_revision),contextState:ctx.context_state,mode:ctx.mode,
    shiftSnapshot:{
      objectId:ctx.object_id,objectName:ctx.object_name,workDate:ctx.work_date,
      openedAt:ctx.opened_at_snapshot,sourceShiftRevision:num(ctx.source_shift_revision),
      openedByUid:ctx.original_opened_by_uid,openedByName:ctx.original_opened_by_name_snapshot,
      identityResolution:ctx.original_identity_resolution,
      shiftType:ctx.original_shift_type,shiftTypeResolution:ctx.original_shift_type_resolution,
      source:ctx.source_state_snapshot,
    },
    trips,ttn:[...ttn.values()].sort((a,b)=>a.truckId.localeCompare(b.truckId)),
    tripsPage:{limit,nextCursor:rows.length>limit?page.at(-1).logId:null,hasMore:rows.length>limit},
    provenance:{
      originalOpenedByUid:ctx.original_opened_by_uid,
      originalOpenedByName:ctx.original_opened_by_name_snapshot,
      originalIdentityResolution:ctx.original_identity_resolution,
      originalShiftType:ctx.original_shift_type,
      originalShiftTypeResolution:ctx.original_shift_type_resolution,
      restoredByUid:ctx.restored_by_uid,restoredByName:ctx.restored_by_name_snapshot,
      restoredAt:ctx.restored_at,restoreOperationId:ctx.restore_operation_id,
      baseArchiveRevision:num(ctx.archive_revision),baseArchiveSha256:revision.payload_sha256,
      unresolvedAuthor,unresolvedShiftType:unresolvedType,
      authorText:unresolvedAuthor?UNRESOLVED_AUTHOR:ctx.original_opened_by_name_snapshot,
      shiftTypeText:unresolvedType?UNRESOLVED_SHIFT_TYPE:ctx.original_shift_type,
    },
  };
}

// Единственная мутирующая операция домена: коррекция открытого контекста.
// Actor — только из session; original opener/identity_resolution и restored_by
// не меняются. Receipt, mutation, history и audit — в одной транзакции.
export async function submitRestoredCorrection(pool,session,restoredContextId,command){
  if(!map(session)||!validId(session.uid))throw fail('forbidden',403);
  if(!validId(restoredContextId))throw fail('invalid-restored-context');
  const op=normalizeCorrection(command);
  const workspaceId=validId(session.workspaceId)?session.workspaceId:WS;
  const hash=commandHash(op);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    // ACL проверяется по сессии (admin проходит по роли); тело запроса на права не влияет.
    await serviceActor(client,session.uid,PERMISSION[op.type]);
    // Контекст адресуется только внутри своего workspace: чужой/неизвестный — 404
    // до любой записи (receipt тоже не создаётся).
    const known=await client.query('SELECT 1 FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2',[workspaceId,restoredContextId]);
    if(!known.rowCount)throw fail('archive-context-not-found',404);
    // Receipts append-only: сначала читаем существующий, чтобы повтор не выполнял
    // работу и не упирался в CAS устаревшей ревизии.
    const existing=(await client.query('SELECT uid,restored_context_id,protocol_version,command_hash,result FROM restored_context_receipts WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,op.id])).rows[0];
    if(existing){
      if(existing.uid!==session.uid||existing.restored_context_id!==restoredContextId
        ||existing.protocol_version!==2||existing.command_hash!==hash)throw fail('operation-id-reused',409);
      await client.query('COMMIT');
      return {...existing.result,replayed:true};
    }
    const ctx=(await client.query(
      `SELECT archive_id,context_state,archive_revision,context_revision,original_opened_by_uid,
              original_identity_resolution,restored_by_uid
         FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2 FOR UPDATE`,
      [workspaceId,restoredContextId],
    )).rows[0];
    if(!ctx)throw fail('archive-context-not-found',404);
    // Опубликованная (finalized) ревизия неприкосновенна: правок нет вообще.
    if(ctx.context_state!=='open')throw fail('archive-context-finalized',409);
    const baseSha=await loadBaseSha(client,workspaceId,ctx.archive_id,num(ctx.archive_revision));
    // CAS сразу по трём значениям: контекст, базовая ревизия архива и её байты.
    if(num(ctx.context_revision)!==op.expectedContextRevision
      ||num(ctx.archive_revision)!==op.expectedBaseArchiveRevision)throw fail('archive-changed',409);
    if(baseSha===null||baseSha!==op.expectedBaseSha256)throw fail('archive-changed',409);

    const revision=num(ctx.context_revision)+1,actionId=actionIdFor(op.id);
    let beforeLog=null,afterLog=null,beforeStatus=null,afterStatus=null;

    if(op.type==='trip.update'){
      const row=(await client.query(
        'SELECT payload,log_revision FROM restored_context_logs WHERE workspace_id=$1 AND restored_context_id=$2 AND log_id=$3 FOR UPDATE',
        [workspaceId,restoredContextId,op.recordId],
      )).rows[0];
      if(!row)throw fail('restored-trip-not-found',404);
      if(!Number.isFinite(row.payload?.timestamp))throw fail('invalid-restored-trip',409);
      const [hours,minutes]=op.data.timeStr.split(':').map(Number);
      const timestamp=Math.floor((row.payload.timestamp+10800000)/86400000)*86400000-10800000+(hours*60+minutes)*60000;
      beforeLog=row.payload;
      afterLog={...row.payload,...op.data,timestamp};
      await client.query(
        'UPDATE restored_context_logs SET payload=$4,log_revision=log_revision+1 WHERE workspace_id=$1 AND restored_context_id=$2 AND log_id=$3',
        [workspaceId,restoredContextId,op.recordId,afterLog],
      );
    }else if(op.type==='trip.delete'){
      const row=(await client.query(
        'SELECT payload FROM restored_context_logs WHERE workspace_id=$1 AND restored_context_id=$2 AND log_id=$3 FOR UPDATE',
        [workspaceId,restoredContextId,op.recordId],
      )).rows[0];
      if(!row)throw fail('restored-trip-not-found',404);
      beforeLog=row.payload;
      await client.query('DELETE FROM restored_context_logs WHERE workspace_id=$1 AND restored_context_id=$2 AND log_id=$3',[workspaceId,restoredContextId,op.recordId]);
    }else{
      // TTN: снимок источника не переписывается, коррекция — запись журнала.
      const current=await effectiveTtn(client,workspaceId,restoredContextId,op.recordId);
      beforeStatus={truckId:op.recordId,ttnStatus:current.ttnStatus};
      afterStatus={truckId:op.recordId,ttnStatus:op.type==='ttn.delete'?null:op.data.ttnStatus};
    }

    const before={log:beforeLog,ttn:beforeStatus},after={log:afterLog,ttn:afterStatus};
    await client.query(
      `INSERT INTO restored_context_history(workspace_id,action_id,restored_context_id,uid,type,before_log,after_log,before_status_snapshot,after_status_snapshot,revision,undone)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false)`,
      [workspaceId,actionId,restoredContextId,session.uid,op.type,
        beforeLog===null?null:JSON.stringify(beforeLog),afterLog===null?null:JSON.stringify(afterLog),
        beforeStatus===null?null:JSON.stringify(beforeStatus),afterStatus===null?null:JSON.stringify(afterStatus),revision],
    );
    await client.query(
      'INSERT INTO restored_context_audit(workspace_id,restored_context_id,action_id,operation_id,uid,type,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [workspaceId,restoredContextId,actionId,op.id,session.uid,op.type,JSON.stringify(before),JSON.stringify(after)],
    );
    const updated=await client.query(
      "UPDATE restored_shift_contexts SET context_revision=context_revision+1 WHERE workspace_id=$1 AND restored_context_id=$2 AND context_state='open' AND context_revision=$3 RETURNING context_revision",
      [workspaceId,restoredContextId,op.expectedContextRevision],
    );
    if(!updated.rowCount)throw fail('archive-changed',409);

    const result={restoredContextId,archiveId:ctx.archive_id,
      archiveRevision:num(ctx.archive_revision),archiveSha256:baseSha,
      contextRevision:num(updated.rows[0].context_revision),actionId,type:op.type,recordId:op.recordId,
      log:afterLog,ttn:afterStatus};
    const receipt={outcome:'confirmed',operationId:op.id,type:op.type,result};
    // Receipt пишется ровно одной INSERT с готовым результатом (таблица append-only).
    const claimed=await client.query(
      `INSERT INTO restored_context_receipts(workspace_id,operation_id,restored_context_id,uid,protocol_version,command_hash,result)
       VALUES($1,$2,$3,$4,2,$5,$6) ON CONFLICT DO NOTHING RETURNING operation_id`,
      [workspaceId,op.id,restoredContextId,session.uid,hash,receipt],
    );
    if(!claimed.rowCount){
      // Гонка одинаковых операций: зафиксирован чужой receipt — вся работа отменяется.
      await client.query('ROLLBACK');
      const old=(await client.query('SELECT uid,restored_context_id,protocol_version,command_hash,result FROM restored_context_receipts WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,op.id])).rows[0];
      if(!old||old.uid!==session.uid||old.restored_context_id!==restoredContextId
        ||old.protocol_version!==2||old.command_hash!==hash)throw fail('operation-id-reused',409);
      return {...old.result,replayed:true};
    }
    await client.query('COMMIT');
    return receipt;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
