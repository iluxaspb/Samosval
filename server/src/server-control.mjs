import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {serviceActor,validId} from './service-command.mjs';
import {fail,map} from './tabel-access.mjs';
export const CONTROL_VERSION='4.1.0';
export const CONTROL_PROTOCOL=1;
const started=Date.now(),metrics={requests:0,errors:0,durations:[],recentErrors:[]};
// Fixed metadata only: never request bodies, query strings, headers or exception text.
export function observeServerRequest(req,res){
 const at=performance.now();res.once('finish',()=>{
  if(!String(req.url).startsWith('/api/'))return;
  metrics.requests++;metrics.durations.push(Math.round(performance.now()-at));if(metrics.durations.length>500)metrics.durations.shift();
  if(res.statusCode>=500){metrics.errors++;metrics.recentErrors.unshift({at:Date.now(),method:req.method,path:String(req.url).split('?')[0].slice(0,120),status:res.statusCode});metrics.recentErrors.length=Math.min(metrics.recentErrors.length,30);}
 });
}
export function apiMetrics(){const values=metrics.durations.slice().sort((a,b)=>a-b);return {startedAt:started,uptimeSeconds:Math.floor((Date.now()-started)/1000),requests:metrics.requests,errors:metrics.errors,p95Ms:values.length?values[Math.min(values.length-1,Math.floor(values.length*.95))]:null,memoryBytes:process.memoryUsage().rss,recentErrors:metrics.recentErrors.slice(),version:process.env.SAMOSVAL_RELEASE||CONTROL_VERSION};}
export function normalizeServerCommand(input){
 if(!map(input)||!validId(input.id)||!['check','backup','update','restart','rollback'].includes(input.type)||input.channel!=='test')throw fail('invalid-server-command');
 const op={id:input.id,type:input.type,channel:'test'};
 if(['update','rollback'].includes(op.type)){
  if(typeof input.expectedImage!=='string'||!/^sha256:[a-f0-9]{64}$/.test(input.expectedImage))throw fail('invalid-server-image');
  op.expectedImage=input.expectedImage;
 }
 if(op.type==='update'){if(typeof input.releaseId!=='string'||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.releaseId))throw fail('invalid-release-id');op.releaseId=input.releaseId;}
 return op;
}
export function controlFresh(state,now=Date.now()){const stamp=Date.parse(state?.heartbeat);return Number.isFinite(stamp)&&now-stamp>=-5000&&now-stamp<60000&&state.payload?.protocol===CONTROL_PROTOCOL;}
export async function readServerControl(pool,uid,ws=process.env.WORKSPACE_ID||'main_workspace'){
 const c=await pool.connect();try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await serviceActor(c,uid,null,{admin:true,lock:false});
  const state=(await c.query("SELECT heartbeat,payload FROM server_control_state WHERE channel='test'")).rows[0];
  const jobs=(await c.query("SELECT job_id AS id,type,status,stage,detail,created_at,updated_at FROM server_control_jobs WHERE channel='test' ORDER BY created_at DESC LIMIT 20")).rows;
  const events=(await c.query('SELECT event_id AS id,job_id,stage,created_at FROM server_control_events ORDER BY event_id DESC LIMIT 80')).rows;
  const objects=(await c.query("SELECT o.object_id AS id,o.payload->>'name' AS name,(SELECT count(*)::int FROM shifts s WHERE s.workspace_id=o.workspace_id AND s.payload->>'objectId'=o.object_id AND s.is_active) AS active_shifts FROM workspace_objects o WHERE o.workspace_id=$1 AND COALESCE(o.payload->>'deleted','false')<>'true' ORDER BY o.payload->>'name' LIMIT 200",[ws])).rows;
  const users=(await c.query("SELECT count(*)::int AS registered,count(*) FILTER(WHERE status='active' AND NOT COALESCE((profile->>'deleted')::boolean,false))::int AS active,count(*) FILTER(WHERE status='pending')::int AS pending FROM app_users")).rows[0];
  const database=(await c.query('SELECT pg_database_size(current_database())::text AS bytes,current_database() AS name')).rows[0];
  const backups=(await c.query("SELECT meta FROM workspace_backups WHERE workspace_id=$1 AND NOT deleted ORDER BY (meta->>'createdAt')::bigint DESC LIMIT 10",[ws])).rows.map(r=>r.meta);
  await c.query('COMMIT');return {format:'samosval-server-control',version:1,source:'synology',workspaceId:ws,channel:'test',readAt:Date.now(),api:apiMetrics(),database:{status:'connected',...database},agent:{available:controlFresh(state),heartbeat:state?.heartbeat||null,...(state?.payload||{})},jobs,events,objects,users,backups};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
export async function submitServerCommand(pool,uid,input){
 const op=normalizeServerCommand(input),hash=createHash('sha256').update(JSON.stringify(op)).digest('hex'),c=await pool.connect();
 try{await c.query('BEGIN');await serviceActor(c,uid,null,{admin:true});
  await c.query("SELECT pg_advisory_xact_lock(hashtext('samosval-test-server-commands'))");
  const old=(await c.query('SELECT uid,request_hash,status FROM server_control_jobs WHERE job_id=$1',[op.id])).rows[0];
  if(old){if(old.uid!==uid||old.request_hash!==hash)throw fail('operation-id-reused',409);await c.query('COMMIT');return {outcome:'confirmed',operationId:op.id,replayed:true,status:old.status};}
  const state=(await c.query("SELECT heartbeat,payload FROM server_control_state WHERE channel='test'")).rows[0];
  if(!controlFresh(state))throw fail('server-agent-unavailable',409);
  if(['update','rollback'].includes(op.type)&&op.expectedImage!==state.payload.imageId)throw fail('server-image-changed',409);
  if(op.type==='update'&&(state.payload.release?.version!==op.releaseId||state.payload.release?.verified!==true))throw fail('release-not-verified',409);
  if(op.type==='rollback'&&!state.payload.rollbackAvailable)throw fail('rollback-unavailable',409);
  if((await c.query("SELECT 1 FROM server_control_jobs WHERE channel='test' AND status IN ('queued','running')")).rowCount)throw fail('server-busy',409);
  await c.query('INSERT INTO server_control_jobs(job_id,channel,uid,type,request_hash,request) VALUES ($1,$2,$3,$4,$5,$6)',[op.id,'test',uid,op.type,hash,op]);
  await c.query("INSERT INTO server_control_events(job_id,stage) VALUES ($1,'queued')",[op.id]);
  await c.query('COMMIT');return {outcome:'confirmed',operationId:op.id,status:'queued'};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
