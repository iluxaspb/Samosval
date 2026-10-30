// The game calculator uses history facts, not report HTML, photos, spreadsheets
// or full directory snapshots. Keep every fact it reads, including undo scope.
const fields={
  logs:['id','shiftId','truckId','timestamp','createdByEmail','createdBy','clientOperationId'],
  truckStatus:['shiftId','arriveTimestamp','lastLoadTimestamp','lastResetOperationId','ttnStatus','ttnRevision'],
  shift:['id','objectId','objectName'],
  archive:['sourceShiftId'],
};
const pick=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]])):value;
export function gameTransferRecord(record){
  if(!record?.history||!Array.isArray(record.history.operations))return record;
  const operations=record.history.operations.filter(op=>Object.hasOwn(fields,op.collection)).map(op=>{
    const result={collection:op.collection,id:op.id};
    for(const side of ['before','after'])if(Object.hasOwn(op,side)){
      result[side]=pick(op[side],fields[op.collection]);
      if(op.collection==='archive'&&Array.isArray(op[side]?.logs))result[side]={...result[side],logs:op[side].logs.map(log=>pick(log,fields.logs))};
    }
    return result;
  });
  return {...record,history:{...record.history,operations}};
}
