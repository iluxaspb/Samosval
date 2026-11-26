import {createHash,randomBytes} from 'node:crypto';
import {fail,map} from './tabel-access.mjs';
import {serviceActor,serviceCommand,validId} from './service-command.mjs';
import {auxiliaryEntries} from './auxiliary-store.mjs';
import {readArchiveEntries} from './archive-read.mjs';
import {listArchiveSeries,readArchiveHistory} from './archive-latest.mjs';
import {computeBootstrapFingerprint,verifyRestoreBootstrap} from './restore-bootstrap.mjs';
const WS=process.env.WORKSPACE_ID||'main_workspace';
const workspaceTables=['truck_phones','line_trucks','workspace_objects','shifts','line_truck_statuses','line_logs','shift_archives','archive_overrides','workspace_settings','workspace_aux_records','tabel_records'];
const globalTables=['app_users','role_permissions','role_permission_versions','registration_requests'];
const sectionTables={base:['truck_phones','line_trucks','workspace_objects'],archive:['shift_archives','archive_overrides'],shift:['shifts','line_truck_statuses','line_logs'],settings:['workspace_settings','workspace_aux_records','role_permissions','role_permission_versions'],users:['app_users','registration_requests'],tabel:['tabel_records']};
export function normalizeBackup(input){
 if(!map(input)||!validId(input.id)||!['backup.create','backup.mark','backup.delete','backup.restore'].includes(input.type))throw fail('invalid-backup-operation');
 const op={id:input.id,type:input.type};
 if(input.type==='backup.create'){if(typeof input.description!=='string'||input.description.length>500||!['manual','auto','before_restore','before_close','before_import'].includes(input.backupType))throw fail('invalid-backup-description');Object.assign(op,{description:input.description,backupType:input.backupType});}
 else {if(!validId(input.backupId))throw fail('invalid-backup-id');op.backupId=input.backupId;
  if(input.type==='backup.mark'){if(typeof input.important!=='boolean')throw fail('invalid-backup-mark');op.important=input.important;}
  if(input.type==='backup.restore'){if(!map(input.sections)||!Object.values(input.sections).some(Boolean)||Object.entries(input.sections).some(([k,v])=>!Object.hasOwn(sectionTables,k)||typeof v!=='boolean'))throw fail('invalid-backup-sections');op.sections=input.sections;}
 }return op;
}
// Read-only экспорт цепочки: серия → все ревизии по возрастанию, точные байты в
// base64 и их sha256. Восстановление ревизий не входит в backup.restore (это
// owner/migration путь), но full backup обязан сохранить сами байты.
async function archiveRevisionChain(c,ws){
 const chain=[];
 for(const series of await listArchiveSeries(c,ws)){
  const history=await readArchiveHistory(c,ws,series.archiveId);
  if(!history)continue;
  chain.push({id:history.archiveId,archiveId:history.archiveId,sourceShiftId:history.sourceShiftId,
   currentLocation:history.currentLocation,latestFinalizedRevision:history.latestFinalizedRevision,
   latestFinalizedSha256:history.latestFinalizedSha256,
   revisions:history.revisions.map(r=>({revision:r.revision,sha256:r.sha256,previousRevision:r.previousRevision,
    previousSha256:r.previousSha256,payloadSchemaVersion:r.payloadSchemaVersion,sourceKind:r.sourceKind,
    sourceLocator:r.sourceLocator,createdAt:r.createdAt,createdByUid:r.createdByUid,
    payloadBase64:r.payloadBytes.toString('base64')}))});
 }
 return chain;
}
async function capture(c,ws){
 const native={};for(const table of workspaceTables)native[table]=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1`,[ws])).rows;
 for(const table of globalTables)native[table]=(await c.query(`SELECT * FROM ${table}`)).rows;
 const state=(await c.query('SELECT import_sha256 FROM identity_state WHERE id=1')).rows[0];if(!state?.import_sha256)throw fail('backup-source-not-ready',409);
 const archives=await readArchiveEntries(c,ws),aux=await auxiliaryEntries(c,ws),data={};
 for(const [name,table,key] of [['trucks','line_trucks','truck_id'],['objects','workspace_objects','object_id'],['logs','line_logs','log_id'],['truckStatus','line_truck_statuses','truck_id']])data[name]=native[table].map(r=>({id:r[key],data:r.payload}));
 for(const name of ['archive','trash'])data[name]=(name==='archive'?archives.archives:archives.trash).map(r=>({id:r.id,data:r}));
 // Immutable revision chain: original + каждая ревизия, точные байты. Trash
 // placement не скрывает цепочку от full backup (design §4.6).
 data.archiveRevisions=await archiveRevisionChain(c,ws);
 for(const name of ['plugins','patches','audit','notifications'])data[name]=[...aux[name].values()].map(r=>({id:r.id,data:r}));
 data.shift=native.shifts.filter(r=>r.is_active||r.payload.closing).map(r=>({id:'current',data:r.payload}));
 data.appConfig_test=native.workspace_settings.map(r=>({id:'appConfig_test',data:r.payload}));
 data.users=native.app_users.map(r=>({id:r.uid,data:{...r.profile,email:r.email,nickname:r.display_name,role:r.role,status:r.status}}));
 data.tabelNextRecords=native.tabel_records.map(r=>({id:r.record_id,data:r.payload}));
 return {version:2,source:'ubuntu',workspaceId:ws,importSha256:state.import_sha256,data,native};
}
async function save(c,ws,id,type,description,actor){
 const payload=await capture(c,ws),now=Date.now();payload.createdAt=now;payload.type=type;payload.description=description;
 const meta={id,createdAt:now,createdBy:actor.display_name,createdByEmail:actor.email,type,description,sizeBytes:Buffer.byteLength(JSON.stringify(payload)),counts:Object.fromEntries(Object.entries(payload.data).map(([k,v])=>[k,v.length])),appVersion:'Synology TEST',important:false};
 await c.query('INSERT INTO workspace_backups(workspace_id,backup_id,meta,payload) VALUES ($1,$2,$3,$4)',[ws,id,meta,payload]);
 // Soft rotation retains recoverable bytes; important points never rotate out.
 await c.query("UPDATE workspace_backups SET deleted=true WHERE workspace_id=$1 AND backup_id IN (SELECT backup_id FROM workspace_backups WHERE workspace_id=$1 AND NOT deleted ORDER BY (meta->>'createdAt')::bigint DESC,backup_id DESC OFFSET 15) AND COALESCE((meta->>'important')::boolean,false)=false",[ws]);return meta;
}
export async function readBackups(pool,uid,id,ws=WS){
 const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await serviceActor(c,uid,null,{admin:true,lock:false});
 let result;if(id){if(!validId(id))throw fail('invalid-backup-id');const row=(await c.query('SELECT meta,payload FROM workspace_backups WHERE workspace_id=$1 AND backup_id=$2 AND NOT deleted',[ws,id])).rows[0];if(!row)throw fail('backup-not-found',409);result=row;}
 else result={items:(await c.query("SELECT meta FROM workspace_backups WHERE workspace_id=$1 AND NOT deleted ORDER BY (meta->>'createdAt')::bigint DESC,backup_id DESC LIMIT 50",[ws])).rows.map(r=>r.meta)};
 await c.query('COMMIT');return {format:'samosval-backups',version:1,source:'ubuntu',workspaceId:ws,...result};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
async function restore(c,ws,payload,sections,actor){
 if(!['ubuntu','synology'].includes(payload.source)||payload.version!==2||payload.workspaceId!==ws||payload.importSha256!==(await c.query('SELECT import_sha256 FROM identity_state WHERE id=1')).rows[0]?.import_sha256)throw fail('backup-source-mismatch',409);
 const tables=new Set(Object.entries(sections).filter(([,v])=>v).flatMap(([k])=>sectionTables[k]));
 const rows=structuredClone(payload.native),current={};for(const table of tables)current[table]=(await c.query(`SELECT * FROM ${table}`+(workspaceTables.includes(table)?' WHERE workspace_id=$1':''),workspaceTables.includes(table)?[ws]:[])).rows;
 // Legacy backups did not know phones: preserve matching live phones. Removed
 // trucks' phones remain recoverable in the atomic before_restore checkpoint.
 if(tables.has('truck_phones')&&!Object.hasOwn(rows,'truck_phones'))rows.truck_phones=current.truck_phones.filter(p=>rows.line_trucks.some(t=>t.workspace_id===p.workspace_id&&t.truck_id===p.truck_id));
 // Revisions move forward even when saved contents move back.
 for(const table of ['line_trucks','workspace_objects','workspace_settings','archive_overrides','workspace_aux_records','app_users','role_permission_versions'])if(tables.has(table)){
  const keys={line_trucks:['truck_id'],workspace_objects:['object_id'],workspace_settings:['workspace_id'],archive_overrides:['record_id'],workspace_aux_records:['collection','record_id'],app_users:['uid'],role_permission_versions:['role']}[table],key=r=>keys.map(k=>r[k]).join('|'),old=new Map(current[table].map(r=>[key(r),Number(r.revision)]));
  for(const r of rows[table])r.revision=Math.max(Number(r.revision),old.get(key(r))||0)+1;
 }
 if(tables.has('line_truck_statuses')){const maxCycle=Math.max(0,...current.line_truck_statuses.map(r=>Number(r.payload.cycleRevision||0))),maxTtn=Math.max(0,...current.line_truck_statuses.map(r=>Number(r.payload.ttnRevision||0)));for(const r of rows.line_truck_statuses)r.payload={...r.payload,cycleRevision:Math.max(maxCycle,Number(r.payload.cycleRevision||0))+1,ttnRevision:Math.max(maxTtn,Number(r.payload.ttnRevision||0))+1};}
 if(tables.has('tabel_records')){const max=Math.max(0,...current.tabel_records.map(r=>Number(r.payload.revision||0)));for(const r of rows.tabel_records){r.payload={...r.payload,revision:Math.max(max,Number(r.payload.revision||0))+1};r.baseline_payload=r.payload;}}
 // Passwords remain in Firebase Auth. The protected owner and restoring admin retain access.
 if(tables.has('app_users')){const keep=current.app_users.filter(r=>r.protected||r.uid===actor.uid);rows.app_users=rows.app_users.filter(r=>!keep.some(k=>k.uid===r.uid)).concat(keep.map(r=>({...r,revision:Number(r.revision)+1})));for(const r of current.app_users)if(!rows.app_users.some(x=>x.uid===r.uid))rows.app_users.push({...r,status:'disabled',profile:{...r.profile,deleted:true},revision:Number(r.revision)+1});}
 // Keep shifts referenced by unselected data and historical game/audit records.
 if(tables.has('shifts')){const wanted=new Set(rows.shifts.map(r=>r.shift_id));for(const r of current.shifts)if(!wanted.has(r.shift_id))rows.shifts.push({...r,is_active:false,payload:{...r.payload,isActive:false,closing:false}});}
 if(tables.has('workspace_aux_records'))rows.workspace_aux_records=rows.workspace_aux_records.filter(r=>r.collection!=='audit').concat(current.workspace_aux_records.filter(r=>r.collection==='audit'));
 // Delete child rows first; then insert parents before children.
 const order=['truck_phones','registration_requests','line_truck_statuses','line_logs','workspace_aux_records','archive_overrides','shift_archives','tabel_records','workspace_settings','workspace_objects','line_trucks','role_permissions','role_permission_versions'];
 for(const table of order)if(tables.has(table))await c.query(`DELETE FROM ${table}`+(workspaceTables.includes(table)?' WHERE workspace_id=$1':''),workspaceTables.includes(table)?[ws]:[]);
 for(const table of ['app_users','shifts',...order.slice().reverse()])if(tables.has(table)){
  const columns=(await c.query('SELECT column_name FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=$1 ORDER BY ordinal_position',[table])).rows.map(r=>r.column_name);
  for(const row of rows[table]){const values=columns.map(k=>row[k]===undefined?null:typeof row[k]==='object'&&row[k]!==null?JSON.stringify(row[k]):row[k]);
   const keys=table==='app_users'?['uid']:table==='shifts'?['workspace_id','shift_id']:null;
   await c.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map((_,i)=>'$'+(i+1)).join(',')})`+(keys?` ON CONFLICT(${keys.join(',')}) DO UPDATE SET ${columns.filter(k=>!keys.includes(k)).map(k=>k+'=EXCLUDED.'+k).join(',')}`:''),values);
  }
 }
 if(tables.has('workspace_settings'))await c.query("UPDATE workspaces SET cycle_minutes=(SELECT (payload->>'cycleMinutes')::integer FROM workspace_settings WHERE workspace_id=$1) WHERE id=$1",[ws]);
 await c.query('UPDATE workspaces SET restore_epoch=restore_epoch+1 WHERE id=$1',[ws]);
}
export function submitBackup(pool,uid,input,ws=WS){const op=normalizeBackup(input);return serviceCommand(pool,uid,op,ws,(c,u)=>serviceActor(c,u,null,{admin:true}),async(c,actor)=>{
 // These same tables are locked together for a coherent checkpoint, including Tabel.
 await c.query('LOCK TABLE '+[...workspaceTables,...globalTables].join(',')+' IN SHARE ROW EXCLUSIVE MODE');
 if(op.type==='backup.create'){const meta=await save(c,ws,'backup_'+op.id,op.backupType,op.description,actor);return {result:{meta}};}
 const row=(await c.query('SELECT meta,payload FROM workspace_backups WHERE workspace_id=$1 AND backup_id=$2 AND NOT deleted FOR UPDATE',[ws,op.backupId])).rows[0];if(!row)throw fail('backup-not-found',409);
 if(op.type==='backup.mark'){await c.query("UPDATE workspace_backups SET meta=jsonb_set(meta,'{important}',$3::jsonb) WHERE workspace_id=$1 AND backup_id=$2",[ws,op.backupId,JSON.stringify(op.important)]);return {before:row.meta,result:{id:op.backupId,important:op.important}};}
 if(op.type==='backup.delete'){await c.query('UPDATE workspace_backups SET deleted=true WHERE workspace_id=$1 AND backup_id=$2',[ws,op.backupId]);return {before:row.meta,result:{id:op.backupId,deleted:true}};}
 const before=await save(c,ws,'backup_before_'+op.id,'before_restore','Перед восстановлением '+op.backupId,actor);await restore(c,ws,row.payload,op.sections,actor);return {before:before.id,after:op.backupId,result:{id:op.backupId,restored:true,beforeBackupId:before.id}};
});}

