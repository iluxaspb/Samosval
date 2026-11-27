import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fail,parseKey} from './tabel-access.mjs';
import {linePeriod,buildShiftArchive,requireMaterialImport} from './shift-archive.mjs';
const WS=process.env.WORKSPACE_ID||'main_workspace';
export async function closeShiftOperation(pool,uid,input) {
  if(!input||!['prepare','finish'].includes(input.type)||typeof input.id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(input.id)||typeof input.shiftId!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(input.shiftId))throw fail('invalid-close-operation');
  const op={id:input.id,type:input.type,shiftId:input.shiftId};
  const hash=createHash('sha256').update(JSON.stringify(op)).digest('hex'),client=await pool.connect();
  try {
    await client.query('BEGIN');
    const profile=(await client.query('SELECT display_name,role,status FROM app_users WHERE uid=$1 FOR SHARE',[uid])).rows[0];
    if(!profile||profile.status!=='active')throw fail('forbidden',403);
    if(profile.role!=='admin'&&!(await client.query("SELECT allowed FROM role_permissions WHERE role=$1 AND action='close_shift' FOR SHARE",[profile.role])).rows[0]?.allowed)throw fail('forbidden',403);
    const created=await client.query("INSERT INTO shift_operation_receipts(workspace_id,operation_id,uid,request_hash,result) VALUES ($1,$2,$3,$4,'{}') ON CONFLICT DO NOTHING RETURNING operation_id",[WS,op.id,uid,hash]);
    if(!created.rowCount){
      const old=(await client.query('SELECT uid,request_hash,result FROM shift_operation_receipts WHERE workspace_id=$1 AND operation_id=$2',[WS,op.id])).rows[0];
      if(old.uid!==uid||old.request_hash!==hash)throw fail('operation-id-reused',409);
      await client.query('COMMIT');return {...old.result,replayed:true};
    }
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[WS]);
    // Line operations hold FOR SHARE on this row until their load commits.
    // This exclusive lock waits for those loads before freezing the archive.
    const row=(await client.query('SELECT is_active,payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2 FOR UPDATE',[WS,op.shiftId])).rows[0];
    if(!row||row.payload.id!==op.shiftId)throw fail('shift-changed',409);
    let shift={...row.payload,id:op.shiftId},archiveId='closed_'+op.shiftId;
    let archive=(await client.query('SELECT payload FROM shift_archives WHERE workspace_id=$1 AND shift_id=$2',[WS,op.shiftId])).rows[0]?.payload||null;
    let result;
    if(op.type==='prepare'){
      if(!row.is_active&&!shift.closing)throw fail('shift-already-closed',409);
      if(!shift.closing)shift={...shift,isActive:false,closing:true,closeArchiveId:archiveId,closingStartedAt:Date.now(),closingBy:profile.display_name};
      if(shift.closeArchiveId!==archiveId)throw fail('archive-id-conflict',409);
      const logs=(await client.query('SELECT log_id,payload FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id',[WS,op.shiftId])).rows.map(r=>({...r.payload,id:r.log_id}));
      const statuses=Object.fromEntries((await client.query('SELECT truck_id,payload FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2 ORDER BY truck_id',[WS,op.shiftId])).rows.map(r=>[r.truck_id,r.payload]));
      const candidate=buildShiftArchive(shift,logs,statuses,shift.closingStartedAt);
      if(archive&&!isDeepStrictEqual(archive,candidate))throw fail('archive-source-mismatch',409);
      if(!archive&&candidate){
        archive=candidate;
        await client.query('INSERT INTO shift_archives(workspace_id,archive_id,shift_id,payload) VALUES ($1,$2,$3,$4)',[WS,archiveId,op.shiftId,archive]);
      }
      // 025 (design §4.1/D1): is_active means "occupies a line" and is true for
      // `active` *and* `closing`. Clearing it here contradicts the canonical
      // payload and the trigger rejects the row with 23514
      // ('shift canonical payload mismatch'), so the shift could never be
      // closed on the canonical schema. The line stays occupied until `finish`
      // releases it — exactly like the v2 close (shift-close-v2.mjs).
      await client.query('UPDATE shifts SET is_active=true,payload=$3 WHERE workspace_id=$1 AND shift_id=$2',[WS,op.shiftId,shift]);
      result={outcome:'confirmed',phase:'awaiting-material',shift,archive,archiveId:archive?archiveId:null};
    } else {
      // The prepared marker is the `closing` document, not a cleared is_active:
      // since 025 the line stays occupied (is_active=true) until this phase.
      if(!shift.closing)throw fail('shift-not-prepared',409);
      // Восстановленная архивная смена уже переносила материал при исходном
      // закрытии: повторного подтверждения табеля не требуется.
      let materialImport=null;
      if(archive?.totalTrips&&!shift.restored){
        const kind=shift.workShift||shift.kind;
        if(!['day','night'].includes(kind)){
          // Legacy-смена, открытая до обязательного выбора типа: день/ночь не
          // доказан, класть объём некуда. Закрываем без вопросов, архив
          // сохраняем целиком, перенос пропускаем и помечаем это в результате
          // (решение владельца 26.11.2026).
          materialImport='skipped-unresolved-type';
        }else{
          if(!/^[A-Za-z0-9_-]+$/.test(shift.objectId||''))throw fail('missing-shift-object',409);
          const period=linePeriod(shift),key=shift.objectId+'/day:'+period.date+':'+period.kind;
          // Serialize with Tabel commits, so a simultaneous material correction cannot pass unnoticed.
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['tabel:'+WS]);
          if(!(await client.query('SELECT enabled FROM tabel_policy WHERE workspace_id=$1 FOR SHARE',[WS])).rows[0]?.enabled)throw fail('tabel-not-ready',409);
          const material=(await client.query('SELECT payload FROM tabel_records WHERE workspace_id=$1 AND record_id=$2',[WS,parseKey(key).recordId])).rows[0]?.payload;
          requireMaterialImport(shift,archive,material);
        }
      }
      const logs=(await client.query('SELECT log_id,payload FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id',[WS,op.shiftId])).rows.map(r=>({...r.payload,id:r.log_id}));
      const statuses=Object.fromEntries((await client.query('SELECT truck_id,payload FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2 ORDER BY truck_id',[WS,op.shiftId])).rows.map(r=>[r.truck_id,r.payload]));
      if(!isDeepStrictEqual(archive,buildShiftArchive(shift,logs,statuses,shift.closingStartedAt)))throw fail('archive-source-mismatch',409);
      // The archive and material marker are already durable. Delete this shift only.
      await client.query('DELETE FROM line_logs WHERE workspace_id=$1 AND shift_id=$2',[WS,op.shiftId]);
      await client.query('DELETE FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2',[WS,op.shiftId]);
      // 025 derives the canonical `state` from the document, not from the alias:
      // without `closedByUid` there is no proof of the close, so the row would
      // land in `historical` (the state of migrated legacy rows) instead of
      // `closed`. Write both the proof and the terminal alias, like v2 does
      // (shift-close-v2.mjs).
      shift={...shift,state:'closed',isActive:false,closing:false,closedAt:Date.now(),closedBy:profile.display_name,closedByUid:uid};
      if(materialImport)shift={...shift,materialImport};
      await client.query('UPDATE shifts SET is_active=false,payload=$3 WHERE workspace_id=$1 AND shift_id=$2',[WS,op.shiftId,shift]);
      result={outcome:'confirmed',phase:'closed',shift,archiveId:archive?archiveId:null};
      if(materialImport)result.materialImport=materialImport;
    }
    await client.query('UPDATE shift_operation_receipts SET result=$3 WHERE workspace_id=$1 AND operation_id=$2',[WS,op.id,result]);
    await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
  finally{client.release();}
}
