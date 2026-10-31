// Server-owned, UID-scoped Firestore access projection for Spark read-only
// reserve. No browser can derive roles from arbitrary mirrored SQL rowJson.
// All projection records are written only by NAS Admin SDK.
import {profileView,roleView,ROLES} from './identity-rules.mjs';

const uidOk=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const generationOk=x=>typeof x==='string'&&/^[0-9a-f]{24}$/.test(x);
const sequenceOk=x=>Number.isSafeInteger(x)&&x>=0;
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export const SPARK_MAX_ACCESS_USERS=160;
export const ACCESS_PROTOCOL=1;
export const ACCESS_TABLES=new Set(['app_users','role_permissions','role_permission_versions','identity_state']);
export function sparkAccessRef(db,generation,uid){
 if(!generationOk(generation)||!uidOk(uid))throw Error('spark-access-invalid-path');
 return db.doc('samosval_test_replica/v1/access_'+generation+'/'+uid);
}
export function buildSparkAccessProjection({users,permissions,generation,sourceSequence}){
 if(!Array.isArray(users)||!Array.isArray(permissions)||!generationOk(generation)||
    !sequenceOk(sourceSequence))throw Error('spark-access-invalid-input');
 if(users.length>SPARK_MAX_ACCESS_USERS)throw Error('spark-access-too-many-users');
 const byRole=new Map(),seen=new Set();
 for(const row of permissions){
  if(!obj(row)||!ROLES.includes(row.role)||typeof row.action!=='string'||
     typeof row.allowed!=='boolean')throw Error('spark-access-invalid-role-permission');
  if(!byRole.has(row.role))byRole.set(row.role,[]);
  byRole.get(row.role).push(row);
 }
 return users.map(row=>{
  if(!obj(row)||!uidOk(row.uid)||seen.has(row.uid)||
     !ROLES.includes(row.role)||!['active','pending','disabled'].includes(row.status))
    throw Error('spark-access-invalid-user');
  seen.add(row.uid);
  const profile=profileView(row),active=profile.status==='active'&&!profile.deleted;
  const perms=active?roleView(profile.role,byRole.get(profile.role)||[]):{tabs:[],actions:[]};
  return Object.freeze({
   protocol:ACCESS_PROTOCOL,projectId:'samosval-offline',workspaceId:'main_workspace',
   source:'nas-spark-mirror',generation,uid:row.uid,
   sourceSequence,
   active,lineRead:active&&perms.tabs.includes('line'),
   profile,permissions:perms
  });
 }).sort((a,b)=>a.uid.localeCompare(b.uid,'en'));
}
export function accessRowsFromMirrorSnapshot(snapshot,generation){
 if(!snapshot||!Array.isArray(snapshot.rows)||!sequenceOk(snapshot.sequence))
   throw Error('spark-access-invalid-snapshot');
 const parse=table=>snapshot.rows.filter(x=>x.table===table).map(x=>{
  if(typeof x.envelope?.rowJson!=='string')throw Error('spark-access-row-invalid');
  let row;try{row=JSON.parse(x.envelope.rowJson);}catch{throw Error('spark-access-row-invalid');}
  if(!obj(row))throw Error('spark-access-row-invalid');
  return row;
 });
 return buildSparkAccessProjection({users:parse('app_users'),
  permissions:parse('role_permissions'),generation,sourceSequence:snapshot.sequence});
}
export function needsSparkAccessRefresh(events){
 return Array.isArray(events)&&events.some(x=>ACCESS_TABLES.has(x.table_name));
}
export function affectedSparkAccessUids(events,projection){
 if(!Array.isArray(events)||!Array.isArray(projection))throw Error('spark-access-invalid-events');
 const direct=new Set(),roles=new Set();
 let all=false;
 for(const event of events){
  if(!ACCESS_TABLES.has(event.table_name))continue;
  const key=event.row_key||{};
  if(event.table_name==='app_users'){
   if(!uidOk(key.uid))throw Error('spark-access-invalid-user-key');
   direct.add(key.uid);
  }else if(event.table_name==='identity_state')all=true;
  else{
   if(!ROLES.includes(key.role))throw Error('spark-access-invalid-role-key');
   roles.add(key.role);
  }
 }
 for(const row of projection){
  if(!uidOk(row.uid))throw Error('spark-access-invalid-projection');
  if(all||roles.has(row.profile.role))direct.add(row.uid);
 }
 if(direct.size>SPARK_MAX_ACCESS_USERS)throw Error('spark-access-too-many-users');
 return [...direct].sort((a,b)=>a.localeCompare(b,'en'));
}
// Transaction-consistent source projection: if this source head is ahead of
// a partial outbox delivery, clients MUST refuse its ACL until the mirrored
// metadata catches up. The server stages this sourceSequence atomically with
// its Firestore mirror transaction; no client can write these docs.
export async function collectSparkAccessFromPostgres(pool,generation){
 if(!pool||typeof pool.connect!=='function')throw TypeError('spark-access-pool-required');
 const c=await pool.connect();
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const seq=(await c.query(
    'SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true'
  )).rows?.[0]?.n;
  const sourceSequence=Number(seq);
  if(!sequenceOk(sourceSequence))throw Error('spark-access-invalid-source-sequence');
  const [u,p]=await Promise.all([
   c.query('SELECT to_jsonb(t) AS value FROM app_users t ORDER BY uid'),
   c.query('SELECT to_jsonb(t) AS value FROM role_permissions t ORDER BY role,action')
  ]);
  const projection=buildSparkAccessProjection({users:u.rows.map(x=>x.value),
   permissions:p.rows.map(x=>x.value),generation,sourceSequence});
  await c.query('COMMIT');
  return {sourceSequence,projection};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}