// ---------------------------------------------------------------------------
// Full exact provenance bundle (design §4.10).
//
// The legacy checkpoint above stays intact for the ordinary backup API. The
// exports below implement the indivisible exact bundle: normalization makes a
// selective replica/provenance restore unrepresentable, checkpoint captures the
// replica transport image, and restore inserts every original row in the single
// normative order before the deferred constraint checkpoint, verifier and
// restore_epoch mutation.
// ---------------------------------------------------------------------------

const EXACT_FORMAT='samosval-exact-bundle';
const EXACT_VERSION=1;
const SECTION_KEYS=Object.freeze(['base','archive','shift','settings','users','tabel']);
// These names are not sections: a request may not select the provenance groups
// at all, because there is no coherent subset of the replica/archive/restored
// transport image.
const PROVENANCE_KEYS=Object.freeze(['replica','provenance','restored','historical','replicaHeads','replicaPending']);

const GLOBAL_TABLES=Object.freeze(['app_users','role_permissions','role_permission_versions','registration_requests','identity_state']);
const GLOBAL_ORDER=Object.freeze(['identity_state','role_permissions','role_permission_versions','registration_requests','app_users']);
// The normative restore order from design §4.10 step 4–8. Parents precede
// children, archive series precede revisions/contexts, publications precede the
// receipts their deferred FKs name, and the replica transport comes last.
const RESTORE_ORDER=Object.freeze([
  'server_authority','workspace_settings','tabel_policy',
  'workspace_objects','line_trucks','truck_phones',
  'workspace_aux_records','archive_overrides','shift_archives',
  'shifts','shift_members',
  'shift_archive_series','shift_archive_revisions','restored_shift_contexts',
  'line_truck_statuses','line_logs','line_history','tabel_records','game_records',
  'restored_context_logs','restored_context_status_snapshots','restored_context_history',
  'archive_revision_publications','restored_context_migration_evidence',
  'restored_context_migration_evidence_rows',
  'legacy_historicalization_confirmations','legacy_line_status_snapshots',
  'legacy_cutover_historicalization_audit',
  'shift_legacy_resolution_guard','shift_legacy_resolution_audit','archive_audit',
  'workspace_service_audit','line_audit','history_audit','restored_context_audit',
  'archive_operation_receipts','restored_context_receipts','tabel_receipts',
  'shift_operation_receipts','line_operation_receipts','history_receipts',
  'workspace_service_receipts','shift_legacy_resolution_receipts',
  'replica_stream','replica_document_heads','replica_pending_documents','replica_cursor',
]);
// Append-only relations cannot be cleared by the data path (their guards reject
// DELETE/TRUNCATE). Exact restore therefore requires an empty target range for
// them and inserts the original rows once.
const APPEND_ONLY_TABLES=Object.freeze([
  'shift_archive_revisions','archive_operation_receipts','archive_revision_publications',
  'restored_context_status_snapshots','restored_context_history','restored_context_receipts',
  'restored_context_audit','restored_context_migration_evidence',
  'restored_context_migration_evidence_rows','archive_audit',
  'legacy_line_status_snapshots','legacy_cutover_historicalization_audit',
  'shift_legacy_resolution_audit','shift_legacy_resolution_receipts','replica_stream',
]);

