import {isDeepStrictEqual} from 'node:util';
import {fail,map} from './tabel-access.mjs';
import {serviceActor,serviceCommand,validId} from './service-command.mjs';
const WS=process.env.WORKSPACE_ID||'main_workspace';
export const reportVersion=x=>x?{volume:x.volume,timestamp:x.timestamp,timeStr:x.timeStr,comment:x.comment||'',truckId:x.truckId,shiftId:x.shiftId}:null;
export function normalizeReport(input){
 if(!map(input)||!validId(input.id)||!['report.update','report.delete'].includes(input.type)||!validId(input.logId)||!map(input.expected))throw fail('invalid-report-operation');
 const op={id:input.id,type:input.type,logId:input.logId,expected:reportVersion(input.expected)};
 if(input.type==='report.update'){
  const d=input.data;if(!map(d)||!Number.isFinite(d.volume)||d.volume<0||d.volume>1000||typeof d.timeStr!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.timeStr)||typeof d.comment!=='string'||d.comment.length>2000)throw fail('invalid-report-data');
  op.data={volume:d.volume,timeStr:d.timeStr,comment:d.comment};
 }return op;
}
const currentLog=async(c,ws,id)=>(await c.query('SELECT payload FROM line_logs WHERE workspace_id=$1 AND log_id=$2 FOR UPDATE',[ws,id])).rows[0]?.payload||null;
const currentStatus=async(c,ws,id)=>(await c.query('SELECT payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2 FOR UPDATE',[ws,id])).rows[0]?.payload||null;
async function writeState(c,ws,id,log,status,truckId){
 if(log)await c.query('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,log_id) DO UPDATE SET payload=EXCLUDED.payload',[ws,id,log.shiftId,log.truckId,log]);else await c.query('DELETE FROM line_logs WHERE workspace_id=$1 AND log_id=$2',[ws,id]);
 if(status)await c.query('UPDATE line_truck_statuses SET payload=$3 WHERE workspace_id=$1 AND truck_id=$2',[ws,truckId,status]);
}
export function submitReport(pool,uid,input,ws=WS){
 const op=normalizeReport(input);if(!op.id.startsWith('report_'))throw fail('invalid-report-id');
 return serviceCommand(pool,uid,op,ws,(c,u)=>serviceActor(c,u,'edit_logs'),async(c,actor)=>{
  const beforeLog=await currentLog(c,ws,op.logId);if(!beforeLog||!isDeepStrictEqual(reportVersion(beforeLog),op.expected))throw fail('report-changed',409);
  const shift=(await c.query('SELECT is_active,payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2 FOR SHARE',[ws,beforeLog.shiftId])).rows[0];if(!shift?.is_active||shift.payload.closing)throw fail('shift-changed',409);
  const beforeStatus=await currentStatus(c,ws,beforeLog.truckId);let log=null,status=beforeStatus;
  if(op.type==='report.update'){
   const [h,m]=op.data.timeStr.split(':').map(Number),timestamp=Math.floor((beforeLog.timestamp+10800000)/86400000)*86400000-10800000+(h*60+m)*60000;
   log={...beforeLog,...op.data,timestamp};
  }
  if(beforeStatus?.lastLoadLogId===op.logId||log&&log.timestamp>Number(beforeStatus?.lastLoadTimestamp||0)){
   const previous=(await c.query("SELECT log_id,payload FROM line_logs WHERE workspace_id=$1 AND truck_id=$2 AND shift_id=$3 AND log_id<>$4 ORDER BY (payload->>'timestamp')::bigint DESC,log_id DESC LIMIT 1",[ws,beforeLog.truckId,beforeLog.shiftId,op.logId])).rows[0];
   const other=previous?{...previous.payload,id:previous.log_id}:null;
   const latest=[log,other].filter(Boolean).sort((a,b)=>a.timestamp-b.timestamp||a.id.localeCompare(b.id)).at(-1)||null;
   status={...beforeStatus,lastLoadTimestamp:latest?.timestamp||null,lastLoadBy:latest?.createdBy||null,lastLoadLogId:latest?.id||null,cycleRevision:Number(beforeStatus.cycleRevision||0)+1,ttnRevision:Number(beforeStatus.ttnRevision||0)+1,...(!log&&beforeStatus.ttnLogId===op.logId?{ttnStatus:null,ttnBy:null,ttnLogId:null}:{})};
  }
  await writeState(c,ws,op.logId,log,status,beforeLog.truckId);
  const now=Date.now(),event={eventType:'history',timestamp:now,userName:actor.display_name,userEmail:actor.email,shiftId:beforeLog.shiftId,text:op.type==='report.delete'?'Удалён рейс':'Изменён рейс',history:{undone:false,operations:[{collection:'logs',id:op.logId,before:beforeLog,after:log}]}};
  await c.query("INSERT INTO game_records(workspace_id,record_id,collection,payload) VALUES ($1,$2,'audit',$3)",[ws,'report_history_'+op.id,event]);
  if(!log&&beforeLog.createdByEmail)await c.query("INSERT INTO game_records(workspace_id,record_id,collection,payload) VALUES ($1,$2,'audit',$3) ON CONFLICT DO NOTHING",[ws,'game_penalty_'+op.id,{eventType:'game_penalty',amount:-3,targetEmail:beforeLog.createdByEmail,targetName:beforeLog.createdBy||'',timestamp:now,description:'Удалён рейс',text:'Штраф −3 монеты за удалённый ошибочный рейс'}]);
  return {before:{log:beforeLog,status:beforeStatus,logId:op.logId,truckId:beforeLog.truckId,shiftId:beforeLog.shiftId},after:{log,status,logId:op.logId,truckId:beforeLog.truckId,shiftId:beforeLog.shiftId},result:{id:op.logId,log,status}};
 });
}
export async function reportHistoryOperation(pool,uid,input,ws=WS){
 const op={...input,type:'report.history'};
 const authorize=async(c,u)=>{
  const actor=await serviceActor(c,u,'edit_logs'),row=(await c.query("SELECT uid FROM workspace_service_audit WHERE workspace_id=$1 AND operation_id=$2 AND type IN ('report.update','report.delete')",[ws,op.actionId])).rows[0];if(!row)throw fail('history-changed',409);
  if(actor.role!=='admin'){const permissions=(await c.query('SELECT action FROM role_permissions WHERE role=$1 AND allowed FOR SHARE',[actor.role])).rows.map(r=>r.action);if(!permissions.includes('history_'+op.direction+'_any')&&!(row.uid===u&&permissions.includes('history_'+op.direction+'_own')))throw fail('forbidden',403);}return actor;
 };
 const receipt=await serviceCommand(pool,uid,op,ws,authorize,async c=>{
  const row=(await c.query('SELECT * FROM workspace_service_audit WHERE workspace_id=$1 AND operation_id=$2 FOR UPDATE',[ws,op.actionId])).rows[0];if(Number(row.revision)!==op.expectedRevision||row.undone!==(op.direction==='redo'))throw fail('history-changed',409);
  const expected=op.direction==='undo'?row.after_data:row.before_data,next=op.direction==='undo'?row.before_data:row.after_data;
  const shift=(await c.query('SELECT is_active,payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2 FOR SHARE',[ws,next.shiftId])).rows[0];if(!shift?.is_active||shift.payload.closing)throw fail('shift-changed',409);
  const log=await currentLog(c,ws,next.logId),current=await currentStatus(c,ws,next.truckId);
  const strip=s=>s?Object.fromEntries(Object.entries(s).filter(([k])=>!['cycleRevision','ttnRevision'].includes(k))):null;
  if(!isDeepStrictEqual(log,expected.log)||!isDeepStrictEqual(strip(current),strip(expected.status)))throw fail('dependent-changes',409);
  const status=next.status?{...next.status,cycleRevision:Number(current?.cycleRevision||0)+1,ttnRevision:Number(current?.ttnRevision||0)+1}:null;
  await writeState(c,ws,next.logId,next.log,status,next.truckId);await c.query('UPDATE workspace_service_audit SET undone=$3,revision=revision+1 WHERE workspace_id=$1 AND operation_id=$2',[ws,op.actionId,op.direction==='undo']);
  await c.query("UPDATE game_records SET payload=jsonb_set(payload,'{history,undone}',$3::jsonb) WHERE workspace_id=$1 AND record_id=$2",[ws,'report_history_'+op.actionId,JSON.stringify(op.direction==='undo')]);
  return {result:{outcome:'confirmed',actionId:op.actionId,direction:op.direction,revision:Number(row.revision)+1,status:status||{},log:next.log,removedLogId:next.log?null:next.logId},before:expected,after:next};
 });return {...receipt.result,...(receipt.replayed?{replayed:true}:{})};
}
