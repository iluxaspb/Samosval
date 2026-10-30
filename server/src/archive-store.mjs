import {fail,map} from './tabel-access.mjs';
import {serviceActor,serviceCommand,validId} from './service-command.mjs';
import {readArchiveEntries} from './archive-read.mjs';
const WS=process.env.WORKSPACE_ID||'main_workspace';
export function normalizeArchive(input){
  if(!map(input)||!validId(input.id)||typeof input.recordId!=='string'||!input.recordId||input.recordId.length>200||input.recordId.includes('/')||!['archive.trash','archive.restore','trash.purge'].includes(input.type)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)throw fail('invalid-archive-operation');
  return {id:input.id,type:input.type,recordId:input.recordId,expectedRevision:input.expectedRevision};
}
export function restoredLine(archive,op,actor,now){
  if(!map(archive)||!Array.isArray(archive.logs)||!Array.isArray(archive.activeLineIds)||typeof archive.objectId!=='string'||!archive.objectId||typeof archive.date!=='string')throw fail('invalid-archive-data',409);
  const shiftId='shift_'+op.id,logs=[],byTruck=new Map();
  for(const [i,log] of archive.logs.entries()){
    if(!map(log)||!validId(log.truckId)||!Number.isFinite(log.timestamp)||log.timestamp<0||!Number.isFinite(log.volume)||log.volume<0)throw fail('invalid-archive-trip',409);
    const saved={...log,id:'restored_'+op.id+'_'+i,shiftId};logs.push(saved);
    if(!byTruck.has(log.truckId))byTruck.set(log.truckId,[]);byTruck.get(log.truckId).push(saved);
  }
  const truckIds=[...new Set([...archive.activeLineIds,...byTruck.keys()])];
  if(truckIds.some(id=>!validId(id)))throw fail('invalid-archive-truck',409);
  const statuses=truckIds.map(id=>{
    const last=(byTruck.get(id)||[]).slice().sort((a,b)=>a.timestamp-b.timestamp||a.id.localeCompare(b.id)).at(-1);
    const ttn=archive.ttnStatus?.[id]??null;
    return {id,shiftId,onLine:true,addedBy:actor.display_name,addedAt:now,arriveStatus:null,arriveTimestamp:null,arriveBy:null,ttnStatus:ttn,ttnBy:null,ttnLogId:ttn&&last?last.id:null,lastLoadTimestamp:last?.timestamp??null,lastLoadBy:last?.createdBy||null,lastLoadLogId:last?.id||null,cycleRevision:0,ttnRevision:0,loadedAfterArrive:false};
  });
  return {shift:{id:shiftId,objectId:archive.objectId,objectName:archive.objectName||'',startDate:archive.date,startedAt:now,startedBy:actor.display_name,startedByUid:actor.uid,isActive:true,restoredFrom:op.recordId},logs,statuses};
}
export function submitArchive(pool,uid,input,ws=WS){
  const op=normalizeArchive(input),permission=op.type==='archive.restore'?'archive_edit':'archive_delete';
  return serviceCommand(pool,uid,op,ws,(client,user)=>serviceActor(client,user,permission),async(client,actor)=>{
    const snapshot=await readArchiveEntries(client,ws),list=op.type==='trash.purge'?snapshot.trash:snapshot.archives;
    const before=list.find(row=>row.id===op.recordId);if(!before||before.revision!==op.expectedRevision)throw fail('archive-changed',409);
    let location,payload,result;
    if(op.type==='archive.trash'){
      location='trash';payload={shift:before,deletedAt:Date.now(),deletedBy:actor.display_name,deletedByUid:uid};result={id:op.recordId,location,revision:op.expectedRevision+1};
    }else if(op.type==='trash.purge'){
      location='purged';payload=before;result={id:op.recordId,location,revision:op.expectedRevision+1};
    }else{
      // Never clear a live line as a side effect of restoring an archive. The
      // existing close flow must archive and confirm its material transfer first.
      const shifts=(await client.query("SELECT shift_id FROM shifts WHERE workspace_id=$1 AND (is_active OR payload->>'closing'='true') FOR UPDATE",[ws])).rows;
      if(shifts.length)throw fail('close-current-shift-first',409);
      if((await client.query('SELECT EXISTS(SELECT 1 FROM line_logs WHERE workspace_id=$1) OR EXISTS(SELECT 1 FROM line_truck_statuses WHERE workspace_id=$1) AS found',[ws])).rows[0].found)throw fail('previous-line-data-remains',409);
      const object=(await client.query('SELECT payload FROM workspace_objects WHERE workspace_id=$1 AND object_id=$2 FOR SHARE',[ws,before.objectId])).rows[0]?.payload;
      if(!object||object.deleted||object.disabled)throw fail('object-not-available',409);
      const line=restoredLine(before,op,actor,Date.now());
      for(const status of line.statuses){const truck=(await client.query('SELECT payload FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2 FOR SHARE',[ws,status.id])).rows[0]?.payload;if(!truck||truck.deleted)throw fail('archive-truck-not-available',409);}
      await client.query('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',[ws,line.shift.id,line.shift]);
      for(const log of line.logs)await client.query('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES ($1,$2,$3,$4,$5)',[ws,log.id,line.shift.id,log.truckId,log]);
      for(const status of line.statuses)await client.query('INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES ($1,$2,$3,$4)',[ws,status.id,line.shift.id,status]);
      location='restored';payload=before;result={id:op.recordId,location,revision:op.expectedRevision+1,shift:line.shift};
    }
    await client.query('INSERT INTO archive_overrides(workspace_id,record_id,location,payload,revision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,record_id) DO UPDATE SET location=EXCLUDED.location,payload=EXCLUDED.payload,revision=EXCLUDED.revision',[ws,op.recordId,location,payload,op.expectedRevision+1]);
    return {before,after:{location,payload},result};
  });
}
