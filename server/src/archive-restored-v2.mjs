// v2-маршруты восстановленного архива (design §5.6, §6, §7; план Task 26/§13).
//
// Модуль — тонкая граница между HTTP-контрактом v2 и доменом restored-контекста:
//   * GET  /api/v2/archives/{archiveId}/restored  — идемпотентное открытие;
//   * POST /api/v2/archives/{archiveId}/operations — коррекция рейса/ТТН.
//
// Здесь только валидация формы команды и перевод доменных отказов (`fail(...)`
// из `restored-context-store.mjs`) в стабильные v2-коды. Доменный CAS, receipt
// и audit остаются в домене; общий конверт (operationId, replay, JCS-hash,
// shift-scoped receipt) даёт `runV2Command`. Второго пути нет.
//
// Restored context никогда не становится активной сменой: ни один вызов здесь
// не пишет в `shifts`, `line_logs`, `line_truck_statuses`, `archive_overrides`.
import {map} from './tabel-access.mjs';
import {serviceActor,validId} from './service-command.mjs';
import {V2_ERROR_CODES,v2Error} from './v2-errors.mjs';
import {runV2Command} from './v2-command.mjs';
import {
  CORRECTION_PERMISSION,
  CORRECTION_TYPES,
  MAX_TRIPS_PAGE,
  applyRestoredCorrection,
  openRestoredContext,
} from './restored-context-store.mjs';

const WS=process.env.WORKSPACE_ID||'main_workspace';
const SHA_RE=/^[0-9a-f]{64}$/;
const TIME_RE=/^([01]\d|2[0-3]):[0-5]\d$/;
// Доменные коды, которые клиент обязан увидеть как есть. Неизвестный код
// остаётся внутренней ошибкой (500 `internal`), а не подделкой контракта.
const DOMAIN_CODES=new Set([
  'forbidden','operation-id-reused','archive-changed','archive-context-not-found',
  'archive-context-finalized','archive-not-found','archive-not-restorable',
  'archive-truck-not-available','archive-not-ready','invalid-archive-data',
  'invalid-archive-id','invalid-archive-revision','invalid-restored-context',
  'invalid-restored-trip','invalid-archive-operation','archive-operation-not-allowed',
  'restored-trip-not-found',
]);

function toV2Error(error){
  if(error?.name==='V2Error')return error;
  const code=typeof error?.code==='string'?error.code:null;
  if(code&&DOMAIN_CODES.has(code)&&Object.hasOwn(V2_ERROR_CODES,code)){
    return v2Error(code,error.status??V2_ERROR_CODES[code]);
  }
  return error;
}

function requireWorkspace(value){
  if(validId(value))return value;
  if(validId(WS))return WS;
  throw v2Error('invalid-command',400,{field:'workspaceId'});
}

function requireActor(actor){
  if(!map(actor)||!validId(actor.uid))throw v2Error('unauthenticated',401);
  return actor;
}

function requireId(value,field){
  if(!validId(value))throw v2Error('invalid-command',400,{field});
  return value;
}

function requireRevision(value,field){
  if(!Number.isSafeInteger(value)||value<1)throw v2Error('invalid-command',400,{field});
  return value;
}

// Данные коррекции нормализуются здесь, до хеша и до базы: тело запроса не
// может ни расширить набор полей, ни повлиять на права.
//
// Клиент (`41-v2-transport.js` → `submitArchiveV2`) кладёт поля правки в
// `fields`, и они уходят в тело верхнего уровня, а не в `data`. Принимаем
// именно эту форму: `volume/timeStr/comment` для рейса, `ttnStatus` для ТТН.
const CORRECTION_FIELDS=Object.freeze(['volume','timeStr','comment','ttnStatus']);

function correctionData(type,options){
  if(type==='trip.update'){
    const {volume,timeStr,comment}=options;
    if(!Number.isFinite(volume)||volume<0||volume>1000
      ||typeof timeStr!=='string'||!TIME_RE.test(timeStr)
      ||typeof comment!=='string'||comment.length>2000)throw v2Error('invalid-command',400,{field:'data'});
    return {volume,timeStr,comment};
  }
  if(type==='ttn.update'){
    const status=options.ttnStatus;
    if(status!=='pending'&&status!==true)throw v2Error('invalid-command',400,{field:'data'});
    return {ttnStatus:status};
  }
  // Удаление не принимает данных: лишнее поле — ошибка формы, а не тихий no-op.
  if(CORRECTION_FIELDS.some(field=>options[field]!==undefined))throw v2Error('invalid-command',400,{field:'data'});
  return null;
}

