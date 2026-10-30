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
  getUser,fetchImpl=globalThis.fetch,timeoutMs=10000}={}) {
  let base;
  try {base=new URL(baseUrl);}catch{throw TypeError('invalid-api-url');}
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw TypeError('invalid-api-url');
  if(typeof getUser!=='function'||typeof fetchImpl!=='function'||typeof workspaceId!=='string'||!/^[\w-]{1,128}$/.test(workspaceId)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw TypeError('invalid-client-options');
  const owner=getUser();
  if(!owner||typeof owner.uid!=='string'||!owner.uid||typeof owner.getIdToken!=='function')throw new NasClientError('authentication-required');
  const uid=owner.uid, controllers=new Set(), subscriptions=new Set(); let stopped=false;
  // Origin, workspace and UID are inseparable from caches and outbox entries.
  const scope=JSON.stringify(['synology',base.origin,workspaceId,uid]);
  function guard(){if(stopped||getUser()!==owner||owner.uid!==uid)throw new NasClientError('session-changed');}
  async function request(path,{operation,validate}={}) {
    guard();
    const write=operation!==undefined;
    // Capture before awaiting credentials. Never regenerate an ID on retry.
    const body=write?JSON.stringify(operation):undefined;
    const controller=new AbortController(); controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      for(let attempt=0;attempt<2;attempt++) {
        guard();
        let token;
        try {token=await abortable(owner.getIdToken(attempt===1),controller.signal);}
        catch(error){guard();if(controller.signal.aborted)throw error;throw new NasClientError('authentication-unavailable',{retryable:true});}
        guard();
        if(typeof token!=='string'||!token)throw new NasClientError('authentication-required');
        const response=await abortable(fetchImpl(base.origin+path,{method:write?'POST':'GET',
          headers:write?{Authorization:'Bearer '+token,'Content-Type':'application/json'}:{Authorization:'Bearer '+token},
          ...(write?{body}:{}),signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'}),controller.signal);
        guard();
        if(response.status===401&&attempt===0)continue;
        if(!response.ok){const retryable=[408,425,429].includes(response.status)||response.status>=500;
          throw new NasClientError('api-http-'+response.status,{status:response.status,retryable,uncertain:write&&retryable});}
        let data;
        try {data=await abortable(response.json(),controller.signal);}catch(error){guard();if(controller.signal.aborted)throw error;throw new NasClientError('invalid-api-response',{retryable:true,uncertain:write});}
        guard();
        if(!validate(data))throw new NasClientError('invalid-api-response',{retryable:true,uncertain:write});
        return data;
      }
    }catch(error){
      guard();
      if(controller.signal.aborted)throw new NasClientError('api-timeout',{retryable:true,uncertain:write});
      if(error instanceof NasClientError)throw error;
      throw new NasClientError('api-unreachable',{retryable:true,uncertain:write});
    }finally{clearTimeout(timer);controllers.delete(controller);}
  }
  const readSession=()=>request('/api/v1/session',{validate:x=>envelope(x,'samosval-session',workspaceId)&&typeof x.identityReady==='boolean'&&
    (x.profile===null||record(x.profile)&&x.profile.uid===uid&&['pending','active','disabled'].includes(x.profile.status)&&typeof x.profile.role==='string'&&typeof x.profile.deleted==='boolean')&&
    record(x.permissions)&&Array.isArray(x.permissions.tabs)&&x.permissions.tabs.every(t=>typeof t==='string')&&Array.isArray(x.permissions.actions)&&x.permissions.actions.every(a=>typeof a==='string')});
  const readLine=()=>request('/api/v1/line/snapshot',{validate:x=>envelope(x,'samosval-line-snapshot',workspaceId)&&ids(x.trucks)&&ids(x.statuses)&&ids(x.logs)&&
    Number.isInteger(x.cycleMinutes)&&x.cycleMinutes>=15&&x.cycleMinutes<=10080&&
    (x.shift===null?x.statuses.length===0&&x.logs.length===0:record(x.shift)&&typeof x.shift.id==='string'&&x.shift.id.length>0&&x.shift.isActive===true&&
      x.statuses.every(s=>s.shiftId===x.shift.id)&&x.logs.every(l=>l.shiftId===x.shift.id&&typeof l.truckId==='string'))});
  const readArchive=()=>request('/api/v1/archive/snapshot',{validate:x=>envelope(x,'samosval-archive-snapshot',workspaceId)&&Number.isFinite(x.importedAt)&&ids(x.archives)&&ids(x.trash)});
  const readHistory=()=>request('/api/v1/history',{validate:x=>record(x)&&x.format==='samosval-line-history'&&x.version===1&&x.source==='synology'&&ids(x.items)});
  const readCatalog=()=>request('/api/v1/catalog',{validate:x=>envelope(x,'samosval-catalog',workspaceId)&&ids(x.trucks)&&ids(x.objects)});
  const readMembers=()=>request('/api/v1/members',{validate:x=>record(x)&&x.format==='samosval-members'&&x.version===1&&x.source==='synology'&&Array.isArray(x.members)&&x.members.every(m=>record(m)&&typeof m.uid==='string'&&typeof m.nickname==='string')});
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
  function stop(){stopped=true;for(const close of subscriptions)close();for(const controller of controllers)controller.abort();}
  return Object.freeze({scope,uid,workspaceId,readSession,readLine,readArchive,readHistory,readCatalog,readMembers,readAdministration,registerPending,submitAdministration,submitLine,submitHistory,subscribeLine,stop});
}