const PRIMARY_KEYS=Object.freeze({
  app_users:['uid'],identity_state:['id'],role_permissions:['role','action'],
  role_permission_versions:['role'],registration_requests:['uid'],
  server_authority:['workspace_id'],workspace_settings:['workspace_id'],tabel_policy:['workspace_id'],
  workspace_objects:['workspace_id','object_id'],line_trucks:['workspace_id','truck_id'],
  truck_phones:['workspace_id','truck_id'],workspace_aux_records:['workspace_id','collection','record_id'],
  archive_overrides:['workspace_id','record_id'],shift_archives:['workspace_id','archive_id'],
  shifts:['workspace_id','shift_id'],shift_members:['workspace_id','shift_id','uid'],
  line_truck_statuses:['workspace_id','truck_id'],line_logs:['workspace_id','log_id'],
  line_history:['workspace_id','action_id'],tabel_records:['workspace_id','record_id'],
  game_records:['workspace_id','collection','record_id'],
  workspace_service_audit:['workspace_id','operation_id'],workspace_service_receipts:['workspace_id','operation_id'],
  line_audit:['workspace_id','operation_id'],line_operation_receipts:['workspace_id','operation_id'],
  history_receipts:['workspace_id','operation_id'],history_audit:['workspace_id','operation_id'],
  shift_operation_receipts:['workspace_id','operation_id'],
  shift_archive_series:['workspace_id','archive_id'],shift_archive_revisions:['workspace_id','archive_id','archive_revision'],
  archive_operation_receipts:['workspace_id','operation_id'],
  restored_shift_contexts:['workspace_id','restored_context_id'],
  restored_context_logs:['workspace_id','restored_context_id','log_id'],
  restored_context_status_snapshots:['workspace_id','restored_context_id','truck_id'],
  restored_context_history:['workspace_id','action_id'],
  restored_context_audit:['audit_id'],restored_context_receipts:['workspace_id','operation_id'],
  archive_revision_publications:['workspace_id','archive_id','archive_revision'],
  restored_context_migration_evidence:['workspace_id','evidence_id'],
  restored_context_migration_evidence_rows:['workspace_id','evidence_id','source_table','source_pk_hash'],
  archive_audit:['audit_id'],
  legacy_historicalization_confirmations:['confirmation_id'],
  legacy_line_status_snapshots:['snapshot_id'],legacy_cutover_historicalization_audit:['audit_id'],
  shift_legacy_resolution_guard:['workspace_id','guard_key'],
  shift_legacy_resolution_receipts:['workspace_id','operation_id'],
  shift_legacy_resolution_audit:['audit_id'],
  replica_stream:['workspace_id','direction','seq'],
  replica_document_heads:['workspace_id','collection','document_id'],
  replica_pending_documents:['workspace_id','collection','document_id'],
  replica_cursor:['workspace_id'],
  replica_stream_markers:['workspace_id','direction','marker_version','marker_kind'],
});

