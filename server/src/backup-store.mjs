import {fail,map} from './tabel-access.mjs';
import {serviceActor,serviceCommand,validId} from './service-command.mjs';
import {auxiliaryEntries} from './auxiliary-store.mjs';
import {readArchiveEntries} from './archive-read.mjs';
const WS=process.env.WORKSPACE_ID||'main_workspace';
const workspaceTables=['line_trucks','workspace_objects','shifts','line_truck_statuses','line_logs','shift_archives','archive_overrides','workspace_settings','workspace_aux_records','tabel_records'];
const globalTables=['app_users','role_permissions','role_permission_versions','registration_requests'];
const sectionTables={base:['line_trucks','workspace_objects'],archive:['shift_archives','archive_overrides'],shift:['shifts','line_truck_statuses','line_logs'],settings:['workspace_settings','workspace_aux_records','role_permissions','role_permission_versions'],users:['app_users','registration_requests'],tabel:['tabel_records']};
export function normalizeBackup(input){
 if(!map(input)||!validId(input.id)||!['backup.create','backup.mark','backup.delete','backup.restore'].includes(input.type))throw fail('invalid-backup-operation');
 const op={id:input.id,type:input.type};
 if(input.type==='backup.create'){if(typeof input.description!=='string'||input.description.length>500||!['manual','auto','before_restore','before_close','before_import'].includes(input.backupType))throw fail('invalid-backup-description');Object.assign(op,{description:input.description,backupType:input.backupType});}
 else {if(!validId(input.backupId))throw fail('invalid-backup-id');op.backupId=input.backupId;
  if(input.type==='backup.mark'){if(typeof input.important!=='boolean')throw fail('invalid-backup-mark');op.important=input.important;}
  if(input.type==='backup.restore'){if(!map(input.sections)||!Object.values(input.sections).some(Boolean)||Object.entries(input.sections).some(([k,v])=>!Object.hasOwn(sectionTables,k)||typeof v!=='boolean'))throw fail('invalid-backup-sections');op.sections=input.sections;}
 }return op;
}
async function capture(c,ws){
 const native={};for(const table of workspaceTables)native[table]=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1`,[ws])).rows;
 for(const table of globalTables)native[table]=(await c.query(`SELECT * FROM ${table}`)).rows;
 const state=(await c.query('SELECT import_sha256 FROM identity_state WHERE id=1')).rows[0];if(!state?.import_sha256)throw fail('backup-source-not-ready',409);
 const archives=await readArchiveEntries(c,ws),aux=await auxiliaryEntries(c,ws),data={};
 for(const [name,table,key] of [['trucks','line_trucks','truck_id'],['objects','workspace_objects','object_id'],['logs','line_logs','log_id'],['truckStatus','line_truck_statuses','truck_id']])data[name]=native[table].map(r=>({id:r[key],data:r.payload}));
 for(const name of ['archive','trash'])data[name]=(name==='archive'?archives.archives:archives.trash).map(r=>({id:r.id,data:r}));
 for(const name of ['plugins','patches','audit','notifications'])data[name]=[...aux[name].values()].map(r=>({id:r.id,data:r}));
 data.shift=native.shifts.filter(r=>r.is_active||r.payload.closing).map(r=>({id:'current',data:r.payload}));
 data.appConfig_test=native.workspace_settings.map(r=>({id:'appConfig_test',data:r.payload}));
 data.users=native.app_users.map(r=>({id:r.uid,data:{...r.profile,email:r.email,nickname:r.display_name,role:r.role,status:r.status}}));
 data.tabelNextRecords=native.tabel_records.map(r=>({id:r.record_id,data:r.payload}));
 return {version:2,source:'synology',workspaceId:ws,importSha256:state.import_sha256,data,native};
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
 await c.query('COMMIT');return {format:'samosval-backups',version:1,source:'synology',workspaceId:ws,...result};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
async function restore(c,ws,payload,sections,actor){
 if(payload.source!=='synology'||payload.version!==2||payload.workspaceId!==ws||payload.importSha256!==(await c.query('SELECT import_sha256 FROM identity_state WHERE id=1')).rows[0]?.import_sha256)throw fail('backup-source-mismatch',409);
 const tables=new Set(Object.entries(sections).filter(([,v])=>v).flatMap(([k])=>sectionTables[k]));
 const rows=structuredClone(payload.native),current={};for(const table of tables)current[table]=(await c.query(`SELECT * FROM ${table}`+(workspaceTables.includes(table)?' WHERE workspace_id=$1':''),workspaceTables.includes(table)?[ws]:[])).rows;
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
 const order=['registration_requests','line_truck_statuses','line_logs','workspace_aux_records','archive_overrides','shift_archives','tabel_records','workspace_settings','workspace_objects','line_trucks','role_permissions','role_permission_versions'];
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
