// Direct read-only LINE from PostgreSQL mirror using Firebase Web SDK.
// No Cloud Run, no nas-to-phone proxy. This is an isolated diagnostic adapter:
// until Security Rules and transactional browser writes are verified, it MUST
// NOT be activated as an automatic failover data source.
import {createSparkOwnerReader,SparkOwnerError} from './spark-owner.mjs';

const WS='main_workspace';
const TYPE=['line_trucks','shifts','line_truck_statuses','line_logs','workspaces'];
const generation=x=>typeof x==='string'&&/^[0-9a-f]{24}$/.test(x);
const uidOk=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const err=code=>new SparkOwnerError(code);
const canonical=x=>{
 if(x===null||typeof x!=='object')return JSON.stringify(x);
 if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
 return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
};
async function hash(value,cryptoImpl){
 if(!cryptoImpl?.subtle?.digest)throw err('spark-crypto-unavailable');
 const input=new TextEncoder().encode(value);
 const bytes=new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',input));
 return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const ownerKey=s=>[s.owner,s.epoch,s.generation,s.confirmedSequence,s.reserveSequence].join(':');
export function createSparkLineReader({firestore,getUser,ownerReader,
 cryptoImpl=globalThis.crypto,maxRowsPerTable=300}={}){
 if(!firestore||typeof firestore.doc!=='function'||typeof firestore.collection!=='function'||
    typeof getUser!=='function'||!Number.isSafeInteger(maxRowsPerTable)||
    maxRowsPerTable<1||maxRowsPerTable>300)throw new TypeError('spark-line-options-invalid');
 if(firestore.app?.options?.projectId!=='samosval-offline')
  throw new TypeError('spark-test-project-required');
 const initialUser=getUser(),uid=initialUser?.uid;
 if(!uidOk(uid))throw err('spark-auth-required');
 const authority=ownerReader||createSparkOwnerReader({firestore,getUser});
 let stopped=false;
 function guard(){
  if(stopped||getUser()!==initialUser||initialUser.uid!==uid)
   throw err('spark-session-changed');
 }
 async function confirmed(){
  guard();
  const current=await authority.readOwner();
  guard();
  if(current.owner!=='firebase'||current.readyForFailover!==true||
    !generation(current.generation))throw err('spark-line-not-active');
  return current;
 }
 async function access(state){
  guard();
  let snap;
  try{
   snap=await firestore.doc('samosval_test_replica/v1/access_'+state.generation+'/'+uid)
    .get({source:'server'});
  }catch{throw err('spark-access-unavailable');}
  guard();
  const a=snap.exists?snap.data():null;
  if(!a||a.protocol!==1||a.projectId!=='samosval-offline'||
    a.source!=='nas-spark-mirror'||a.workspaceId!==WS||
    a.generation!==state.generation||a.uid!==uid||
    !Number.isSafeInteger(a.sourceSequence)||a.sourceSequence<0||
    a.sourceSequence>state.confirmedSequence||!record(a.profile)||
    a.profile.uid!==uid||!record(a.permissions)||
    !Array.isArray(a.permissions.tabs)||!Array.isArray(a.permissions.actions))
   throw err('spark-access-invalid');
  if(!a.active||!a.lineRead||a.profile.deleted||a.profile.status!=='active'||
    !a.permissions.tabs.includes('line'))throw err('spark-line-forbidden');
  return a;
 }
 async function table(state,kind){
  guard();
  if(!TYPE.includes(kind))throw err('spark-line-unsupported-table');
  const path='samosval_test_replica/v1/rows_'+state.generation;
  let response;
  try{
   response=await firestore.collection(path).where('table','==',kind)
    .limit(maxRowsPerTable+1).get({source:'server'});
  }catch{throw err('spark-line-read-unavailable');}
  guard();
  const docs=response.docs||[];
  if(docs.length>maxRowsPerTable)throw err('spark-line-table-too-large');
  const rows=[];
  for(const doc of docs){
   const d=doc.data();
   if(d?.table!==kind||typeof d?.keyJson!=='string'||
    typeof d?.rowJson!=='string'||!Number.isSafeInteger(d.appliedSequence)||
    d.appliedSequence>state.confirmedSequence)
    throw err('spark-line-row-invalid');
   let key,row;
   try{key=JSON.parse(d.keyJson);row=JSON.parse(d.rowJson);}
   catch{throw err('spark-line-row-invalid');}
   if(!record(key)||!record(row)||d.keyJson!==canonical(key)||
    d.rowJson!==canonical(row))
    throw err('spark-line-row-invalid');
   const name=kind+'_'+await hash(kind+'\n'+canonical(key),cryptoImpl);
   guard();
   if(doc.id!==name)throw err('spark-line-row-id-invalid');
   rows.push({key,row});
  }
  return rows;
 }
 async function readLine(){
  const before=await confirmed();
  const a=await access(before);
  const [trucks,shifts,statuses,logs,workspaces]=await Promise.all(
   TYPE.map(t=>table(before,t))
  );
  const after=await confirmed();
  guard();
  if(ownerKey(before)!==ownerKey(after))throw err('spark-owner-changed-during-read');
  const active=shifts.filter(x=>x.row.workspace_id===WS&&
   (x.row.is_active||x.row.payload?.closing));
  if(active.length>1)throw err('spark-multiple-active-shifts');
  const selected=active[0]?.row||null,shiftId=selected?.shift_id;
  const ids=rows=>rows.every(x=>typeof x.id==='string'&&x.id)&&
   new Set(rows.map(x=>x.id)).size===rows.length;
  const result={format:'samosval-line-snapshot',version:1,
   source:'firebase',workspaceId:WS,
   shift:selected?{...(selected.payload||{}),id:shiftId,isActive:selected.is_active}:null,
   trucks:trucks.filter(x=>x.row.workspace_id===WS&&x.row.payload?.deleted!==true)
    .map(x=>({...x.row.payload,id:x.row.truck_id})),
   statuses:selected?statuses.filter(x=>x.row.workspace_id===WS&&x.row.shift_id===shiftId)
    .map(x=>({...x.row.payload,id:x.row.truck_id,shiftId})):[],
   logs:selected?logs.filter(x=>x.row.workspace_id===WS&&x.row.shift_id===shiftId)
    .map(x=>({...x.row.payload,id:x.row.log_id,truckId:x.row.truck_id,shiftId})):[],
   cycleMinutes:workspaces.find(x=>x.row.id===WS)?.row.cycle_minutes};
  if(!Number.isSafeInteger(result.cycleMinutes)||result.cycleMinutes<15||
   !ids(result.trucks)||!ids(result.statuses)||!ids(result.logs))
   throw err('spark-line-snapshot-invalid');
  // This adapter is read-only; the caller cannot reuse the snapshot as proof
  // of write ownership. All future writes must be Rules-fenced atomically.
  return Object.freeze(result);
 }
 async function readSession(){
  const before=await confirmed(),a=await access(before);
  const after=await confirmed();
  guard();
  if(ownerKey(before)!==ownerKey(after))throw err('spark-owner-changed-during-read');
  return {format:'samosval-session',version:1,source:'firebase',workspaceId:WS,
   identityReady:true,profile:a.profile,permissions:a.permissions};
 }
 return Object.freeze({uid,readSession,readLine,
  stop:()=>{stopped=true;if(!ownerReader)authority.stop();}});
}