// Surrogate identity PKs are not provenance. They are regenerated by the target
// sequence so an exact restore into another workspace in the same database cannot
// collide with the source rows; the digest excludes them for the same reason.
const IDENTITY_COLUMNS=Object.freeze(new Set([
  'restored_context_audit.audit_id','archive_audit.audit_id',
  'legacy_line_status_snapshots.snapshot_id',
  'legacy_cutover_historicalization_audit.audit_id','shift_legacy_resolution_audit.audit_id',
]));

const PUBLISHED_SHIFT_KEYS=Object.freeze([
  'payloadSchemaVersion','id','shiftId','objectId','objectName','startDate','date',
  'workShift','type','state','isActive','startedAt','startedBy','startedByUid',
]);

function canonicalValue(value){
  if(value===null||value===undefined)return null;
  if(value instanceof Date)return value.toISOString();
  if(Buffer.isBuffer(value))return {__bytes:value.toString('base64')};
  if(typeof value==='bigint')return value.toString();
  if(Array.isArray(value))return value.map(canonicalValue);
  if(typeof value==='object'){
    const out={};for(const key of Object.keys(value).sort())out[key]=canonicalValue(value[key]);return out;
  }
  return value;
}
const canonicalJson=value=>JSON.stringify(canonicalValue(value));
const sha256Hex=value=>createHash('sha256').update(value).digest('hex');

function compareValues(left,right){
  if(left===right)return 0;
  if(left===null||left===undefined)return -1;
  if(right===null||right===undefined)return 1;
  const a=left instanceof Date?left.toISOString():String(left);
  const b=right instanceof Date?right.toISOString():String(right);
  return a<b?-1:a>b?1:0;
}
function sortRows(rows,table){
  const keys=PRIMARY_KEYS[table]??[];
  return [...rows].sort((left,right)=>{
    for(const key of keys){
      const order=compareValues(left[key],right[key]);
      if(order!==0)return order;
    }
    return compareValues(canonicalJson(left),canonicalJson(right));
  });
}
// The digest must be independent of the workspace name, so the same checkpoint
// is byte-identical before and after an exact restore into another workspace.
function canonicalRow(row,table=''){
  const out={};
  for(const key of Object.keys(row).sort()){
    if(IDENTITY_COLUMNS.has(`${table}.${key}`))continue;
    out[key]=key==='workspace_id'?'<workspace>':canonicalValue(row[key]);
  }
  return out;
}
function tableDigest(rows,table){
  return sha256Hex(canonicalJson(sortRows(rows,table).map(row=>canonicalRow(row,table))));
}

async function relationExists(db,table){
  const row=(await db.query('SELECT to_regclass($1) AS relation',[`public.${table}`])).rows[0];
  return Boolean(row?.relation);
}