// GET: открыть (или повторно прочитать) восстановленный архив.
export async function openRestoredArchive(pool,actor,input){
  const options=input??{};
  const workspaceId=requireWorkspace(options.workspaceId);
  const archiveId=requireId(options.archiveId,'archiveId');
  const revision=options.revision===undefined?undefined:requireRevision(options.revision,'revision');
  if(options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>MAX_TRIPS_PAGE)){
    throw v2Error('invalid-command',400,{field:'limit'});
  }
  if(options.cursor!==undefined&&options.cursor!==null&&!validId(options.cursor)){
    throw v2Error('invalid-command',400,{field:'cursor'});
  }
  requireActor(actor);
  try{
    const view=await openRestoredContext(pool,{uid:actor.uid,workspaceId},{
      archiveId,revision,limit:options.limit??100,cursor:options.cursor??null,
    });
    return {protocolVersion:2,workspaceId,...view};
  }catch(error){throw toV2Error(error);}
}

// POST: коррекция открытого контекста через общий `runV2Command`.
export async function submitArchiveOperationV2(pool,actor,input){
  const options=input??{};
  const workspaceId=requireWorkspace(options.workspaceId);
  const archiveId=requireId(options.archiveId,'archiveId');
  requireActor(actor);
  if(options.protocolVersion!==2){
    throw v2Error('protocol-upgrade-required',426,{protocolVersion:options.protocolVersion});
  }
  const operationId=requireId(options.operationId,'operationId');
  const type=options.type;
  if(!CORRECTION_TYPES.includes(type))throw v2Error('archive-operation-not-allowed',400,{field:'type'});
  const restoredContextId=requireId(options.restoredContextId,'restoredContextId');
  const recordId=requireId(options.recordId,'recordId');
  const expectedContextRevision=requireRevision(options.expectedContextRevision,'expectedContextRevision');
  const expectedBaseArchiveRevision=requireRevision(options.expectedBaseArchiveRevision,'expectedBaseArchiveRevision');
  if(typeof options.expectedBaseSha256!=='string'||!SHA_RE.test(options.expectedBaseSha256)){
    throw v2Error('invalid-command',400,{field:'expectedBaseSha256'});
  }
  const data=correctionData(type,options);
  const body={
    restoredContextId,type,recordId,
    expectedContextRevision,expectedBaseArchiveRevision,
    expectedBaseSha256:options.expectedBaseSha256,
    ...(data?{data}:{}),
  };

  // Конверт §4.5 привязан к смене, поэтому источник берётся из самого контекста:
  // receipt архивной коррекции принадлежит архивной (исходной) смене, а не
  // активной линии. ACL проверяется здесь же, чтобы 404/409 не выдавали
  // существование чужого контекста до авторизации.
  const client=await pool.connect();
  let sourceShiftId;
  try{
    await serviceActor(client,actor.uid,CORRECTION_PERMISSION[type]);
    const scope=(await client.query(
      'SELECT archive_id,source_shift_id FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2',
      [workspaceId,restoredContextId],
    )).rows[0];
    if(!scope)throw v2Error('archive-context-not-found',404,{restoredContextId});
    if(scope.archive_id!==archiveId)throw v2Error('archive-changed',409,{archiveId});
    sourceShiftId=scope.source_shift_id;
  }catch(error){throw toV2Error(error);}finally{client.release();}

  try{
    return await runV2Command({
      pool,uid:actor.uid,workspaceId,shiftId:sourceShiftId,
      protocolVersion:2,operation:operationId,type,body,
      // Перепроверка на каждом вызове, включая replay: отозванное право не
      // отдаёт сохранённый результат.
      authorize:async(client)=>{
        await serviceActor(client,actor.uid,CORRECTION_PERMISSION[type]);
        const scope=(await client.query(
          'SELECT archive_id FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2',
          [workspaceId,restoredContextId],
        )).rows[0];
        if(!scope)throw v2Error('archive-context-not-found',404,{restoredContextId});
        if(scope.archive_id!==archiveId)throw v2Error('archive-changed',409,{archiveId});
        return actor;
      },
      mutate:async(client,context)=>{
        const applied=await applyRestoredCorrection(client,{
          uid:actor.uid,workspaceId,
          displayName:typeof actor.displayName==='string'?actor.displayName:undefined,
        },restoredContextId,{...body,operationId:context.operation,protocolVersion:2});
        // `applied` — доменный receipt `{outcome,operationId,type,result}` либо
        // сохранённый receipt с `replayed:true`. Клиенту в обоих случаях нужен
        // ровно `result`, без второго уровня вложенности.
        const result=applied?.result;
        if(!map(result))throw v2Error('invalid-command',400,{field:'result'});
        if(applied.replayed===true)return {result,before:{type,recordId,contextRevision:expectedContextRevision}};
        return {
          result,
          before:{type,recordId,contextRevision:expectedContextRevision},
          after:{contextRevision:result.contextRevision},
        };
      },
    });
  }catch(error){throw toV2Error(error);}
}
