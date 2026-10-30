import {fail,map} from './tabel-access.mjs';
import {serviceActor,serviceCommand,validId} from './service-command.mjs';
import {readArchiveEntries} from './archive-read.mjs';
const WS=process.env.WORKSPACE_ID||'main_workspace';
const collections=['plugins','patches','audit','notifications'];
const safeRecord=x=>map(x)&&Buffer.byteLength(JSON.stringify(x))<=900000;
const recordId=x=>typeof x==='string'&&x.length>0&&x.length<=200&&!x.includes('/');
export function publicAuxiliary(value){
 if(Array.isArray(value))return value.map(publicAuxiliary);
 if(map(value))return Object.fromEntries(Object.entries(value).filter(([k])=>!/password|token|secret|^maxUrl$|^maxChatId$/i.test(k)).map(([k,v])=>[k,publicAuxiliary(v)]));
 return value;
}
export async function auxiliaryEntries(client,ws){
 const state=(await client.query('SELECT initialized,import_sha256 FROM identity_state WHERE id=1')).rows[0];
 if(!state?.initialized)throw fail('identity-not-ready',409);
 const source=(await client.query('SELECT workspace_id,source_project FROM migration_imports WHERE sha256=$1',[state.import_sha256])).rows[0];
 if(source?.workspace_id!==ws||source.source_project!=='samosval-offline')throw fail('auxiliary-source-mismatch',409);
 const data=Object.fromEntries(collections.map(c=>[c,new Map()]));
 for(const collection of collections){
  const prefix=`workspaces/${ws}/${collection}/`;
  for(const row of (await client.query('SELECT document_path,payload FROM migration_documents WHERE import_sha256=$1 AND left(document_path,length($2))=$2',[state.import_sha256,prefix])).rows){
   const id=row.document_path.slice(prefix.length);if(!recordId(id))throw fail('invalid-import-record',409);data[collection].set(id,{...row.payload,id,revision:1});
  }
 }
 for(const row of (await client.query('SELECT collection,record_id,payload,revision FROM workspace_aux_records WHERE workspace_id=$1',[ws])).rows){
  data[row.collection].delete(row.record_id);if(row.payload)data[row.collection].set(row.record_id,{...row.payload,id:row.record_id,revision:Number(row.revision)});
 }
 return data;
}
export async function readAuxiliary(pool,uid,ws=WS){
 const client=await pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const actor=await serviceActor(client,uid,null,{lock:false});
  const data=await auxiliaryEntries(client,ws);
  // Derive ticker entries from authoritative committed actions, never a second client write.
  const rows=(await client.query('SELECT h.*,u.email,u.display_name FROM line_history h LEFT JOIN app_users u ON u.uid=h.uid WHERE h.workspace_id=$1 ORDER BY h.created_at DESC LIMIT 300',[ws])).rows;
  for(const h of rows){const a=h.game_actor||{},at=new Date(h.created_at).getTime(),label=({arrive:'Прибытие на линию',load:'Погрузка',ttn:'Отметка ТТН',reset:'Сброс таймера'})[h.type]||h.type;
   const entry={id:'nas_'+h.action_id,actionId:h.action_id,type:h.type,truckId:h.truck_id,shiftId:h.shift_id,timestamp:at,createdBy:a.name||h.display_name||'',createdByEmail:a.email||h.email||'',html:label+' · '+h.truck_id};
   if(!h.undone)data.notifications.set(entry.id,entry);
   data.audit.set(entry.id,{...entry,eventType:h.type,userName:entry.createdBy,userEmail:entry.createdByEmail,timeStr:new Date(at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}),text:label+' · '+h.truck_id+(h.undone?' · отменено':'')});
  }
  for(const table of ['workspace_service_audit','control_audit','identity_audit']){
   const events=(await client.query(`SELECT * FROM ${table} ${table==='identity_audit'?'':'WHERE workspace_id=$1'} ORDER BY created_at DESC LIMIT 200`,table==='identity_audit'?[]:[ws])).rows;
   for(const e of events){const at=new Date(e.created_at).getTime();data.audit.set(table+'_'+e.operation_id,{id:table+'_'+e.operation_id,timestamp:at,eventType:e.type,text:e.type,userName:e.uid,timeStr:new Date(at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}),...(table==='control_audit'?{history:{operations:[{collection:e.type.startsWith('line.')?'truckStatus':e.type.startsWith('truck.')?'trucks':'objects',id:e.after_data?.id||e.before_data?.id||'',before:e.before_data,after:e.after_data}]}}:{})});}
  }
  let plugins=[...data.plugins.values()];if(actor.role!=='admin')plugins=plugins.filter(p=>p.enabled&&!p.removed&&(!p.allowedRoles?.length||p.allowedRoles.includes(actor.role)));
  await client.query('COMMIT');const result={format:'samosval-auxiliary',version:1,source:'synology',workspaceId:ws,plugins,patches:[...data.patches.values()].filter(p=>actor.role==='admin'||p.enabled),audit:[...data.audit.values()].sort((a,b)=>(b.timestamp||0)-(a.timestamp||0)),notifications:[...data.notifications.values()].sort((a,b)=>(b.timestamp||0)-(a.timestamp||0)).slice(0,100)};return actor.role==='admin'?result:publicAuxiliary(result);
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export function normalizeAuxiliary(input){
 if(map(input)&&validId(input.id)&&input.type==='backup.import'){
  if(!Array.isArray(input.items)||!input.items.length||input.items.length>5000)throw fail('invalid-backup');
  const seen=new Set(),items=input.items.map(item=>{
   if(!map(item)||!['trucks','objects','archive'].includes(item.collection)||!validId(item.recordId)||!Number.isSafeInteger(item.expectedRevision)||item.expectedRevision<0||!safeRecord(item.data))throw fail('invalid-backup-record');
   const key=item.collection+':'+item.recordId;if(seen.has(key))throw fail('duplicate-backup-id');seen.add(key);
   const data={...item.data};delete data.id;delete data.revision;
   if(item.collection==='trucks'&&(typeof data.brand!=='string'||!data.brand||typeof data.number!=='string'||!data.number||!Number.isFinite(data.defaultVol)||data.defaultVol<0||data.defaultVol>1000))throw fail('invalid-backup-truck');
   if(item.collection==='objects'&&(typeof data.name!=='string'||!data.name))throw fail('invalid-backup-object');
   if(item.collection==='archive'&&(!Array.isArray(data.logs)||!Array.isArray(data.activeLineIds)||typeof data.objectId!=='string'||typeof data.date!=='string'))throw fail('invalid-backup-archive');
   return {collection:item.collection,recordId:item.recordId,expectedRevision:item.expectedRevision,data};
  });return {id:input.id,type:input.type,items};
 }
 if(!map(input)||!validId(input.id)||!['auxiliary.save','auxiliary.delete'].includes(input.type)||!['plugins','patches','audit'].includes(input.collection)||!recordId(input.recordId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw fail('invalid-auxiliary-operation');
 const op={id:input.id,type:input.type,collection:input.collection,recordId:input.recordId,expectedRevision:input.expectedRevision};
 if(input.type==='auxiliary.save'){
  if(!safeRecord(input.data))throw fail('invalid-auxiliary-data');
  op.data={...input.data};delete op.data.id;delete op.data.revision;
  if(input.collection==='audit'&&(!['string'].includes(typeof op.data.text)||op.data.text.length>2000||/^(game_|history|undo|redo)/.test(op.data.eventType||'')))throw fail('invalid-audit-event');
 }
 return op;
}
export function submitAuxiliary(pool,uid,input,ws=WS){
 const op=normalizeAuxiliary(input);
 if(op.type==='backup.import')return serviceCommand(pool,uid,op,ws,(c,u)=>serviceActor(c,u,'import_backup'),async client=>{
  const archive=await readArchiveEntries(client,ws),before=[];
  for(const item of op.items){
   const {collection,recordId,expectedRevision,data}=item;
   if(collection==='archive'){
    const row=archive.archives.find(r=>r.id===recordId);if((row?.revision||0)!==expectedRevision||archive.trash.some(r=>r.id===recordId))throw fail('backup-target-changed',409);
    before.push({collection,id:recordId,data:row||null});await client.query("INSERT INTO archive_overrides(workspace_id,record_id,location,payload,revision) VALUES ($1,$2,'archive',$3,$4) ON CONFLICT(workspace_id,record_id) DO UPDATE SET location='archive',payload=EXCLUDED.payload,revision=EXCLUDED.revision",[ws,recordId,data,expectedRevision+1]);
   }else{
    const table=collection==='trucks'?'line_trucks':'workspace_objects',key=collection==='trucks'?'truck_id':'object_id';
    const row=(await client.query(`SELECT payload,revision FROM ${table} WHERE workspace_id=$1 AND ${key}=$2 FOR UPDATE`,[ws,recordId])).rows[0];
    if(Number(row?.revision||0)!==expectedRevision)throw fail('backup-target-changed',409);before.push({collection,id:recordId,data:row?.payload||null});
    await client.query(`INSERT INTO ${table}(workspace_id,${key},payload,revision) VALUES ($1,$2,$3,$4) ON CONFLICT(workspace_id,${key}) DO UPDATE SET payload=EXCLUDED.payload,revision=EXCLUDED.revision`,[ws,recordId,{...row?.payload,...data},expectedRevision+1]);
   }
  }
  return {before,after:op.items,result:{written:op.items.length}};
 });
 return serviceCommand(pool,uid,op,ws,(c,u)=>serviceActor(c,u,null,{admin:op.collection!=='audit'}),async(client,actor)=>{
  if(op.collection==='audit'&&(op.expectedRevision!==0||op.type!=='auxiliary.save'))throw fail('audit-append-only',403);
  const data=await auxiliaryEntries(client,ws),before=data[op.collection].get(op.recordId);
  const tomb=(await client.query('SELECT revision FROM workspace_aux_records WHERE workspace_id=$1 AND collection=$2 AND record_id=$3',[ws,op.collection,op.recordId])).rows[0];
  const previous=before?.revision||Number(tomb?.revision||0);if(previous!==op.expectedRevision)throw fail('auxiliary-changed',409);
  const revision=previous+1,after=op.type==='auxiliary.delete'?null:{...op.data,...(op.collection==='audit'?{userName:actor.display_name,userEmail:actor.email,createdByEmail:actor.email,timestamp:Date.now(),timeStr:new Date().toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})}:{})};
  await client.query('INSERT INTO workspace_aux_records(workspace_id,collection,record_id,payload,revision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,collection,record_id) DO UPDATE SET payload=EXCLUDED.payload,revision=EXCLUDED.revision',[ws,op.collection,op.recordId,after,revision]);
  return {before:before||null,after,result:{id:op.recordId,revision,data:after}};
 });
}