const columnCache=new Map();
async function tableColumns(db,table){
  if(!columnCache.has(table)){
    const rows=(await db.query(
      `SELECT column_name,is_identity FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,[table],
    )).rows;
    columnCache.set(table,{columns:rows.map(row=>row.column_name),identity:rows.filter(row=>row.is_identity==='YES').map(row=>row.column_name)});
  }
  return columnCache.get(table);
}

function quoteIdent(name){
  return `"${String(name).replaceAll('"','""')}"`;
}
function encodeValue(value){
  if(value===undefined)return null;
  if(value&&typeof value==='object'&&value.type==='Buffer'&&Array.isArray(value.data))return Buffer.from(value.data);
  return value;
}
function remapRow(row,sourceWorkspace,targetWorkspace){
  if(!Object.hasOwn(row,'workspace_id')||row.workspace_id!==sourceWorkspace)return {...row};
  return {...row,workspace_id:targetWorkspace};
}

/**
 * Read-only checkpoint of the replica transport image. It is the same image the
 * backup stores and the verifier compares: stream/heads/pending/cursor/markers
 * with the workspace name normalized out of the digest.
 */
export async function checkpointReplicaBundle(db,workspaceId){
  const cursorRow=(await db.query('SELECT * FROM replica_cursor WHERE workspace_id=$1',[workspaceId])).rows[0];
  const stream=(await db.query('SELECT * FROM replica_stream WHERE workspace_id=$1 ORDER BY direction,seq',[workspaceId])).rows;
  const heads=(await db.query('SELECT * FROM replica_document_heads WHERE workspace_id=$1 ORDER BY collection,document_id',[workspaceId])).rows;
  const pending=(await db.query('SELECT * FROM replica_pending_documents WHERE workspace_id=$1 ORDER BY collection,document_id',[workspaceId])).rows;
  const markers=await relationExists(db,'replica_stream_markers')
    ?(await db.query('SELECT * FROM replica_stream_markers WHERE workspace_id=$1 ORDER BY direction,marker_version,marker_kind',[workspaceId])).rows
    :[];
  const checkpoint={
    present:Boolean(cursorRow),
    cursor:cursorRow?{f2s_seq:cursorRow.f2s_seq,s2f_seq:cursorRow.s2f_seq}:null,
    stream,heads,pending,markers,
  };
  checkpoint.digest=sha256Hex(canonicalJson({
    cursor:checkpoint.cursor,
    stream:stream.map(row=>canonicalRow(row,'replica_stream')),
    heads:heads.map(row=>canonicalRow(row,'replica_document_heads')),
    pending:pending.map(row=>canonicalRow(row,'replica_pending_documents')),
    markers:markers.map(row=>canonicalRow(row,'replica_stream_markers')),
  }));
  return checkpoint;
}

const CAPTURE_TABLES=Object.freeze([...GLOBAL_ORDER,...RESTORE_ORDER.filter(table=>!GLOBAL_TABLES.includes(table))]);

/**
 * Capture the complete indivisible bundle. No legacy classification or replay:
 * every row is copied exactly, and the bootstrap fingerprint is published so the
 * data path can refuse to run against a different schema.
 */
export async function captureProvenanceBundle(db,workspaceId){
  const tables={};
  for(const table of CAPTURE_TABLES){
    if(table==='identity_state')tables[table]=(await db.query('SELECT * FROM identity_state WHERE id=1')).rows;
    else if(GLOBAL_TABLES.includes(table))tables[table]=(await db.query(`SELECT * FROM ${quoteIdent(table)}`)).rows;
    else tables[table]=(await db.query(`SELECT * FROM ${quoteIdent(table)} WHERE workspace_id=$1`,[workspaceId])).rows;
  }
  if(await relationExists(db,'replica_stream_markers')){
    tables.replica_stream_markers=(await db.query('SELECT * FROM replica_stream_markers WHERE workspace_id=$1',[workspaceId])).rows;
  }
  const workspace=(await db.query('SELECT cycle_minutes FROM workspaces WHERE id=$1',[workspaceId])).rows[0];
  const bundle={
    format:EXACT_FORMAT,
    version:EXACT_VERSION,
    workspaceId,
    capturedAt:new Date().toISOString(),
    bootstrap:await computeBootstrapFingerprint(db),
    provenance:{
      tables,
      workspace:{cycleMinutes:workspace?Number(workspace.cycle_minutes):null},
      replica:await checkpointReplicaBundle(db,workspaceId),
    },
  };
  return resealBundle(bundle);
}

/**
 * Recompute manifest/schema/checksums. Callers that intentionally mutate a
 * bundle (tests, repair tooling) must reseal it so the data path can prove the
 * bytes it is about to insert are the bytes that were captured.
 */
export function resealBundle(bundle){
  const tables={};
  for(const [name,rows] of Object.entries(bundle.provenance.tables??{})){
    const list=Array.isArray(rows)?rows:[];
    tables[name]={count:list.length,sha256:tableDigest(list,name)};
  }
  const replica=bundle.provenance.replica?.digest??null;
  bundle.manifest={
    schema:`${EXACT_FORMAT}/v${EXACT_VERSION}`,
    tables,
    replica,
    digest:sha256Hex(canonicalJson({tables,workspace:bundle.provenance.workspace??null,replica})),
  };
  return bundle;
}

export function verifyBundleManifest(bundle){
  const expected=bundle?.manifest;
  if(!expected||expected.schema!==`${EXACT_FORMAT}/v${EXACT_VERSION}`)throw fail('restore-bundle-manifest-missing',409);
  const tables={};
  for(const [name,rows] of Object.entries(bundle.provenance?.tables??{})){
    const list=Array.isArray(rows)?rows:[];
    tables[name]={count:list.length,sha256:tableDigest(list,name)};
  }
  if(canonicalJson(tables)!==canonicalJson(expected.tables))throw fail('restore-bundle-manifest-mismatch',409);
  const replica=bundle.provenance?.replica?.digest??null;
  const digest=sha256Hex(canonicalJson({tables,workspace:bundle.provenance?.workspace??null,replica}));
  if(digest!==expected.digest||replica!==expected.replica)throw fail('restore-bundle-manifest-mismatch',409);
  return true;
}

const sameContext=(row,context)=>row.workspace_id===context.workspace_id
  &&row.restored_context_id===context.restored_context_id;

/**
 * Structural facts used by normalization. Closure is deliberately about the
 * bundle's internal completeness; exact operation-id matching of deferred
 * receipt FKs is left to the database checkpoint during restore.
 */
export function bundleFacts(bundle){
  const tables=bundle?.provenance?.tables??{};
  const rows=name=>Array.isArray(tables[name])?tables[name]:[];
  const replica=bundle?.provenance?.replica??{};
  const shifts=rows('shifts');
  const objects=rows('workspace_objects');
  const trucks=rows('line_trucks');
  const members=rows('shift_members');
  const statuses=rows('line_truck_statuses');
  const logs=rows('line_logs');
  const users=rows('app_users');
  const series=rows('shift_archive_series');
  const revisions=rows('shift_archive_revisions');
  const publications=rows('archive_revision_publications');
  const receipts=rows('archive_operation_receipts');
  const contexts=rows('restored_shift_contexts');
  const restoredLogs=rows('restored_context_logs');
  const restoredSnapshots=rows('restored_context_status_snapshots');
  const restoredAudit=rows('restored_context_audit');
  const restoredReceipts=rows('restored_context_receipts');
  const confirmations=rows('legacy_historicalization_confirmations');
  const historicalAudit=rows('legacy_cutover_historicalization_audit');
  const facts={
    tables:Object.fromEntries(Object.entries(tables).map(([name,list])=>[name,Array.isArray(list)?list.length:0])),
    replica:{
      stream:Array.isArray(replica.stream)?replica.stream.length:0,
      heads:Array.isArray(replica.heads)?replica.heads.length:0,
      pending:Array.isArray(replica.pending)?replica.pending.length:0,
      cursor:replica.cursor??null,
      present:Boolean(replica.present),
    },
    replicaOwned:{
      objects:objects.length,trucks:trucks.length,shifts:shifts.length,
      members:members.length,statuses:statuses.length,logs:logs.length,users:users.length,
      parents:objects.length+trucks.length+shifts.length,
    },
    archive:{series:series.length,revisions:revisions.length,publications:publications.length,receipts:receipts.length,closure:true},
    restored:{contexts:contexts.length,logs:restoredLogs.length,snapshots:restoredSnapshots.length,audit:restoredAudit.length,receipts:restoredReceipts.length,closure:true},
    historical:{confirmations:confirmations.length,audit:historicalAudit.length,rows:0,closure:true},
  };
  const revisionAt=(workspace,archive,revision)=>revisions.find(row=>row.workspace_id===workspace
    &&row.archive_id===archive&&Number(row.archive_revision)===Number(revision));
  for(const item of series){
    if(item.latest_finalized_revision==null)continue;
    const revision=revisionAt(item.workspace_id,item.archive_id,item.latest_finalized_revision);
    if(!revision||revision.payload_sha256!==item.latest_finalized_sha256)facts.archive.closure=false;
  }
  for(const publication of publications){
    const revision=revisionAt(publication.workspace_id,publication.archive_id,publication.archive_revision);
    const base=revisionAt(publication.workspace_id,publication.archive_id,publication.base_revision);
    if(!revision||!base||base.payload_sha256!==publication.base_sha256)facts.archive.closure=false;
  }
  if(publications.length>0&&receipts.length===0)facts.archive.closure=false;
  for(const context of contexts){
    const hasChild=restoredLogs.some(row=>sameContext(row,context))||restoredSnapshots.some(row=>sameContext(row,context));
    const hasAudit=restoredAudit.some(row=>sameContext(row,context));
    const hasReceipt=restoredReceipts.some(row=>sameContext(row,context));
    if(!hasChild||!hasAudit||!hasReceipt)facts.restored.closure=false;
  }
  const historicalShifts=shifts.filter(row=>row.historicalization_report_hash);
  facts.historical.rows=historicalShifts.length;
  for(const shift of historicalShifts){
    const confirmation=confirmations.find(row=>row.workspace_id===shift.workspace_id
      &&row.report_sha256===shift.historicalization_report_hash);
    const audit=historicalAudit.find(row=>row.workspace_id===shift.workspace_id
      &&row.shift_id===shift.shift_id&&row.report_sha256===shift.historicalization_report_hash);
    if(!confirmation||!audit)facts.historical.closure=false;
  }
  return facts;
}

/**
 * Normalize a restore selection. The replica/archive/restored/historical groups
 * are indivisible: there is no value that can select only part of them, and a
 * selective request that omits an owned section is rejected instead of filtered.
 */
export function normalizeBackupSelection(input,facts){
  if(!map(input))throw fail('invalid-backup-sections');
  for(const key of Object.keys(input)){
    if(PROVENANCE_KEYS.includes(key))throw fail('backup-selection-provenance-not-selectable');
  }
  for(const key of Object.keys(input)){
    if(key!=='full'&&!SECTION_KEYS.includes(key))throw fail('invalid-backup-sections');
  }
  if(input.full!==undefined&&typeof input.full!=='boolean')throw fail('invalid-backup-sections');
  const full=input.full===true;
  const sections={};
  for(const key of SECTION_KEYS){
    const value=full?true:input[key];
    if(value!==undefined&&typeof value!=='boolean')throw fail('invalid-backup-sections');
    sections[key]=value===true;
  }
  if(!full&&!Object.values(sections).some(Boolean))throw fail('invalid-backup-sections');
  const info=facts??{};
  const archivePresent=(info.archive?.series??0)>0;
  const replicaPresent=(info.replicaOwned?.parents??0)>0
    ||(info.replica?.stream??0)>0||(info.replica?.heads??0)>0
    ||(info.restored?.contexts??0)>0;
  if(replicaPresent&&(!sections.base||!sections.shift||!sections.users))throw fail('backup-selection-replica-required');
  if(archivePresent&&!sections.archive)throw fail('backup-selection-archive-required');
  if(info.archive&&info.archive.closure===false)throw fail('backup-selection-archive-closure');
  if(info.restored&&info.restored.closure===false)throw fail('backup-selection-restored-closure');
  if(info.historical&&info.historical.closure===false)throw fail('backup-selection-historical-closure');
  return {full,sections};
}

async function lockRestore(client,workspaceId){
  // Match appendReplicaBatch's existing advisory lock (hashtext) and the design
  // §4.10 extended form, always f2s before s2f, so restore and append serialize.
  for(const direction of ['f2s','s2f']){
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`replica:${workspaceId}:${direction}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`replica:${workspaceId}:${direction}`]);
  }
  await client.query('SELECT 1 FROM replica_cursor WHERE workspace_id=$1 FOR UPDATE',[workspaceId]);
  await client.query('SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);
}

async function clearTarget(client,workspaceId){
  for(const table of APPEND_ONLY_TABLES){
    const count=Number((await client.query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)} WHERE workspace_id=$1`,[workspaceId])).rows[0].n);
    if(count!==0){
      const error=fail('restore-target-not-empty',409);
      error.details={table,count};
      throw error;
    }
  }
  const deletable=[...RESTORE_ORDER].reverse().filter(table=>!APPEND_ONLY_TABLES.includes(table));
  for(const table of deletable){
    await client.query(`DELETE FROM ${quoteIdent(table)} WHERE workspace_id=$1`,[workspaceId]);
  }
}

