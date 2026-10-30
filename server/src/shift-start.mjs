import {createHash} from 'node:crypto';
import {fail} from './tabel-access.mjs';
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
export function normalizeShiftStart(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||!validId(input.id)||!validId(input.objectId)||!Number.isSafeInteger(input.createdAt)||input.createdAt<=0)throw fail('invalid-start-operation');
  // User identity, object name and shift timestamps are resolved on the server.
  return {type:'start',id:input.id,objectId:input.objectId,createdAt:input.createdAt};
}
export function shiftStartPayload(op,object,actor,now=Date.now()) {
  const name=object?.name;
  if(typeof name!=='string'||!name.trim()||name.length>500||object.deleted||object.disabled)throw fail('object-not-available',409);
  const startDate=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric'}).format(now).replaceAll('/','.');
  return {id:'shift_'+op.id,objectId:op.objectId,objectName:name.trim(),startDate,startedAt:now,startedBy:actor.display_name,startedByUid:actor.uid,isActive:true};
}
export async function startShiftOperation(pool,uid,input,workspaceId=process.env.WORKSPACE_ID||'main_workspace') {
  const op=normalizeShiftStart(input),hash=createHash('sha256').update(JSON.stringify(op)).digest('hex');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const profile=(await client.query('SELECT display_name,role,status FROM app_users WHERE uid=$1 FOR SHARE',[uid])).rows[0];
    if(!profile||profile.status!=='active')throw fail('forbidden',403);
    if(profile.role!=='admin'&&(await client.query("SELECT allowed FROM role_permissions WHERE role=$1 AND action='start_shift' FOR SHARE",[profile.role])).rows[0]?.allowed!==true)throw fail('forbidden',403);
    const created=await client.query("INSERT INTO shift_operation_receipts(workspace_id,operation_id,uid,request_hash,result) VALUES ($1,$2,$3,$4,'{}') ON CONFLICT DO NOTHING RETURNING operation_id",[workspaceId,op.id,uid,hash]);
    if(!created.rowCount){
      const old=(await client.query('SELECT uid,request_hash,result FROM shift_operation_receipts WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,op.id])).rows[0];
      if(!old||old.uid!==uid||old.request_hash!==hash)throw fail('operation-id-reused',409);
      await client.query('COMMIT');return {...old.result,replayed:true};
    }
    if(op.createdAt>Date.now()+300000)throw fail('future-operation');
    // Every start locks the workspace, including starts from other API replicas.
    // Do not rely on a read-then-insert check for simultaneous operators.
    const workspace=(await client.query('SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[workspaceId])).rows[0];
    if(!workspace)throw fail('workspace-not-ready',409);
    const unfinished=(await client.query("SELECT shift_id,is_active,payload FROM shifts WHERE workspace_id=$1 AND (is_active OR payload->>'closing'='true') ORDER BY shift_id FOR SHARE",[workspaceId])).rows;
    if(unfinished.some(x=>x.is_active))throw fail('shift-already-active',409);
    if(unfinished.length)throw fail('previous-shift-closing',409);
    // Finishing a close must archive and confirm material before clearing only
    // its own source rows. Starting never deletes historical or orphaned data.
    const leftovers=(await client.query('SELECT EXISTS(SELECT 1 FROM line_logs WHERE workspace_id=$1) OR EXISTS(SELECT 1 FROM line_truck_statuses WHERE workspace_id=$1) AS found',[workspaceId])).rows[0]?.found;
    if(leftovers)throw fail('previous-line-data-remains',409);
    const object=(await client.query('SELECT payload FROM workspace_objects WHERE workspace_id=$1 AND object_id=$2 FOR SHARE',[workspaceId,op.objectId])).rows[0]?.payload;
    const shift=shiftStartPayload(op,object,{...profile,uid});
    if((await client.query('SELECT 1 FROM shifts WHERE workspace_id=$1 AND shift_id=$2',[workspaceId,shift.id])).rowCount)throw fail('shift-id-reused',409);
    await client.query('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',[workspaceId,shift.id,shift]);
    await client.query("INSERT INTO line_audit(workspace_id,operation_id,uid,type,status) VALUES ($1,$2,$3,'start_shift','confirmed')",[workspaceId,op.id,uid]);
    const result={outcome:'confirmed',shift};
    await client.query('UPDATE shift_operation_receipts SET result=$3 WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,op.id,result]);
    await client.query('COMMIT');return result;
  } catch(e) {await client.query('ROLLBACK').catch(()=>{});throw e;}
  finally{client.release();}
}
