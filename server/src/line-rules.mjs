export function timeStr(ts) {
  return new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(ts));
}

export function validateLineOperation(input, now=Date.now()) {
  if (!input || typeof input!=='object' || Array.isArray(input)) return 'invalid-operation';
  for (const key of ['id','shiftId','truckId']) {
    if (typeof input[key]!=='string' || input[key].length<1 || input[key].length>128 || !/^[\w-]+$/.test(input[key])) return 'invalid-'+key;
  }
  if (!['arrive','load','ttn','reset'].includes(input.type)) return 'invalid-type';
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt<=0 || input.createdAt>now+300000) return 'invalid-createdAt';
  for(const key of ['expectedRevision','expectedTtnRevision','arrivalTimestamp','lastLoadTimestamp']){
    if (!Number.isSafeInteger(input[key]) || input[key]<0) return 'invalid-'+key;
  }
  if (typeof input.wantArrived!=='boolean' || typeof input.collect!=='boolean') return 'invalid-intent';
  if (!Number.isFinite(input.cycleMinutes) || input.cycleMinutes<15 || input.cycleMinutes>10080) return 'invalid-cycleMinutes';
  if (input.logId!=null && (typeof input.logId!=='string' || input.logId.length>512)) return 'invalid-logId';
  return null;
}

export function applyLineOperation({op, before, truck, actor, cycleMinutes=15, now=Date.now()}) {
  const revision = Number(before.cycleRevision || 0);
  const ttnRevision = Number(before.ttnRevision || 0);
  const expectedRevision = Number(op.expectedRevision);
  const expectedTtnRevision = Number(op.expectedTtnRevision);
  const gap = Math.max(15, Number(cycleMinutes) || 15, Number(op.cycleMinutes) || 15) * 60000;
  const reject = reason => ({outcome:'rejected', reason, status:before});
  if (!before.onLine || before.shiftId !== op.shiftId) return reject('truck-not-on-line');
  if (!['arrive', 'load', 'ttn', 'reset'].includes(op.type)) return reject('unsupported');
  if (op.type === 'reset') {
    if (!actor.isAdmin) return reject('permission-denied');
    if (revision !== expectedRevision || Number(before.lastLoadTimestamp||0)!==Number(op.lastLoadTimestamp||0))
      return reject('arrival-changed');
    const changes={lastLoadTimestamp:null,lastLoadBy:null,arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false,cycleRevision:revision+1,lastResetOperationId:op.id};
    return {outcome:'confirmed',status:{...before,...changes},eventTime:now,changed:true};
  }
  if (op.type === 'arrive') {
    const want = op.wantArrived !== false;
    if (revision!==expectedRevision || Number(before.arriveTimestamp||0)!==Number(op.arrivalTimestamp||0) || !!before.arriveStatus===want)
      return reject('arrival-changed');
    if (want && before.lastLoadTimestamp && op.createdAt-before.lastLoadTimestamp<gap)
      return reject('cycle-time');
    const ts=Math.max(Number(op.createdAt),Number(before.lastLoadTimestamp||0)+1);
    const changes=want?{arriveStatus:timeStr(ts),arriveTimestamp:ts,arriveBy:actor.name,loadedAfterArrive:false,cycleRevision:revision+1}:
      {arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false,cycleRevision:revision+1};
    return {outcome:'confirmed',status:{...before,...changes},eventTime:ts,changed:true};
  }
  if (op.type === 'load') {
    if (!before.arriveStatus || revision!==expectedRevision || Number(before.arriveTimestamp||0)!==Number(op.arrivalTimestamp||0))
      return reject('duplicate-or-arrival-changed');
    if (before.lastLoadTimestamp && op.createdAt-before.lastLoadTimestamp<gap)
      return reject('cycle-time');
    if (Number(op.createdAt) < Number(before.arriveTimestamp||0)) return reject('invalid-time-order');
    const ts=Math.max(Number(op.createdAt),Number(before.arriveTimestamp||0)+1,Number(before.lastLoadTimestamp||0)+1);
    const logId='load_'+op.truckId+'_'+op.shiftId+'_cycle_'+expectedRevision+'_'+Number(op.arrivalTimestamp||0);
    if (op.logId && op.logId!==logId) return reject('invalid-log-id');
    const log={id:logId,shiftId:op.shiftId,truckId:op.truckId,truckName:(String(truck.brand||'')+' '+String(truck.number||'')).trim(),
      volume:truck.isGAI?0:Number(truck.defaultVol||0),timeStr:timeStr(ts),timestamp:ts,
      arrivalTimestamp:Number(before.arriveTimestamp)||null,createdBy:actor.name,createdByEmail:actor.email,
      isGAI:!!truck.isGAI,comment:'',clientOperationId:op.id};
    const changes={lastLoadTimestamp:ts,lastLoadBy:actor.name,lastLoadLogId:logId,cycleRevision:revision+1,
      arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:true};
    if (before.ttnStatus==='pending') {changes.ttnStatus=true;changes.ttnLogId=logId;}
    return {outcome:'confirmed',status:{...before,...changes},log,eventTime:ts,changed:true};
  }
  if (ttnRevision!==expectedTtnRevision || !!before.ttnStatus===!!op.collect) return reject('ttn-changed');
  const logId=before.lastLoadLogId||null;
  const changes=op.collect?{ttnStatus:before.loadedAfterArrive&&logId?true:'pending',ttnBy:actor.name,
      ttnLogId:before.loadedAfterArrive?logId:null,ttnRevision:ttnRevision+1}:
    {ttnStatus:null,ttnBy:null,ttnLogId:null,ttnRevision:ttnRevision+1};
  return {outcome:'confirmed',status:{...before,...changes},eventTime:Number(op.createdAt),changed:true};
}
