import {createHash} from 'node:crypto';
import {fail,map} from './tabel-access.mjs';
export const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(x);
export async function serviceActor(client,uid,permission,{admin=false,lock=true}={}){
  const actor=(await client.query('SELECT uid,email,display_name,role,status,profile FROM app_users WHERE uid=$1'+(lock?' FOR SHARE':''),[uid])).rows[0];
  if(!actor||actor.status!=='active'||actor.profile?.deleted)throw fail('forbidden',403);
  if(admin&&actor.role!=='admin')throw fail('forbidden',403);
  if(permission&&actor.role!=='admin'&&!(await client.query('SELECT allowed FROM role_permissions WHERE role=$1 AND action=$2'+(lock?' FOR SHARE':''),[actor.role,permission])).rows[0]?.allowed)throw fail('forbidden',403);
  return actor;
}
// Recheck access before replay; keep receipt, mutation and audit in one transaction.
export async function serviceCommand(pool,uid,op,ws,authorize,mutate){
  if(!map(op)||!validId(op.id))throw fail('invalid-operation');
  const hash=createHash('sha256').update(JSON.stringify(op)).digest('hex'),client=await pool.connect();
  try{
    await client.query('BEGIN');
    const actor=await authorize(client,uid);
    const inserted=await client.query("INSERT INTO workspace_service_receipts(workspace_id,operation_id,uid,request_hash,result) VALUES ($1,$2,$3,$4,'{}') ON CONFLICT DO NOTHING RETURNING operation_id",[ws,op.id,uid,hash]);
    if(!inserted.rowCount){
      const old=(await client.query('SELECT uid,request_hash,result FROM workspace_service_receipts WHERE workspace_id=$1 AND operation_id=$2',[ws,op.id])).rows[0];
      if(!old||old.uid!==uid||old.request_hash!==hash)throw fail('operation-id-reused',409);
      await client.query('COMMIT');return {...old.result,replayed:true};
    }
    if(!(await client.query('SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[ws])).rowCount)throw fail('workspace-not-ready',409);
    const {result,before=null,after=null}=await mutate(client,actor);
    const receipt={outcome:'confirmed',operationId:op.id,type:op.type,result};
    await client.query('INSERT INTO workspace_service_audit(workspace_id,operation_id,uid,type,before_data,after_data) VALUES ($1,$2,$3,$4,$5,$6)',[ws,op.id,uid,op.type,before===null?null:JSON.stringify(before),after===null?null:JSON.stringify(after)]);
    await client.query('UPDATE workspace_service_receipts SET result=$3 WHERE workspace_id=$1 AND operation_id=$2',[ws,op.id,receipt]);
    await client.query('COMMIT');return receipt;
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