async function insertRows(client,table,rows){
  const {columns,identity}=await tableColumns(client,table);
  if(columns.length===0){
    const error=fail('restore-table-unknown',409);
    error.details={table};
    throw error;
  }
  const insertColumns=columns.filter(column=>!identity.includes(column));
  const columnList=insertColumns.map(quoteIdent).join(',');
  const placeholders=insertColumns.map((_,index)=>`$${index+1}`).join(',');
  for(const row of rows){
    const values=insertColumns.map(column=>encodeValue(row[column]));
    await client.query(
      `INSERT INTO ${quoteIdent(table)}(${columnList}) VALUES(${placeholders})`,values,
    );
  }
}

async function upsertRows(client,table,rows){
  const {columns}=await tableColumns(client,table);
  const keys=PRIMARY_KEYS[table]??[];
  const columnList=columns.map(quoteIdent).join(',');
  const placeholders=columns.map((_,index)=>`$${index+1}`).join(',');
  const updates=columns.filter(column=>!keys.includes(column)).map(column=>`${quoteIdent(column)}=EXCLUDED.${quoteIdent(column)}`).join(',');
  const conflict=`ON CONFLICT (${keys.map(quoteIdent).join(',')}) ${updates?`DO UPDATE SET ${updates}`:'DO NOTHING'}`;
  for(const row of rows){
    const values=columns.map(column=>encodeValue(row[column]));
    await client.query(
      `INSERT INTO ${quoteIdent(table)}(${columnList}) VALUES(${placeholders}) ${conflict}`,values,
    );
  }
}

