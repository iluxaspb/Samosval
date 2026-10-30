import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fail,map} from './tabel-access.mjs';
import {rewardSnapshot} from './game-economy.mjs';
const WS=process.env.WORKSPACE_ID||'main_workspace';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
export function normalizeHistoryOperation(input){
  if(!map(input)||!id(input.id)||!id(input.actionId)||!['undo','redo'].includes(input.direction)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)throw fail('invalid-history-operation');
  return {id:input.id,actionId:input.actionId,direction:input.direction,expectedRevision:input.expectedRevision};
}
// Revisions never go backwards; identity fields are set by the database, not payload.
export function sameLineState(a,b){
  if(!map(a)||!map(b))return false;
  const strip=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['id','cycleRevision','ttnRevision'].includes(key)));
  return isDeepStrictEqual(strip(a),strip(b));
}
export async function recordLineHistory(client,{workspaceId,uid,op,before,result,profile,shift}){
  const policy=(await client.query('SELECT payload FROM workspace_settings WHERE workspace_id=$1 FOR SHARE',[workspaceId])).rows[0]?.payload||{};
  const rewards=rewardSnapshot(policy,{id:op.id,type:op.type,at:op.createdAt},Date.now());
  const actor={email:profile?.email||'',name:profile?.display_name||'',objectId:shift?.objectId||'',objectName:shift?.objectName||''};
  await client.query(`INSERT INTO line_history(workspace_id,action_id,uid,shift_id,truck_id,type,before_status,after_status,log_data,game_rewards,game_actor)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[workspaceId,op.id,uid,op.shiftId,op.truckId,op.type,before,result.status,result.log||null,rewards,actor]);
}
async function actor(client,uid,lock=''){
  const row=(await client.query('SELECT role,status,profile FROM app_users WHERE uid=$1 '+lock,[uid])).rows[0];
  if(!row||row.status!=='active'||row.profile?.deleted)throw fail('forbidden',403);
  return row;
}
async function permitted(client,profile,uid,owner,direction,lock=''){
  if(profile.role==='admin')return true;
  const permissions=(await client.query('SELECT action FROM role_permissions WHERE role=$1 AND allowed=true '+lock,[profile.role])).rows.map(r=>r.action);
  return permissions.includes('history_'+direction+'_any')||uid===owner&&permissions.includes('history_'+direction+'_own');
}
export async function historyOperation(pool,uid,input,ws=WS){
  const op=normalizeHistoryOperation(input),hash=createHash('sha256').update(JSON.stringify(op)).digest('hex'),client=await pool.connect();
  try{
    await client.query('BEGIN');
    const profile=await actor(client,uid,'FOR SHARE');
    // Permission check precedes receipt replay, so revoked access cannot replay a success.
    const target=(await client.query('SELECT uid,shift_id FROM line_history WHERE workspace_id=$1 AND action_id=$2',[ws,op.actionId])).rows[0];
    if(!target||!await permitted(client,profile,uid,target.uid,op.direction,'FOR SHARE'))throw fail('forbidden',403);
    const inserted=await client.query("INSERT INTO history_receipts(workspace_id,operation_id,uid,request_hash,result) VALUES ($1,$2,$3,$4,'{}') ON CONFLICT DO NOTHING RETURNING operation_id",[ws,op.id,uid,hash]);
    if(!inserted.rowCount){
      const previous=(await client.query('SELECT uid,request_hash,result FROM history_receipts WHERE workspace_id=$1 AND operation_id=$2',[ws,op.id])).rows[0];
      if(!previous||previous.uid!==uid||previous.request_hash!==hash)throw fail('operation-id-reused',409);
      await client.query('COMMIT');return {...previous.result,replayed:true};
    }
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[ws]);
    // Same workspace -> shift -> status lock order as live operations and closing.
    const shift=(await client.query('SELECT is_active,payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2 FOR SHARE',[ws,target.shift_id])).rows[0];
    if(!shift?.is_active||shift.payload.closing)throw fail('shift-changed',409);
    const action=(await client.query('SELECT * FROM line_history WHERE workspace_id=$1 AND action_id=$2 FOR UPDATE',[ws,op.actionId])).rows[0];
    if(Number(action.revision)!==op.expectedRevision||action.undone!==(op.direction==='redo'))throw fail('history-changed',409);
    const current=(await client.query('SELECT payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2 FOR UPDATE',[ws,action.truck_id])).rows[0]?.payload;
    const expected=op.direction==='undo'?action.after_status:action.before_status;
    if(!sameLineState(current,expected))throw fail('dependent-changes',409);
    const log=action.log_data;
    if(log){
      const stored=(await client.query('SELECT payload FROM line_logs WHERE workspace_id=$1 AND log_id=$2 FOR UPDATE',[ws,log.id])).rows[0]?.payload;
      if(op.direction==='undo'?!isDeepStrictEqual(stored,log):!!stored)throw fail('dependent-changes',409);
      if(op.direction==='undo')await client.query('DELETE FROM line_logs WHERE workspace_id=$1 AND log_id=$2',[ws,log.id]);
      else await client.query('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES ($1,$2,$3,$4,$5)',[ws,log.id,action.shift_id,action.truck_id,log]);
    }
    const data=op.direction==='undo'?action.before_status:action.after_status;
    const status={...data,cycleRevision:Number(current.cycleRevision||0)+1,ttnRevision:Number(current.ttnRevision||0)+1};
    await client.query('UPDATE line_truck_statuses SET payload=$3 WHERE workspace_id=$1 AND truck_id=$2',[ws,action.truck_id,status]);
    const result={outcome:'confirmed',actionId:op.actionId,direction:op.direction,revision:Number(action.revision)+1,status,log:op.direction==='redo'?log:null,removedLogId:op.direction==='undo'?log?.id||null:null};
    await client.query('UPDATE line_history SET undone=$3,revision=revision+1 WHERE workspace_id=$1 AND action_id=$2',[ws,op.actionId,op.direction==='undo']);
    await client.query('INSERT INTO history_audit(workspace_id,operation_id,uid,action_id,direction) VALUES ($1,$2,$3,$4,$5)',[ws,op.id,uid,op.actionId,op.direction]);
    if(op.direction==='undo'){
      const author=action.game_actor||(await client.query('SELECT email,display_name AS name FROM app_users WHERE uid=$1',[action.uid])).rows[0];
      const actorName=(await client.query('SELECT display_name FROM app_users WHERE uid=$1',[uid])).rows[0]?.display_name||uid;
      if(author?.email){const now=Date.now(),penalty={eventType:'game_penalty',amount:-3,actionId:op.actionId,targetEmail:author.email,targetName:author.name||author.email,description:action.type,scope:{shiftId:action.shift_id,objectId:author.objectId||'',objectName:author.objectName||''},timestamp:now,userEmail:'',userName:actorName,createdByUid:uid,text:'Штраф −3 монеты за отменённое ошибочное действие'};
        await client.query("INSERT INTO game_records(workspace_id,record_id,collection,payload) VALUES ($1,$2,'audit',$3) ON CONFLICT DO NOTHING",[ws,'game_penalty_nas_'+op.actionId,penalty]);}
    }
    await client.query('UPDATE history_receipts SET result=$3 WHERE workspace_id=$1 AND operation_id=$2',[ws,op.id,result]);
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
export async function readLineHistory(pool,uid,ws=WS){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const profile=await actor(client,uid);
    const permissions=(await client.query('SELECT action FROM role_permissions WHERE role=$1 AND allowed=true',[profile.role])).rows.map(r=>r.action);
    if(profile.role!=='admin'&&!['history_view','history_undo_own','history_undo_any','history_redo_own','history_redo_any'].some(p=>permissions.includes(p)))throw fail('forbidden',403);
    const rows=(await client.query(`SELECT h.*,s.is_active,s.payload->>'closing' AS closing,u.display_name
      FROM line_history h JOIN shifts s ON s.workspace_id=h.workspace_id AND s.shift_id=h.shift_id
      LEFT JOIN app_users u ON u.uid=h.uid WHERE h.workspace_id=$1 ORDER BY h.created_at DESC,h.action_id DESC LIMIT 300`,[ws])).rows;
    const items=rows.map(row=>({id:row.action_id,uid:row.uid,userName:row.display_name||'',shiftId:row.shift_id,truckId:row.truck_id,type:row.type,undone:row.undone,revision:Number(row.revision),timestamp:new Date(row.created_at).getTime(),
      canUndo:!row.undone&&row.is_active&&row.closing!=='true'&&(profile.role==='admin'||permissions.includes('history_undo_any')||row.uid===uid&&permissions.includes('history_undo_own')),
      canRedo:row.undone&&row.is_active&&row.closing!=='true'&&(profile.role==='admin'||permissions.includes('history_redo_any')||row.uid===uid&&permissions.includes('history_redo_own'))}));
    await client.query('COMMIT');return {format:'samosval-line-history',version:1,source:'synology',items};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
