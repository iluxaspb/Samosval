// Isolated TEST-only NAS <-> Firebase LINE router. Never enabled by a stored
// preference: the host must explicitly supply a dedicated reserve HTTPS URL.
// Routing is authorized by the independent Firestore ownership coordinator,
// never by a failed NAS request or the phone's local connection indicator.
export class AutoLineError extends Error {
  constructor(code,{status=0,retryable=false,uncertain=false}={}){
    super(code);this.name='AutoLineError';Object.assign(this,{code,status,retryable,uncertain});
  }
}
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const error=(code,options)=>new AutoLineError(code,options);
const positive=x=>Number.isSafeInteger(x)&&x>0;
const validLine=x=>object(x)&&x.format==='samosval-line-snapshot'&&x.version===1&&
  x.source==='firebase'&&x.workspaceId==='main_workspace'&&
  Array.isArray(x.trucks)&&Array.isArray(x.statuses)&&Array.isArray(x.logs)&&
  Number.isSafeInteger(x.cycleMinutes)&&x.cycleMinutes>0&&
  (x.shift===null||object(x.shift)&&typeof x.shift.id==='string');
const validSession=(x,uid)=>object(x)&&x.format==='samosval-session'&&x.version===1&&
  x.source==='firebase'&&x.workspaceId==='main_workspace'&&
  typeof x.identityReady==='boolean'&&(x.profile===null||
  object(x.profile)&&x.profile.uid===uid&&['active','pending','disabled'].includes(x.profile.status)&&
  typeof x.profile.deleted==='boolean')&&object(x.permissions)&&
  Array.isArray(x.permissions.tabs)&&Array.isArray(x.permissions.actions);
const validReceipt=x=>object(x)&&['confirmed','rejected'].includes(x.outcome)&&
  (x.outcome==='confirmed'?object(x.status):typeof x.reason==='string');
const validOwner=(x,now)=>object(x)&&x.format==='samosval-owner-status'&&
  x.version===1&&x.projectId==='samosval-offline'&&
  ['synology','firebase','reconciling','handoff'].includes(x.owner)&&
  positive(x.epoch)&&typeof x.generation==='string'&&/^[0-9a-f]{24}$/.test(x.generation)&&
  Number.isSafeInteger(x.confirmedSequence)&&x.confirmedSequence>=0&&
  Number.isSafeInteger(x.reserveSequence)&&x.reserveSequence>=0&&
  typeof x.readyForFailover==='boolean'&&
  Number.isSafeInteger(x.checkedAt)&&x.checkedAt>now-45000&&x.checkedAt<=now+10000;

