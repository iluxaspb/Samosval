// TEST PWA emergency upload preparation. No backend switch is performed here.
// Source-scope and original operation IDs survive retries; cloud documents
// stay UNCONFIRMED until a trusted recovery coordinator reconciles them.
const validId=x=>typeof x==='string'&&x.length>0&&x.length<=160&&!x.includes('/');
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const canonical=x=>JSON.stringify(normalize(x));
function normalize(x){
  if(Array.isArray(x))return x.map(normalize);
  if(x&&typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype)
    return Object.fromEntries(Object.keys(x).sort().map(k=>[k,normalize(x[k])]));
  if(x===null||typeof x==='string'||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x))return x;
  throw Error('invalid-emergency-operation');
}
export const DEVICE_STAGING_MAX_BYTES=700000;
export function makeEmergencyDeviceEnvelope({session,scope,head,operations,maxBytes=DEVICE_STAGING_MAX_BYTES}={}){
  if(!session||!validId(session.uid)||session.status!=='active'||
     scope?.projectId!=='samosval-offline'||scope.workspaceId!=='main_workspace'||
     !validId(scope.objectId)||!validId(scope.shiftId)||
     !head||!Number.isSafeInteger(head.sequence)||head.sequence<0||!digest(head.hash)||
     !Array.isArray(operations)||!operations.length||
     !Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>DEVICE_STAGING_MAX_BYTES)
    throw Error('invalid-emergency-staging-scope');
  const unique=new Set();
  const entries=operations.map(op=>{
    if(!op||!validId(op.id)||unique.has(op.id)||op.uid!==session.uid||
       op.provider!=='synology'||op.projectId!==scope.projectId||
       op.workspaceId!==scope.workspaceId||op.objectId!==scope.objectId||
       op.shiftId!==scope.shiftId||!op.body||typeof op.body!=='object'||Array.isArray(op.body))
      throw Error('invalid-emergency-operation');
    unique.add(op.id);
    return op;
  });
  const envelope={format:'samosval-emergency-device-staging',version:1,
    ...scope,uid:session.uid,observedNasHead:head,
    status:'unconfirmed',operations:entries};
  if(new TextEncoder().encode(canonical(envelope)).byteLength>maxBytes)
    throw Error('emergency-staging-too-large');
  return envelope;
}
// Inject a Firebase staging adapter guarded by Auth+Rules, not a Firestore
// business-data writer. Upload only on confirmed failure and allow no promotion.
export function createEmergencyDeviceStager({getSession,stageImmutable,readBack,
  hashBytes=async bytes=>{
    const digestBytes=await globalThis.crypto.subtle.digest('SHA-256',bytes);
    return [...new Uint8Array(digestBytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }}={}){
  if(![getSession,stageImmutable,readBack,hashBytes].every(f=>typeof f==='function'))
    throw TypeError('invalid-emergency-device-stager');
  let busy=false;
  return Object.freeze({
    get busy(){return busy;},
    async upload({scope,head,operations,nasUnavailable=false}={}){
      if(!nasUnavailable)return {status:'nas-not-confirmed-down',writes:0};
      if(busy)return {status:'busy',writes:0};
      busy=true;
      try{
        const owner=getSession();
        const envelope=makeEmergencyDeviceEnvelope({session:owner,scope,head,operations});
        const bytes=new TextEncoder().encode(canonical(envelope));
        const id=await hashBytes(bytes);
        if(!digest(id))throw Error('invalid-staging-id');
        const current=getSession();
        if(current?.uid!==owner.uid||current?.generation!==owner.generation||current.status!=='active')
          throw Error('emergency-session-changed');
        await stageImmutable({id,envelope}); // create only, same ID = same bytes
        const saved=await readBack(id);
        if(canonical(saved)!==canonical(envelope))throw Error('emergency-stage-not-verified');
        const after=getSession();
        if(after?.uid!==owner.uid||after?.generation!==owner.generation||after.status!=='active')
          throw Error('emergency-session-changed');
        return {status:'staged-unconfirmed',id,operations:envelope.operations.length,writes:1,
          readyForSharedWrites:false};
      }finally{busy=false;}
    }
  });
}
