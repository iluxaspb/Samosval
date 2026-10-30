import {createHash} from 'node:crypto';
import {fail} from './tabel-access.mjs';
import {normalizeControl,membershipStatus,CONTROL_PERMISSIONS} from './control-rules.mjs';
const WS=process.env.WORKSPACE_ID||'main_workspace';
async function actor(client,uid,permission){
  const row=(await client.query('SELECT display_name,role,status FROM app_users WHERE uid=$1 FOR SHARE',[uid])).rows[0];
  if(!row||row.status!=='active')throw fail('forbidden',403);
  if(row.role!=='admin'&&(await client.query('SELECT allowed FROM role_permissions WHERE role=$1 AND action=$2 FOR SHARE',[row.role,permission])).rows[0]?.allowed!==true)throw fail('forbidden',403);
  return row;
}
async function activeShift(client,ws,id,exclusive=false){
  const row=(await client.query('SELECT is_active,payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2 '+(exclusive?'FOR UPDATE':'FOR SHARE'),[ws,id])).rows[0];
  if(!row?.is_active||row.payload.closing)throw fail('shift-changed',409);
  return row.payload;
}
export async function submitControl(pool,uid,input,ws=WS){
  const op=normalizeControl(input),hash=createHash('sha256').update(JSON.stringify(op)).digest('hex'),client=await pool.connect();
  try{
    await client.query('BEGIN');
    const profile=await actor(client,uid,CONTROL_PERMISSIONS[op.type]);
    const inserted=await client.query("INSERT INTO control_operation_receipts(workspace_id,operation_id,uid,request_hash,result) VALUES ($1,$2,$3,$4,'{}') ON CONFLICT DO NOTHING RETURNING operation_id",[ws,op.id,uid,hash]);
    if(!inserted.rowCount){
      const old=(await client.query('SELECT uid,request_hash,result FROM control_operation_receipts WHERE workspace_id=$1 AND operation_id=$2',[ws,op.id])).rows[0];
      if(!old||old.uid!==uid||old.request_hash!==hash)throw fail('operation-id-reused',409);
      await client.query('COMMIT');return {...old.result,replayed:true};
    }
    // NO KEY UPDATE is compatible with receipt FK key-share locks. FOR UPDATE
    // here would deadlock simultaneous operations after both inserted receipts.
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[ws]);
    let before=null,after=null;
    if(op.type.startsWith('line.')){
      await activeShift(client,ws,op.shiftId);
      const row=(await client.query('SELECT payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2 FOR UPDATE',[ws,op.truckId])).rows[0];
      const truck=(await client.query('SELECT payload FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2 FOR SHARE',[ws,op.truckId])).rows[0]?.payload;
      if(!truck||truck.deleted)throw fail('truck-not-available',409);
      before=row?.payload||null;after=membershipStatus(op,before,profile.display_name);
      await client.query('INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id,truck_id) DO UPDATE SET payload=EXCLUDED.payload,shift_id=EXCLUDED.shift_id',[ws,op.truckId,op.shiftId,after]);
    }else if(op.type==='shift.object'){
      before=await activeShift(client,ws,op.shiftId,true);
      if((before.objectId||'')!==op.expectedObjectId)throw fail('object-changed',409);
      const object=(await client.query('SELECT payload FROM workspace_objects WHERE workspace_id=$1 AND object_id=$2 FOR SHARE',[ws,op.objectId])).rows[0]?.payload;
      if(!object||object.deleted||object.disabled)throw fail('object-not-available',409);
      after={...before,objectId:op.objectId,objectName:object.name};
      await client.query('UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',[ws,op.shiftId,after]);
    }else{
      const truck=op.type.startsWith('truck.'),table=truck?'line_trucks':'workspace_objects',key=truck?'truck_id':'object_id';
      // Match load's status -> truck lock order for deletes.
      if(truck&&op.type.endsWith('.delete')){
        const status=(await client.query('SELECT payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2 FOR UPDATE',[ws,op.recordId])).rows[0]?.payload;
        if(status?.onLine)throw fail('truck-still-on-line',409);
      }
      if(!truck&&op.type.endsWith('.delete')){
        const referenced=await client.query("SELECT shift_id FROM shifts WHERE workspace_id=$1 AND payload->>'objectId'=$2 AND (is_active OR payload->>'closing'='true') FOR SHARE",[ws,op.recordId]);
        if(referenced.rowCount)throw fail('object-in-open-shift',409);
      }
      const row=(await client.query(`SELECT payload,revision FROM ${table} WHERE workspace_id=$1 AND ${key}=$2 FOR UPDATE`,[ws,op.recordId])).rows[0];
      if(Number(row?.revision||0)!==op.expectedRevision||row?.payload.deleted)throw fail('record-changed',409);
      const now=Date.now();before=row?{id:op.recordId,data:row.payload,revision:Number(row.revision)}:null;
      const data=op.type.endsWith('.delete')?{...row.payload,deleted:true,deletedAt:now,deletedBy:profile.display_name}:
        {...(row?.payload||{}),...op.data,...(row?{updatedAt:now,updatedBy:profile.display_name}:{createdAt:now,createdBy:profile.display_name})};
      const revision=op.expectedRevision+1;
      await client.query(`INSERT INTO ${table}(workspace_id,${key},payload,revision) VALUES ($1,$2,$3,$4) ON CONFLICT(workspace_id,${key}) DO UPDATE SET payload=EXCLUDED.payload,revision=EXCLUDED.revision`,[ws,op.recordId,data,revision]);
      after={id:op.recordId,data,revision};
    }
    const result={outcome:'confirmed',operationId:op.id,type:op.type,result:after};
    await client.query('INSERT INTO control_audit(workspace_id,operation_id,uid,type,before_data,after_data) VALUES ($1,$2,$3,$4,$5,$6)',[ws,op.id,uid,op.type,before,after]);
    await client.query('UPDATE control_operation_receipts SET result=$3 WHERE workspace_id=$1 AND operation_id=$2',[ws,op.id,result]);
    await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export async function readCatalog(pool,uid,ws=WS){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const profile=(await client.query('SELECT role,status FROM app_users WHERE uid=$1',[uid])).rows[0];
    if(!profile||profile.status!=='active')throw fail('forbidden',403);
    const permissions=(await client.query('SELECT action FROM role_permissions WHERE role=$1 AND allowed=true',[profile.role])).rows.map(r=>r.action);
    const line=profile.role==='admin'||permissions.some(x=>['tab_line','tab_trucks'].includes(x));
    if(!line&&!permissions.includes('tab_timesheet'))throw fail('forbidden',403);
    const rows=async(table,key)=>(await client.query(`SELECT ${key} AS id,payload,revision FROM ${table} WHERE workspace_id=$1 AND payload->>'deleted' IS DISTINCT FROM 'true' ORDER BY ${key}`,[ws])).rows.map(r=>({id:r.id,data:r.payload,revision:Number(r.revision)}));
    const trucks=line?await rows('line_trucks','truck_id'):[],objects=await rows('workspace_objects','object_id');
    await client.query('COMMIT');return {format:'samosval-catalog',version:1,source:'synology',workspaceId:ws,trucks,objects};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
