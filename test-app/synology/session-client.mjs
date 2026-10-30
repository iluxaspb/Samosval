// TEST NAS provider. The caller owns the durable outbox and optimistic projection.
// No Firestore fallback: a lost reply must be retried with the same operation ID.
export class NasClientError extends Error {
  constructor(code, {status=0,retryable=false,uncertain=false}={}) {
    super(code); this.name='NasClientError'; Object.assign(this,{code,status,retryable,uncertain});
  }
}
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const ids=rows=>Array.isArray(rows)&&rows.every(x=>record(x)&&typeof x.id==='string'&&x.id.length>0)&&new Set(rows.map(x=>x.id)).size===rows.length;
const envelope=(x,format,workspaceId)=>record(x)&&x.format===format&&x.version===1&&x.source==='synology'&&x.workspaceId===workspaceId;
const receipt=x=>record(x)&&(['confirmed','rejected'].includes(x.outcome))&&(x.outcome==='confirmed'?record(x.status):typeof x.reason==='string');

function abortable(value,signal) {
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new NasClientError('request-aborted'));
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(value).then(result=>{signal.removeEventListener('abort',abort);resolve(result);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}

export function createNasClient({baseUrl='https://iluxa.synology.me:18443',workspaceId='main_workspace',
  getUser,fetchImpl=globalThis.fetch,timeoutMs=20000}={}) {
  let base;
  try {base=new URL(baseUrl);}catch{throw TypeError('invalid-api-url');}
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw TypeError('invalid-api-url');
  if(typeof getUser!=='function'||typeof fetchImpl!=='function'||typeof workspaceId!=='string'||!/^[\w-]{1,128}$/.test(workspaceId)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw TypeError('invalid-client-options');
  const owner=getUser();
  if(!owner||typeof owner.uid!=='string'||!owner.uid||typeof owner.getIdToken!=='function')throw new NasClientError('authentication-required');
  const uid=owner.uid, controllers=new Set(), subscriptions=new Set(); let stopped=false;
  // Large historical snapshots share one lane. Line/session reads and writes
  // never queue behind this lane; a queued job's request timeout starts on dispatch.
  let backgroundTail=Promise.resolve();const backgroundReads=new Map(),readCache=new Map();
  const clone=x=>typeof structuredClone==='function'?structuredClone(x):JSON.parse(JSON.stringify(x));
  // Origin, workspace and UID are inseparable from caches and outbox entries.
  const epochKey='samosval_nas_dataset_epoch:'+JSON.stringify([base.origin,workspaceId,uid]);
  let datasetEpoch=0;try{datasetEpoch=Number(globalThis.localStorage?.getItem(epochKey)||0)||0;}catch{}
  const scope=JSON.stringify(['synology',base.origin,workspaceId,uid,...(datasetEpoch?[datasetEpoch]:[])]);
  function checkEpoch(response){const raw=response.headers?.get?.('X-Samosval-Epoch');if(raw==null||!/^\d+$/.test(raw)||Number(raw)===datasetEpoch)return;
    try{globalThis.localStorage?.setItem(epochKey,raw);}catch{}
    stopped=true;for(const close of subscriptions)close();
    if(globalThis.location?.reload)setTimeout(()=>globalThis.location.reload(),50);
    throw new NasClientError('dataset-restored-reload',{status:409});
  }
  function guard(){if(stopped||getUser()!==owner||owner.uid!==uid)throw new NasClientError('session-changed');}
  function backgroundRequest(path,options){
    guard();const existing=backgroundReads.get(path);if(existing)return existing;
    const work=backgroundTail.then(()=>request(path,options));
    backgroundTail=work.catch(()=>{});
    const tracked=work.finally(()=>{if(backgroundReads.get(path)===tracked)backgroundReads.delete(path);});
    backgroundReads.set(path,tracked);return tracked;
  }
  async function request(path,{operation,validate}={}) {
    guard();
    const write=operation!==undefined;
    // Capture before awaiting credentials. Never regenerate an ID on retry.
    const body=write?JSON.stringify(operation):undefined;
    const controller=new AbortController(); controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    let phase='credentials',httpStatus=0,responseType='';
    const invalidResponse=problem=>{
      const error=new NasClientError('invalid-api-response',{status:httpStatus,retryable:true,uncertain:write});
      error.phase=phase;error.problem=problem;
      // Only bounded protocol metadata is logged. Never include response bytes,
      // URLs, authentication headers, user data or an upstream error message.
      error.message+=': '+problem+' (HTTP '+httpStatus+(responseType?', '+responseType:'')+')';return error;
    };
    try {
      for(let attempt=0;attempt<2;attempt++) {
        guard();phase='credentials';
        let token;
        try {token=await abortable(owner.getIdToken(attempt===1),controller.signal);}
        catch(error){guard();if(controller.signal.aborted)throw error;throw new NasClientError('authentication-unavailable',{retryable:true});}
        guard();
        if(typeof token!=='string'||!token)throw new NasClientError('authentication-required');
        const previous=write?null:readCache.get(path);
        phase='response-headers';
        const response=await abortable(fetchImpl(base.origin+path,{method:write?'POST':'GET',
          headers:write?{'X-Samosval-Epoch':String(datasetEpoch),Authorization:'Bearer '+token,'Content-Type':'application/json'}:{Authorization:'Bearer '+token,...(previous?{'If-None-Match':previous.etag}:{})},
          ...(write?{body}:{}),signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'}),controller.signal);
        guard();checkEpoch(response);httpStatus=response.status;
        if(response.status===401&&attempt===0)continue;
        if(response.status===304){
          if(!previous||write)throw invalidResponse('unexpected-not-modified');
          return clone(previous.data);
        }
        if(!response.ok){const retryable=[408,425,429].includes(response.status)||response.status>=500;
          throw new NasClientError('api-http-'+response.status,{status:response.status,retryable,uncertain:write&&retryable});}
        const mime=String(response.headers?.get?.('Content-Type')||'').split(';')[0].trim().toLowerCase();
        responseType=['application/json','text/html','text/plain'].includes(mime)?mime:mime?'other':'';
        phase='response-body';
        if(mime&&!/^application\/(?:json|[a-z0-9.+-]+\+json)$/.test(mime))throw invalidResponse('unexpected-content-type');
        let data;
        try {data=await abortable(response.json(),controller.signal);}catch(error){guard();if(controller.signal.aborted)throw error;throw invalidResponse('invalid-json');}
        guard();
        phase='response-schema';
        if(!validate(data))throw invalidResponse('invalid-envelope');
        const etag=response.headers?.get?.('ETag');
        if(!write&&typeof etag==='string'&&/^"[a-f0-9]{64}"$/.test(etag))readCache.set(path,{etag,data:clone(data)});
        return data;
      }
    }catch(error){
      guard();
      if(controller.signal.aborted){const timeout=new NasClientError('api-timeout',{retryable:true,uncertain:write});timeout.phase=phase;timeout.message+=': '+phase;throw timeout;}
      if(error instanceof NasClientError)throw error;
      const failure=new NasClientError('api-unreachable',{retryable:true,uncertain:write});
      const detail=['Failed to fetch','Illegal invocation','Load failed'].includes(error?.message)?error.message:error?.name||'network-error';
      failure.message+=': '+detail;throw failure;
    }finally{clearTimeout(timer);controllers.delete(controller);}
  }
  const readSession=()=>request('/api/v1/session',{validate:x=>envelope(x,'samosval-session',workspaceId)&&typeof x.identityReady==='boolean'&&
    (x.profile===null||record(x.profile)&&x.profile.uid===uid&&['pending','active','disabled'].includes(x.profile.status)&&typeof x.profile.role==='string'&&typeof x.profile.deleted==='boolean')&&
    record(x.permissions)&&Array.isArray(x.permissions.tabs)&&x.permissions.tabs.every(t=>typeof t==='string')&&Array.isArray(x.permissions.actions)&&x.permissions.actions.every(a=>typeof a==='string')});
  const readLine=()=>request('/api/v1/line/snapshot',{validate:x=>envelope(x,'samosval-line-snapshot',workspaceId)&&ids(x.trucks)&&ids(x.statuses)&&ids(x.logs)&&
    Number.isInteger(x.cycleMinutes)&&x.cycleMinutes>=15&&x.cycleMinutes<=10080&&
    (x.shift===null?x.statuses.length===0&&x.logs.length===0:record(x.shift)&&typeof x.shift.id==='string'&&x.shift.id.length>0&&(x.shift.isActive===true||x.shift.isActive===false&&x.shift.closing===true)&&
      x.statuses.every(s=>s.shiftId===x.shift.id)&&x.logs.every(l=>l.shiftId===x.shift.id&&typeof l.truckId==='string'))});
  const readArchive=()=>backgroundRequest('/api/v1/archive/snapshot',{validate:x=>envelope(x,'samosval-archive-snapshot',workspaceId)&&Number.isFinite(x.importedAt)&&ids(x.archives)&&ids(x.trash)});
  const readHistory=()=>request('/api/v1/history',{validate:x=>record(x)&&x.format==='samosval-line-history'&&x.version===1&&x.source==='synology'&&ids(x.items)});
  const readCatalog=()=>request('/api/v1/catalog',{validate:x=>envelope(x,'samosval-catalog',workspaceId)&&ids(x.trucks)&&ids(x.objects)&&[...x.trucks,...x.objects].every(r=>record(r.data)&&Number.isSafeInteger(r.revision)&&r.revision>0)});
  const readMembers=()=>request('/api/v1/members',{validate:x=>record(x)&&x.format==='samosval-members'&&x.version===1&&x.source==='synology'&&Array.isArray(x.members)&&x.members.every(m=>record(m)&&typeof m.uid==='string'&&typeof m.nickname==='string')});
  const readAuxiliary=()=>backgroundRequest('/api/v1/auxiliary',{validate:x=>envelope(x,'samosval-auxiliary',workspaceId)&&['plugins','patches','audit','notifications'].every(k=>ids(x[k]))});
  async function submitAuxiliary(operation,{operationScope}={}){
    const op=scopedOperation(operation,operationScope);
    return request('/api/v1/auxiliary',{operation:op,validate:x=>record(x)&&x.outcome==='confirmed'&&x.operationId===op.id&&x.type===op.type&&(op.type==='backup.import'?x.result?.written===op.items.length:x.result?.id===op.recordId&&x.result.revision===op.expectedRevision+1)});
  }
  const readSettings=()=>request('/api/v1/settings',{validate:x=>envelope(x,'samosval-settings',workspaceId)&&record(x.data)&&Number.isSafeInteger(x.revision)&&x.revision>0});
  const readGames=()=>backgroundRequest('/api/v1/games',{validate:x=>envelope(x,'samosval-games',workspaceId)&&ids(x.records)&&ids(x.adjustments)&&record(x.head)&&Number.isSafeInteger(x.head.gameRound)&&x.head.gameRound>=0&&Number.isSafeInteger(x.head.bank)&&x.head.bank>=0&&record(x.players)});
  const presenceEnvelope=x=>envelope(x,'samosval-tabel-presence',workspaceId);
  const readPresence=({objectId,sheetId})=>request('/api/v1/tabel/presence?'+new URLSearchParams({objectId,sheetId}),{validate:x=>presenceEnvelope(x)&&Array.isArray(x.peers)&&x.peers.every(p=>record(p)&&p.uid!==uid&&typeof p.uid==='string'&&typeof p.name==='string'&&p.objectId===objectId&&p.sheetId===sheetId&&Number.isFinite(p.seen)&&(p.selection===null||record(p.selection)))});
  const writePresence=({sessionId,sequence,objectId,sheetId,selection})=>request('/api/v1/tabel/presence',{operation:{type:'write',sessionId,sequence,objectId,sheetId,selection},validate:x=>presenceEnvelope(x)&&(x.ignored===true||record(x.record)&&x.record.uid===uid&&x.record.sessionId===sessionId&&x.record.objectId===objectId&&x.record.sheetId===sheetId&&x.record.sequence===sequence)});
  const removePresence=({sessionId,sequence})=>request('/api/v1/tabel/presence',{operation:{type:'remove',sessionId,sequence},validate:x=>presenceEnvelope(x)&&(x.removed===true||x.ignored===true)});
  function scopedOperation(operation,operationScope){guard();if(operationScope!==scope)throw new NasClientError('outbox-scope-mismatch');if(!record(operation)||typeof operation.id!=='string'||!operation.id)throw new NasClientError('operation-id-required');return JSON.parse(JSON.stringify(operation));}
  async function submitSettings(operation,{operationScope}={}){
    const op=scopedOperation(operation,operationScope);
    return request('/api/v1/settings',{operation:op,validate:x=>record(x)&&x.outcome==='confirmed'&&x.operationId===op.id&&x.type===op.type&&record(x.result?.data)&&x.result.revision===op.expectedRevision+1});
  }
  const readNotifications=()=>request('/api/v1/notifications',{validate:x=>envelope(x,'samosval-notification-status',workspaceId)&&record(x.counts)});
  async function submitNotificationTest(operation,{operationScope}={}){const op=scopedOperation(operation,operationScope);return request('/api/v1/notifications',{operation:op,validate:x=>record(x)&&x.outcome==='confirmed'&&x.operationId===op.id&&x.result?.queued===true});}
  const readBackups=(id)=>request('/api/v1/backups'+(id?'?'+new URLSearchParams({id}):''),{validate:x=>envelope(x,'samosval-backups',workspaceId)&&(id?record(x.meta)&&record(x.payload):ids(x.items))});
  async function submitBackup(operation,{operationScope}={}){const op=scopedOperation(operation,operationScope);return request('/api/v1/backups',{operation:op,validate:x=>record(x)&&x.outcome==='confirmed'&&x.operationId===op.id&&x.type===op.type&&record(x.result)});}
  async function submitReport(operation,{operationScope}={}){
    const op=scopedOperation(operation,operationScope);
    return request('/api/v1/report/operations',{operation:op,validate:x=>record(x)&&x.outcome==='confirmed'&&x.operationId===op.id&&x.type===op.type&&x.result?.id===op.logId});
  }
  async function submitArchive(operation,{operationScope}={}){
    const op=scopedOperation(operation,operationScope);
    return request('/api/v1/archive/operations',{operation:op,validate:x=>record(x)&&x.outcome==='confirmed'&&x.operationId===op.id&&x.type===op.type&&x.result?.id===op.recordId&&x.result.revision===op.expectedRevision+1&&x.result.location===({'archive.trash':'trash','archive.restore':'restored','trash.purge':'purged'}[op.type])});
  }
  async function submitGame(operation,{operationScope}={}){
    const op=scopedOperation(operation,operationScope);
    return request('/api/v1/games',{operation:op,validate:x=>record(x)&&x.outcome==='confirmed'&&x.operationId===op.id&&x.type===op.type&&record(x.result)&&(op.type==='game.grant'?x.result.targetUid===op.targetUid&&x.result.amount===op.amount:x.result.noop===true||Number.isSafeInteger(x.result.round)&&record(x.result.confirmedHead))});
  }
  async function submitControl(operation,{operationScope}={}){
    const op=scopedOperation(operation,operationScope);
    return request('/api/v1/controls',{operation:op,validate:x=>record(x)&&x.outcome==='confirmed'&&x.operationId===op.id&&x.type===op.type&&record(x.result)&&(!op.recordId||x.result.id===op.recordId)});
  }
  async function startShift(operation,{operationScope}={}){
    const op=scopedOperation(operation,operationScope);
    return request('/api/v1/shifts/start',{operation:op,validate:x=>record(x)&&x.outcome==='confirmed'&&record(x.shift)&&x.shift.id==='shift_'+op.id&&x.shift.objectId===op.objectId&&x.shift.isActive===true});
  }
  async function closeShift(operation,{operationScope}={}){
    const op=scopedOperation(operation,operationScope),phase=op.type==='prepare'?'awaiting-material':'closed';
    return request('/api/v1/shifts/close',{operation:op,validate:x=>record(x)&&x.outcome==='confirmed'&&x.phase===phase&&record(x.shift)&&x.shift.id===op.shiftId&&x.shift.isActive===false&&
      (op.type!=='prepare'||x.archive===null||record(x.archive)&&x.archive.sourceShiftId===op.shiftId)});
  }
  const profiles=rows=>Array.isArray(rows)&&rows.every(x=>record(x)&&typeof x.uid==='string'&&x.uid&&Number.isSafeInteger(x.revision)&&x.revision>0)&&new Set(rows.map(x=>x.uid)).size===rows.length;
  const readAdministration=()=>request('/api/v1/admin/access',{validate:x=>record(x)&&x.format==='samosval-admin-access'&&x.version===1&&x.source==='synology'&&profiles(x.users)&&profiles(x.deletedUsers)&&Array.isArray(x.requests)&&x.requests.every(r=>record(r)&&typeof r.uid==='string'&&Number.isSafeInteger(r.revision)&&r.revision>=0)&&record(x.permissions)&&Object.values(x.permissions).every(p=>record(p)&&Array.isArray(p.tabs)&&Array.isArray(p.actions)&&Number.isSafeInteger(p.revision)&&p.revision>0)});
  const registerPending=({nickname}={})=>request('/api/v1/registration',{operation:nickname===undefined?{}:{nickname},validate:x=>record(x)&&typeof x.created==='boolean'&&record(x.profile)&&x.profile.uid===uid&&['pending','active','disabled'].includes(x.profile.status)});
  async function submitAdministration(operation,{operationScope}={}) {
    guard();if(operationScope!==scope)throw new NasClientError('outbox-scope-mismatch');
    if(!record(operation)||typeof operation.id!=='string'||!operation.id||typeof operation.type!=='string')throw new NasClientError('invalid-admin-operation');
    const captured=JSON.parse(JSON.stringify(operation));
    return request('/api/v1/admin/access',{operation:captured,validate:x=>record(x)&&x.outcome==='confirmed'&&x.operationId===captured.id&&record(x.result)&&
      (captured.type==='permissions.replace'?x.result.role===captured.role:x.result.uid===captured.uid)});
  }
  async function submitLine(operation,{operationScope}={}) {
    guard();
    if(operationScope!==scope)throw new NasClientError('outbox-scope-mismatch');
    if(!record(operation)||typeof operation.id!=='string'||!operation.id||!['arrive','load','ttn','reset'].includes(operation.type))throw new NasClientError('invalid-line-operation');
    return request('/api/v1/line/operations',{operation,validate:receipt});
  }
  async function submitHistory(operation,{operationScope}={}) {
    guard();
    if(operationScope!==scope)throw new NasClientError('outbox-scope-mismatch');
    if(!record(operation)||typeof operation.id!=='string'||!operation.id||typeof operation.actionId!=='string'||!operation.actionId||!['undo','redo'].includes(operation.direction)||!Number.isSafeInteger(operation.expectedRevision)||operation.expectedRevision<1)throw new NasClientError('invalid-history-operation');
    const captured={id:operation.id,actionId:operation.actionId,direction:operation.direction,expectedRevision:operation.expectedRevision};
    return request('/api/v1/history',{operation:captured,validate:x=>record(x)&&x.outcome==='confirmed'&&x.actionId===captured.actionId&&x.direction===captured.direction&&Number.isSafeInteger(x.revision)&&x.revision>captured.expectedRevision&&record(x.status)});
  }
  function subscribeLine({onSession,onSnapshot,onError,intervalMs=4000}={}) {
    guard();
    if(![onSession,onSnapshot,onError].every(f=>typeof f==='function')||!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>60000)throw TypeError('invalid-subscription-options');
    let closed=false,timer;
    const close=()=>{closed=true;clearTimeout(timer);subscriptions.delete(close);}; subscriptions.add(close);
    async function tick(){
      try {
        const session=await readSession(); if(closed)return;
        onSession(session); guard(); if(closed)return;
        // Publish profile changes even when line access has just been revoked.
        if(session.identityReady&&session.profile?.status==='active'&&!session.profile.deleted&&session.permissions.tabs.includes('line')){
          const line=await readLine(); guard();if(!closed)onSnapshot(line);
        }
      }catch(error){if(closed)return;onError(error);if(error.code==='session-changed'){close();return;}}
      finally{if(!closed)timer=setTimeout(tick,intervalMs);}
    }
    void tick();return close;
  }
  function stop(){stopped=true;readCache.clear();for(const close of subscriptions)close();for(const controller of controllers)controller.abort();}
  return Object.freeze({scope,datasetEpoch,uid,workspaceId,readBackups,submitBackup,readNotifications,submitNotificationTest,readSession,readLine,readArchive,submitArchive,submitReport,readHistory,readCatalog,readMembers,readAuxiliary,submitAuxiliary,readSettings,submitSettings,readGames,submitGame,readPresence,writePresence,removePresence,submitControl,startShift,closeShift,readAdministration,registerPending,submitAdministration,submitLine,submitHistory,subscribeLine,stop});
}