async function updateRowExact(client,table,row,keys){
  const {columns}=await tableColumns(client,table);
  const setColumns=columns.filter(column=>!keys.includes(column));
  const values=[...setColumns.map(column=>encodeValue(row[column])),...keys.map(key=>encodeValue(row[key]))];
  await client.query(
    `UPDATE ${quoteIdent(table)} SET ${setColumns.map((column,index)=>`${quoteIdent(column)}=$${index+1}`).join(',')}
      WHERE ${keys.map((key,index)=>`${quoteIdent(key)}=$${setColumns.length+index+1}`).join(' AND ')}`,values,
  );
}

// 025's shifts_legacy_bridge is a strict v2 INSERT normalizer: a historical v2
// document carries lifecycle keys beyond the published 14, so it is inserted as
// the published subset and immediately updated to the exact captured row in the
// same transaction. Legacy v1 rows cannot be inserted through this trigger at all
// and are refused before mutation (reported as a 028 schema blocker).
async function insertShiftRows(client,table,rows){
  for(const row of rows){
    const payload=row.payload;
    const version=row.payload_schema_version??payload?.payloadSchemaVersion;
    if(Number(version)!==2){
      const error=fail('restore-legacy-shift-blocked',409);
      error.details={shiftId:row.shift_id};
      throw error;
    }
    const keys=payload&&typeof payload==='object'?Object.keys(payload):[];
    if(keys.length<=PUBLISHED_SHIFT_KEYS.length){
      await insertRows(client,table,[row]);
      continue;
    }
    const base={};
    for(const key of PUBLISHED_SHIFT_KEYS)if(Object.hasOwn(payload,key))base[key]=payload[key];
    await insertRows(client,table,[{...row,payload:base}]);
    await updateRowExact(client,table,row,PRIMARY_KEYS[table]);
  }
}

async function syncIdentity(client,table){
  const {identity}=await tableColumns(client,table);
  for(const column of identity){
    const sequence=(await client.query('SELECT pg_get_serial_sequence($1,$2) AS sequence',[`public.${table}`,column])).rows[0]?.sequence;
    if(!sequence)continue;
    const max=(await client.query(`SELECT max(${quoteIdent(column)})::bigint AS max FROM ${quoteIdent(table)}`)).rows[0]?.max;
    if(max!==null&&max!==undefined)await client.query('SELECT setval($1,$2,true)',[sequence,max]);
  }
}

