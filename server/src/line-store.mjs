import { createHash } from 'node:crypto';
import {recordLineHistory} from './history-store.mjs';
import { applyLineOperation, validateLineOperation } from './line-rules.mjs';

const WORKSPACE_ID = process.env.WORKSPACE_ID || 'main_workspace';
const ACTIONS = { arrive: 'action_arrive', load: 'action_load', ttn: 'action_ttn', reset: 'admin_only' };
const REPLAY_FIELDS = ['id','type','truckId','shiftId','createdAt','expectedRevision','expectedTtnRevision',
  'arrivalTimestamp','lastLoadTimestamp','wantArrived','collect','cycleMinutes','logId'];
const forbidden = () => Object.assign(new Error('Forbidden'), {status:403,code:'forbidden'});
const invalid = (code, status=400) => Object.assign(new Error(code), {status,code});

export async function submitLineOperation(pool, uid, input) {
  const error = validateLineOperation(input);
  if (error) throw invalid(error);
  const op = Object.fromEntries(REPLAY_FIELDS.filter(k => input[k] !== undefined).map(k => [k,input[k]]));
  const hash = createHash('sha256').update(JSON.stringify(op)).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const profile = (await client.query(
      "SELECT email, display_name, role, status FROM app_users WHERE uid = $1 FOR SHARE",
      [uid])).rows[0];
    if (!profile || profile.status !== 'active') throw forbidden();
    const admin = profile.role === 'admin';
    if (op.type === 'reset' && !admin) throw forbidden();
    if (!admin) {
      const permitted = (await client.query(
        'SELECT allowed FROM role_permissions WHERE role=$1 AND action=$2 FOR SHARE',
        [profile.role, ACTIONS[op.type]])).rows[0]?.allowed;
      if (permitted !== true) throw forbidden();
    }

    // A unique receipt serializes *same-ID* retries, even across API replicas.
    const receiptInsert = await client.query(
      `INSERT INTO line_operation_receipts(workspace_id,operation_id,uid,request_hash,result)
       VALUES ($1,$2,$3,$4,'{}'::jsonb) ON CONFLICT DO NOTHING RETURNING operation_id`,
      [WORKSPACE_ID,op.id,uid,hash]);
    if (!receiptInsert.rowCount) {
      const old = (await client.query(
        'SELECT uid, request_hash, result FROM line_operation_receipts WHERE workspace_id=$1 AND operation_id=$2',
        [WORKSPACE_ID,op.id])).rows[0];
      if (!old || old.uid!==uid || old.request_hash!==hash) throw invalid('operation-id-reused',409);
      await client.query('COMMIT');
      return {...old.result,replayed:true};
    }
    const shift = (await client.query(
      'SELECT is_active,payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2 FOR SHARE',
      [WORKSPACE_ID,op.shiftId])).rows[0];
    const statusRow = (await client.query(
      'SELECT payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2 FOR UPDATE',
      [WORKSPACE_ID,op.truckId])).rows[0];
    const truckRow = (await client.query(
      'SELECT payload FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2',
      [WORKSPACE_ID,op.truckId])).rows[0];
    const workspace = (await client.query(
      'SELECT cycle_minutes FROM workspaces WHERE id=$1',
      [WORKSPACE_ID])).rows[0];
    const before = statusRow?.payload || {};
    let result;
    if (!shift?.is_active || shift.payload?.closing) result = {outcome:'rejected',reason:'shift-changed',status:before};
    else if (!statusRow || !truckRow || truckRow.payload.deleted || !before.onLine || before.shiftId!==op.shiftId)
      result = {outcome:'rejected',reason:'truck-not-on-line',status:before};
    else result = applyLineOperation({
      op, before, truck:truckRow.payload,
      actor:{name:profile.display_name,email:profile.email,isAdmin:admin},
      cycleMinutes:workspace?.cycle_minutes||15,
      now:Date.now()
    });

    if (result.outcome==='confirmed' && result.log) {
      const inserted = await client.query(
        `INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload)
         VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING log_id`,
        [WORKSPACE_ID,result.log.id,op.shiftId,op.truckId,JSON.stringify(result.log)]);
      if (!inserted.rowCount) result = {outcome:'rejected',reason:'duplicate',status:before};
    }
    if (result.outcome==='confirmed') {
      await recordLineHistory(client,{workspaceId:WORKSPACE_ID,uid,op,before,result});
      await client.query(
        'UPDATE line_truck_statuses SET payload=$3::jsonb WHERE workspace_id=$1 AND truck_id=$2',
        [WORKSPACE_ID,op.truckId,JSON.stringify(result.status)]);
      await client.query(
        `INSERT INTO line_audit(workspace_id,operation_id,uid,type,status)
         VALUES ($1,$2,$3,$4,$5)`,
        [WORKSPACE_ID,op.id,uid,op.type,'confirmed']);
    }
    const saved = {outcome:result.outcome,reason:result.reason||null,status:result.status||null,log:result.log||null};
    await client.query(
      'UPDATE line_operation_receipts SET result=$3::jsonb WHERE workspace_id=$1 AND operation_id=$2',
      [WORKSPACE_ID,op.id,JSON.stringify(saved)]);
    await client.query('COMMIT');
    return saved;
  } catch (e) {
    await client.query('ROLLBACK').catch(()=>{});
    throw e;
  } finally {
    client.release();
  }
}