export function createTestAutoLineClient({nasClient,reserveBaseUrl,getUser,
  fetchImpl=globalThis.fetch,clock=Date.now,timeoutMs=15000,
  onProviderChange=()=>{}}={}){
  if(!nasClient||typeof nasClient.readLine!=='function'||typeof nasClient.readSession!=='function'||
    typeof nasClient.submitLine!=='function'||typeof nasClient.stop!=='function'||
    !nasClient.scope||!nasClient.uid||nasClient.workspaceId!=='main_workspace'||
    typeof getUser!=='function'||typeof fetchImpl!=='function'||typeof clock!=='function'||
    typeof onProviderChange!=='function'||!Number.isSafeInteger(timeoutMs)||
    timeoutMs<1000||timeoutMs>120000)throw TypeError('invalid-auto-line-options');
  let url;
  try{url=new URL(reserveBaseUrl);}catch{throw TypeError('invalid-reserve-url');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||
    url.pathname!=='/'||url.origin==='https://iluxa.synology.me:18443')
    throw TypeError('invalid-reserve-url');
  const base=url.origin,uid=nasClient.uid,owner=getUser(),controllers=new Set(),subs=new Set();
  if(!owner||owner.uid!==uid||typeof owner.getIdToken!=='function')
    throw error('authentication-required');
  let stopped=false,provider=null;
  function guard(){
    if(stopped||getUser()!==owner||owner.uid!==uid)throw error('session-changed');
  }
  function publish(next){
    if(provider!==next){provider=next;onProviderChange(next);}
  }
  async function request(path,{method='GET',body,epoch,check}={}){
    guard();
    const write=method==='POST',controller=new AbortController();
    controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      for(let attempt=0;attempt<2;attempt++){
        guard();
        let token;
        try{token=await owner.getIdToken(attempt===1);}
        catch{throw error('authentication-unavailable',{retryable:true});}
        guard();
        if(typeof token!=='string'||!token)throw error('authentication-required');
        const headers={Authorization:'Bearer '+token};
        if(write){
          headers['Content-Type']='application/json';
          headers['X-Samosval-Writer-Epoch']=String(epoch);
        }
        let response;
        try{
          response=await fetchImpl(base+path,{method,headers,...(write?{body}:{}),
            signal:controller.signal,credentials:'omit',redirect:'error',
            cache:'no-store',referrerPolicy:'no-referrer'});
        }catch{
          throw error(controller.signal.aborted?'reserve-timeout':'reserve-unreachable',
            {retryable:true,uncertain:write});
        }
        guard();
        if(response.status===401&&attempt===0)continue;
        if(!response.ok){
          const status=response.status;
          const retryable=[408,425,429].includes(status)||status>=500;
          throw error('reserve-http-'+status,{status,retryable,uncertain:write&&retryable});
        }
        const mime=String(response.headers?.get?.('Content-Type')||'');
        if(mime&&!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(mime))
          throw error('reserve-invalid-response',{retryable:true,uncertain:write});
        let value;
        try{value=await response.json();}
        catch{throw error('reserve-invalid-response',{retryable:true,uncertain:write});}
        guard();
        if(!check(value))throw error('reserve-invalid-response',{retryable:true,uncertain:write});
        return value;
      }
      throw error('authentication-required');
    }finally{clearTimeout(timer);controllers.delete(controller);}
  }
  async function authority(){
    const result=await request('/api/v1/owner/status',{check:x=>validOwner(x,clock())});
    if(['handoff','reconciling'].includes(result.owner))
      throw error('writer-handoff-in-progress',{retryable:true});
    if(result.owner==='firebase'&&!result.readyForFailover)
      throw error('reserve-not-ready',{retryable:true});
    // A NAS timeout never triggers promotion. Only the coordinator can.
    if(result.owner==='synology'&&result.readyForFailover)
      throw error('writer-inconsistent-status',{retryable:true});
    return result;
  }
  const same=(a,b)=>a.owner===b.owner&&a.epoch===b.epoch&&a.generation===b.generation;
  async function sourceRead(kind,state){
    if(state.owner==='synology')return nasClient[kind]();
    return request(kind==='readLine'?'/api/v1/line/snapshot':'/api/v1/session',
      {check:kind==='readLine'?validLine:x=>validSession(x,uid)});
  }
  async function readSession(){
    const state=await authority(),value=await sourceRead('readSession',state);
    guard();publish(state.owner);return value;
  }
  async function readLine(){
    const state=await authority(),value=await sourceRead('readLine',state);
    guard();publish(state.owner);return value;
  }
  async function submitLine(operation,{operationScope}={}){
    guard();
    if(operationScope!==nasClient.scope)throw error('outbox-scope-mismatch');
    if(!object(operation)||typeof operation.id!=='string'||!operation.id||
      !['arrive','load','ttn','reset'].includes(operation.type))
      throw error('invalid-line-operation');
    const captured=JSON.stringify(operation); // Same bytes and operation ID on retry.
    const state=await authority();
    let result;
    if(state.owner==='synology')result=await nasClient.submitLine(JSON.parse(captured),{operationScope});
    else result=await request('/api/v1/line/operations',{method:'POST',body:captured,
      epoch:state.epoch,check:validReceipt});
    guard();publish(state.owner);return result;
  }
  function subscribeLine({onSession,onSnapshot,onError,intervalMs=4000}={}){
    guard();
    if(![onSession,onSnapshot,onError].every(f=>typeof f==='function')||
      !Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>60000)
      throw TypeError('invalid-subscription-options');
    let closed=false,timer;
    const close=()=>{closed=true;clearTimeout(timer);subs.delete(close);};
    subs.add(close);
    async function tick(){
      try{
        guard();
        const before=await authority();
        const session=await sourceRead('readSession',before);
        let line=null;
        if(session.identityReady&&session.profile?.status==='active'&&!session.profile.deleted&&
          session.permissions.tabs.includes('line'))line=await sourceRead('readLine',before);
        const after=await authority();
        guard();
        if(closed)return;
        if(!same(before,after))throw error('writer-changed-during-read',{retryable:true});
        publish(before.owner);
        onSession(session);
        if(line&&!closed)onSnapshot(line);
      }catch(e){
        if(!closed){onError(e);if(e.code==='session-changed'){close();return;}}
      }finally{if(!closed)timer=setTimeout(tick,intervalMs);}
    }
    void tick();
    return close;
  }
  const client={...nasClient,readSession,readLine,submitLine,subscribeLine,
    stop(){stopped=true;for(const close of subs)close();for(const c of controllers)c.abort();nasClient.stop();}};
  // Do not allow unsupported reserve writes/reads to fall back to an obsolete
  // NAS dataset while Firestore is the owner.
  for(const [name,method] of Object.entries(nasClient)){
    if(typeof method!=='function'||['readSession','readLine','submitLine','subscribeLine','stop'].includes(name))continue;
    client[name]=async(...args)=>{
      const state=await authority();
      if(state.owner!=='synology')throw error('reserve-unsupported-operation',{retryable:true});
      return method(...args);
    };
  }
  Object.defineProperty(client,'activeProvider',{enumerable:true,get:()=>provider});
  return Object.freeze(client);
}
