// TEST reserve API; completely independent of NAS and PostgreSQL.
// Only server credentials can read/write the private replica namespace.
import {reserveLineOperation} from './test-reserve-line.mjs';
import {REPLICA_DOC,canonical,assertTestProject} from './test-replica.mjs';
import {OWNER_DOC} from './test-writer-coordinator.mjs';
import {profileView,roleView} from './identity-rules.mjs';

const WS='main_workspace',ORIGIN='https://iluxaspb.github.io';
const fail=(code,status=503)=>Object.assign(new Error(code),{code,status});
const json=(res,status,value)=>{
 res.statusCode=status;
 res.setHeader('Content-Type','application/json; charset=utf-8');
 res.setHeader('Cache-Control','no-store');
 res.end(JSON.stringify(value));
};
const parse=doc=>{
 const d=doc.data();
 if(!d||typeof d.rowJson!=='string'||typeof d.keyJson!=='string')
  throw fail('reserve-invalid-document');
 try{return {...d,row:JSON.parse(d.rowJson),key:JSON.parse(d.keyJson)};}
 catch{throw fail('reserve-invalid-document');}
};
async function context(db){
 const [m,o]=await Promise.all([db.doc(REPLICA_DOC).get(),db.doc(OWNER_DOC).get()]);
 const meta=m.exists?m.data():null,owner=o.exists?o.data():null;
 if(meta?.protocol!==1||meta.projectId!=='samosval-offline'||
  meta.readyForFailover!==true||owner?.owner!=='firebase'||
  owner.projectId!=='samosval-offline'||owner.holder!=='firebase_reserve'||
  owner.observedSequence!==meta.lastSequence||meta.generation!==owner.generation||
  !Number.isSafeInteger(owner.epoch))
  throw fail('reserve-not-active');
 return {meta,owner};
}
async function table(db,generation,name){
 const docs=(await db.collection(REPLICA_DOC+'/rows_'+generation)
  .where('table','==',name).get()).docs;
 if(docs.length>3000)throw fail('reserve-too-many-rows');
 return docs.map(parse).filter(row=>row.table===name);
}
async function consistent(db,fn){
 for(let attempt=0;attempt<3;attempt++){
  const a=await context(db),value=await fn(a);
  const b=await context(db);
  if(a.meta.generation===b.meta.generation&&a.meta.lastSequence===b.meta.lastSequence&&
    a.owner.epoch===b.owner.epoch&&a.owner.reserveSequence===b.owner.reserveSequence)
   return value;
 }
 throw fail('reserve-snapshot-changed');
}
export async function readReserveSession(db,uid){
 if(typeof uid!=='string'||!uid)throw fail('unauthorized',401);
 return consistent(db,async({meta})=>{
  const [users,perms,identity]=await Promise.all(['app_users','role_permissions','identity_state']
   .map(name=>table(db,meta.generation,name)));
  const profile=users.find(x=>x.row.uid===uid)?.row||null;
  const active=profile?.status==='active'&&!profile.profile?.deleted;
  const rows=perms.filter(x=>x.row.role===profile?.role).map(x=>x.row);
  return {format:'samosval-session',version:1,source:'firebase',workspaceId:WS,
   identityReady:identity.some(x=>x.row.id===1&&x.row.initialized===true),
   profile:profileView(profile),
   permissions:active?roleView(profile.role,rows):{tabs:[],actions:[]}};
 });
}
export async function readReserveLine(db,uid){
 const session=await readReserveSession(db,uid);
 if(session.profile?.status!=='active'||session.profile.deleted||
   !session.permissions.tabs.includes('line'))throw fail('forbidden',403);
 return consistent(db,async({meta})=>{
  const [trucks,shifts,statuses,logs,workspaces]=await Promise.all(
   ['line_trucks','shifts','line_truck_statuses','line_logs','workspaces']
    .map(name=>table(db,meta.generation,name)));
  const active=shifts.filter(x=>x.row.workspace_id===WS&&
    (x.row.is_active||x.row.payload?.closing));
  if(active.length>1)throw fail('multiple-active-shifts',409);
  const selected=active[0]?.row||null;
  const result={format:'samosval-line-snapshot',version:1,source:'firebase',
   workspaceId:WS,shift:selected?{...selected.payload,id:selected.shift_id,isActive:selected.is_active}:null,
   trucks:trucks.filter(x=>x.row.workspace_id===WS&&x.row.payload?.deleted!==true)
    .map(x=>({...x.row.payload,id:x.row.truck_id})),
   statuses:selected?statuses.filter(x=>x.row.workspace_id===WS&&x.row.shift_id===selected.shift_id)
    .map(x=>({...x.row.payload,id:x.row.truck_id,shiftId:selected.shift_id})):[],
   logs:selected?logs.filter(x=>x.row.workspace_id===WS&&x.row.shift_id===selected.shift_id)
    .map(x=>({...x.row.payload,id:x.row.log_id,truckId:x.row.truck_id,shiftId:selected.shift_id})):[],
   cycleMinutes:workspaces.find(x=>x.row.id===WS)?.row?.cycle_minutes};
  if(!Number.isInteger(result.cycleMinutes))throw fail('reserve-workspace-invalid');
  return result;
 });
}
async function body(req){
 let bytes=0,chunks=[];
 for await(const chunk of req){
  bytes+=chunk.length;if(bytes>32768)throw fail('body-too-large',413);
  chunks.push(chunk);
 }
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 catch{throw fail('invalid-json',400);}
}
export function createReserveHttp({firestore,projectId,verifyToken,enabled=false,clock=Date.now}={}){
 assertTestProject(projectId);
 if(!firestore||typeof verifyToken!=='function')throw TypeError('reserve-invalid-config');
 return async(req,res)=>{
  if(req.headers.origin&&req.headers.origin!==ORIGIN)
   return json(res,403,{error:'origin-not-allowed'});
  if(req.headers.origin){
   res.setHeader('Access-Control-Allow-Origin',ORIGIN);
   res.setHeader('Vary','Origin');
   res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
   res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Samosval-Writer-Epoch');
  }
  if(req.method==='OPTIONS')return json(res,204,{});
  const path=new URL(req.url||'/', 'http://localhost').pathname;
  if(req.method==='GET'&&path==='/health/live')
   return json(res,200,{status:'ok',source:'firebase',projectId:'samosval-offline',
    mode:enabled?'line-test-only':'disabled'});
  if(!enabled)return json(res,503,{error:'reserve-service-disabled'});
  const match=/^Bearer ([A-Za-z0-9._-]+)$/.exec(String(req.headers.authorization||''));
  if(!match)return json(res,401,{error:'unauthorized'});
  let identity;
  try{identity=await verifyToken(match[1]);}
  catch{return json(res,401,{error:'unauthorized'});}
  const uid=identity?.uid;
  if(typeof uid!=='string'||!uid)return json(res,401,{error:'unauthorized'});
  try{
   if(req.method==='GET'&&path==='/api/v1/owner/status'){
    // Read the independent authority even when the reserve is not promoted.
    // A browser never chooses the owner from NAS request timeouts alone.
    const [ms,os]=await Promise.all([
     firestore.doc(REPLICA_DOC).get(),firestore.doc(OWNER_DOC).get()]);
    const m=ms.exists?ms.data():null,o=os.exists?os.data():null;
    if(m?.protocol!==1||m.projectId!=='samosval-offline'||o?.protocol!==1||
       o.projectId!=='samosval-offline'||
       !['synology','firebase','reconciling','handoff'].includes(o.owner)||
       m.generation!==o.generation||!Number.isSafeInteger(o.epoch)||o.epoch<1||
       !Number.isSafeInteger(m.lastSequence)||m.lastSequence<0||
       !Number.isSafeInteger(o.observedSequence)||o.observedSequence<0)
     throw fail('reserve-owner-unverified');
    return json(res,200,{format:'samosval-owner-status',version:1,
     projectId:'samosval-offline',owner:o.owner,epoch:o.epoch,
     readyForFailover:o.owner==='firebase'&&o.holder==='firebase_reserve'&&
       o.observedSequence===m.lastSequence&&m.readyForFailover===true,
     confirmedSequence:m.lastSequence,reserveSequence:o.reserveSequence||0,
     generation:m.generation,checkedAt:clock()});
   }
   if(req.method==='GET'&&path==='/api/v1/reserve/status'){
    const {owner}=await context(firestore);
    return json(res,200,{source:'firebase',ready:true,epoch:owner.epoch,
     reserveSequence:owner.reserveSequence||0});
   }
   if(req.method==='GET'&&path==='/api/v1/session')
    return json(res,200,await readReserveSession(firestore,uid));
   if(req.method==='GET'&&path==='/api/v1/line/snapshot')
    return json(res,200,await readReserveLine(firestore,uid));
   if(req.method==='POST'&&path==='/api/v1/line/operations'){
    if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))
     throw fail('unsupported-media-type',415);
    const epoch=Number(req.headers['x-samosval-writer-epoch']);
    if(!Number.isSafeInteger(epoch)||epoch<1)throw fail('reserve-epoch-required',409);
    return json(res,200,await reserveLineOperation({firestore,projectId,uid,
     input:await body(req),expectedEpoch:epoch,now:clock()}));
   }
   return json(res,404,{error:'not-found'});
  }catch(e){
   const code=String(e?.code||e?.message||'');
   const safe=/^(reserve-|invalid-|forbidden|operation-|body-too-large|unsupported-media-type)/.test(code);
   const status=[400,401,403,409,413,415,503].includes(e?.status)?e.status:503;
   return json(res,status,{error:safe?code:'reserve-unavailable'});
  }
 };
}
