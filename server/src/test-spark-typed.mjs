// TEST-only typed Firestore LINE projection. Server constructs this from the
// PostgreSQL snapshot; clients can only mutate the separately rules-fenced
// operation fields while Firebase is the verified owner. Never exposed as the
// authoritative dataset until an outbox high-water and repair are verified.
const WS='main_workspace',PROJECT='samosval-offline';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const num=x=>Number.isSafeInteger(x)&&x>=0;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const checkGeneration=g=>typeof g==='string'&&/^[0-9a-f]{24}$/.test(g);
const fail=x=>{throw Error('spark-typed-'+x);};
function rowData(item){
 try {
  const row=JSON.parse(item?.envelope?.rowJson);
  if(!plain(row))fail('row-not-object');
  return row;
 } catch {fail('row-invalid');}
}
function timestamp(value,fromMillis){
 if(value===null||value===undefined||value===0)return null;
 if(!num(value)||!value)fail('invalid-timestamp');
 return fromMillis(value);
}
const cleanText=(x,max=256)=>{
 if(x==null)return '';
 if(typeof x!=='string'||x.length>max)fail('invalid-text');
 return x;
};
export function sparkTypedPaths(generation){
 if(!checkGeneration(generation))fail('generation-invalid');
 const prefix='samosval_test_replica/v1/';
 return Object.freeze({
  config:prefix+'typed_config_'+generation+'/active',
  status:id=>{if(!id||!id.length||!/^[\w-]{1,128}$/.test(id))fail('truck-id-invalid');return prefix+'typed_status_'+generation+'/'+id;},
  truck:id=>{if(!id||!id.length||!/^[\w-]{1,128}$/.test(id))fail('truck-id-invalid');return prefix+'typed_trucks_'+generation+'/'+id;},
  operation:id=>{if(!id||!id.length||!/^[\w-]{1,128}$/.test(id))fail('operation-id-invalid');return prefix+'typed_ops_'+generation+'/'+id;},
  log:id=>{if(!id||!id.length||!/^[\w-]{1,128}$/.test(id))fail('log-id-invalid');return prefix+'typed_logs_'+generation+'/'+id;}
 });
}
export function buildSparkTypedLineSnapshot({snapshot,generation,fromMillis}={}){
 if(!snapshot||!Array.isArray(snapshot.rows)||!num(snapshot.sequence)||
    !checkGeneration(generation)||typeof fromMillis!=='function')fail('snapshot-invalid');
 const rows=table=>snapshot.rows.filter(x=>x.table===table).map(rowData);
 const [shifts,workspaces,trucks,statuses]=
  ['shifts','workspaces','line_trucks','line_truck_statuses'].map(rows);
 const workspace=workspaces.find(x=>x.id===WS);
 if(!workspace||!Number.isSafeInteger(workspace.cycle_minutes)||
     workspace.cycle_minutes<15||workspace.cycle_minutes>10080)fail('workspace-invalid');
 const active=shifts.filter(x=>x.workspace_id===WS&&(x.is_active||x.payload?.closing));
 if(active.length>1)fail('multiple-shifts');
 const selected=active[0]||null;
 const typedConfig={
  protocol:1,projectId:PROJECT,generation,workspaceId:WS,
  sourceSequence:snapshot.sequence,active:selected?.is_active===true&&
   selected.payload?.closing!==true,
  shiftId:selected?.shift_id||'',cycleMinutes:workspace.cycle_minutes
 };
 const typedTrucks=new Map();
 for(const x of trucks.filter(x=>x.workspace_id===WS)){
  if(!id(x.truck_id)||typedTrucks.has(x.truck_id))fail('truck-invalid');
  if(x.payload?.deleted===true)continue;
  const data=x.payload||{};
  const volume=Number(data.defaultVol||0);
  if(!Number.isFinite(volume)||volume<0||volume>1000)fail('truck-volume-invalid');
  typedTrucks.set(x.truck_id,{
   protocol:1,projectId:PROJECT,generation,workspaceId:WS,
   sourceSequence:snapshot.sequence,id:x.truck_id,
   brand:cleanText(data.brand),number:cleanText(data.number),
   volume: data.isGAI?0:volume,isGAI:data.isGAI===true
  });
 }
 const typedStatuses=new Map();
 for(const x of statuses.filter(x=>x.workspace_id===WS)){
  const data=x.payload||{};
  if(!id(x.truck_id)||typedStatuses.has(x.truck_id)||!id(x.shift_id)||
     !num(data.cycleRevision??0)||!num(data.ttnRevision??0))fail('status-invalid');
  typedStatuses.set(x.truck_id,{
   protocol:1,projectId:PROJECT,generation,workspaceId:WS,
   sourceSequence:snapshot.sequence,id:x.truck_id,shiftId:x.shift_id,
   onLine:data.onLine===true,cycleRevision:data.cycleRevision||0,
   ttnRevision:data.ttnRevision||0,
   arrivedAt:timestamp(data.arriveTimestamp,fromMillis),
   lastLoadAt:timestamp(data.lastLoadTimestamp,fromMillis),
   lastLogId:cleanText(data.lastLoadLogId||'',160),
   lastOperationId:'',lastActionType:'',
   lastActorUid:'',loadedAfterArrive:data.loadedAfterArrive===true,
   // A bounded append-only journal lives in the SAME Firestore status doc.
   // A single transactional write cannot suffer a partial receipt/log commit.
   reserveHistory:{}
  });
 }
 return Object.freeze({config:typedConfig,trucks:typedTrucks,statuses:typedStatuses});
}

export const SPARK_TYPED_TABLES=new Set([
 'workspaces','shifts','line_trucks','line_truck_statuses'
]);
export function needsSparkTypedRefresh(events){
 return Array.isArray(events)&&events.some(event=>SPARK_TYPED_TABLES.has(event.table_name));
}
export function sparkTypedChangesFromEvents({events,snapshot,generation,fromMillis}={}){
 if(!Array.isArray(events)||!snapshot)fail('changes-invalid');
 if(!needsSparkTypedRefresh(events))return [];
 const typed=buildSparkTypedLineSnapshot({snapshot,generation,fromMillis});
 const paths=sparkTypedPaths(generation),updates=new Map();
 for(const event of events){
  if(!SPARK_TYPED_TABLES.has(event.table_name))continue;
  if(event.table_name==='shifts'||event.table_name==='workspaces'){
   updates.set(paths.config,typed.config);
   continue;
  }
  const tid=event.row_key?.truck_id;
  if(!id(tid)||event.row_key.workspace_id!==WS)fail('change-key-invalid');
  if(event.table_name==='line_trucks')
   updates.set(paths.truck(tid),typed.trucks.get(tid)||null);
  else if(event.table_name==='line_truck_statuses')
   updates.set(paths.status(tid),typed.statuses.get(tid)||null);
 }
 return [...updates.entries()].map(([path,value])=>({path,value}));
}