async function insertBundle(client,bundle,targetWorkspace){
  const tables=bundle.provenance.tables??{};
  const sourceWorkspace=bundle.workspaceId;
  const globalRows=table=>sortRows((tables[table]??[]).map(row=>remapRow(row,sourceWorkspace,targetWorkspace)),table);
  for(const table of GLOBAL_ORDER){
    const rows=globalRows(table);
    if(rows.length===0)continue;
    await upsertRows(client,table,rows);
    await syncIdentity(client,table);
  }
  const seriesPointers=[];
  for(const table of RESTORE_ORDER){
    const rows=sortRows((tables[table]??[]).map(row=>remapRow(row,sourceWorkspace,targetWorkspace)),table);
    if(rows.length===0)continue;
    if(table==='shift_archive_series'){
      // The latest pointer has an immediate FK to its revision, so the series
      // row is created without it and the exact pointer is restored after the
      // immutable revision rows exist.
      await insertRows(client,table,rows.map(row=>({...row,latest_finalized_revision:null,latest_finalized_sha256:null})));
      seriesPointers.push(...rows);
    }else if(table==='shifts')await insertShiftRows(client,table,rows);
    else await insertRows(client,table,rows);
    await syncIdentity(client,table);
  }
  for(const row of seriesPointers){
    if(row.latest_finalized_revision===null||row.latest_finalized_revision===undefined)continue;
    await client.query(
      `UPDATE shift_archive_series SET latest_finalized_revision=$3,latest_finalized_sha256=$4
        WHERE workspace_id=$1 AND archive_id=$2`,
      [targetWorkspace,row.archive_id,row.latest_finalized_revision,row.latest_finalized_sha256],
    );
  }
  if(Array.isArray(tables.replica_stream_markers)&&tables.replica_stream_markers.length>0
    &&await relationExists(client,'replica_stream_markers')){
    await insertRows(client,'replica_stream_markers',sortRows(
      tables.replica_stream_markers.map(row=>remapRow(row,sourceWorkspace,targetWorkspace)),
      'replica_stream_markers',
    ));
  }
  const cycleMinutes=bundle.provenance.workspace?.cycleMinutes;
  if(Number.isInteger(cycleMinutes))await client.query('UPDATE workspaces SET cycle_minutes=$2 WHERE id=$1',[targetWorkspace,cycleMinutes]);
  // set_history_epoch overwrites dataset_epoch on INSERT; restore the captured
  // value in the same transaction so the committed bytes are exact.
  for(const [table,key] of [['line_history',['workspace_id','action_id']],['workspace_service_audit',['workspace_id','operation_id']]]){
    for(const row of tables[table]??[]){
      const captured=row.dataset_epoch;
      if(captured===undefined||captured===null)continue;
      const remapped=remapRow(row,sourceWorkspace,targetWorkspace);
      await client.query(
        `UPDATE ${quoteIdent(table)} SET dataset_epoch=$3 WHERE workspace_id=$1 AND ${quoteIdent(key[1])}=$2`,
        [targetWorkspace,remapped[key[1]],captured],
      );
    }
  }
}

async function verifyExactRestore(client,bundle,targetWorkspace){
  const actual=await captureProvenanceBundle(client,targetWorkspace);
  for(const [table,expected] of Object.entries(bundle.manifest?.tables??{})){
    const seen=actual.manifest.tables[table];
    if(!seen||seen.count!==expected.count||seen.sha256!==expected.sha256){
      const error=fail('restore-verifier-failed',409);
      error.details={aspect:'table',table,expected,actual:seen??null};
      throw error;
    }
  }
  const expectedReplica=bundle.provenance.replica?.digest??null;
  const actualReplica=actual.provenance.replica.digest;
  if(expectedReplica!==actualReplica){
    const error=fail('restore-verifier-failed',409);
    error.details={aspect:'replica',expected:expectedReplica,actual:actualReplica};
    throw error;
  }
  if(actual.bootstrap.digest!==bundle.bootstrap.digest){
    const error=fail('restore-verifier-failed',409);
    error.details={aspect:'bootstrap'};
    throw error;
  }
  return {replicaDigest:actualReplica,tables:actual.manifest.tables,bootstrapDigest:actual.bootstrap.digest};
}

/**
 * Full exact restore (design §4.10). Bootstrap is verified before the data
 * transaction; normalization rejects selective requests before the checkpoint;
 * every row is inserted in the normative order; deferred FKs/triggers are forced
 * at SET CONSTRAINTS ALL IMMEDIATE; the verifier proves exact equality; only then
 * does restore_epoch move.
 */
export async function restoreReplicaExact(db,options={}){
  const {workspaceId,bundle,bootstrap,selection,allowWorkspaceRemap=true}=options;
  if(typeof workspaceId!=='string'||!workspaceId)throw fail('restore-workspace-required');
  if(!bundle||bundle.format!==EXACT_FORMAT||bundle.version!==EXACT_VERSION)throw fail('restore-bundle-invalid',409);
  if(allowWorkspaceRemap===false&&bundle.workspaceId!==workspaceId)throw fail('restore-workspace-mismatch',409);
  const probe=await db.connect();
  try{
    await verifyRestoreBootstrap(probe,bootstrap,{workspaceId});
  }finally{
    probe.release?.();
  }
  verifyBundleManifest(bundle);
  const facts=bundleFacts(bundle);
  normalizeBackupSelection(selection??{full:true},facts);
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    await lockRestore(client,workspaceId);
    const checkpointBundle=await captureProvenanceBundle(client,workspaceId);
    const checkpointId=`backup_before_exact_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const meta={
      id:checkpointId,createdAt:Date.now(),createdBy:null,createdByEmail:null,
      type:'before_restore',description:'Перед точным восстановлением полного bundle',
      sizeBytes:Buffer.byteLength(JSON.stringify(checkpointBundle)),important:false,
      counts:Object.fromEntries(Object.entries(checkpointBundle.provenance.tables).map(([name,rows])=>[name,rows.length])),
    };
    await client.query(
      'INSERT INTO workspace_backups(workspace_id,backup_id,meta,payload) VALUES($1,$2,$3,$4)',
      [workspaceId,checkpointId,meta,checkpointBundle],
    );
    await clearTarget(client,workspaceId);
    await insertBundle(client,bundle,workspaceId);
    try{
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    }catch(error){
      if(error.code==='23503'){
        const wrapped=fail('restore-constraint-checkpoint-failed',409);
        wrapped.details={constraint:error.constraint??null,table:error.table??null};
        throw wrapped;
      }
      throw error;
    }
    const verifier=await verifyExactRestore(client,bundle,workspaceId);
    await client.query('UPDATE workspaces SET restore_epoch=restore_epoch+1 WHERE id=$1',[workspaceId]);
    await client.query('COMMIT');
    return {outcome:'confirmed',workspaceId,checkpointId,verifier};
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{
    client.release();
  }
}
