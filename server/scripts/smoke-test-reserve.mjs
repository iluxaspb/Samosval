// Post-deployment TEST-only Cloud Run smoke checks.
// Never sends a real Firebase token or performs an authorized business write.
const EXPECTED_PROJECT='samosval-offline';
function requireSafeUrl(input){
 let u;
 try{u=new URL(input);}catch{throw Error('smoke-invalid-reserve-url');}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||
    !/^([a-z0-9-]+\.)+run\.app$/i.test(u.hostname))
  throw Error('smoke-invalid-reserve-url');
 return u.origin;
}
export async function checkReserveEndpoint(url,{fetchImpl=globalThis.fetch}={}){
 const base=requireSafeUrl(url);
 if(typeof fetchImpl!=='function')throw TypeError('smoke-fetch-required');
 const call=async(path,{method='GET',headers={},body}={})=>{
  const response=await fetchImpl(base+path,{method,headers,...(body!==undefined?{body}:{}),
   signal:AbortSignal.timeout(15000),redirect:'error',credentials:'omit',
   cache:'no-store',referrerPolicy:'no-referrer'});
  return response;
 };
 const health=await call('/health/live');
 if(health.status!==200)throw Error('smoke-health-http-'+health.status);
 let data;
 try{data=await health.json();}catch{throw Error('smoke-health-invalid-json');}
 if(data?.status!=='ok'||data.source!=='firebase'||
    data.projectId!==EXPECTED_PROJECT||data.mode!=='line-test-only')
  throw Error('smoke-wrong-project-or-serve-mode');
 const noToken=await call('/api/v1/session');
 if(noToken.status!==401)throw Error('smoke-unauth-session-'+noToken.status);
 const wrongToken=await call('/api/v1/owner/status',
  {headers:{Authorization:'Bearer definitely-not-a-firebase-id-token'}});
 if(wrongToken.status!==401)throw Error('smoke-invalid-token-owner-'+wrongToken.status);
 const illegalWrite=await call('/api/v1/line/operations',{method:'POST',
  headers:{Authorization:'Bearer definitely-not-a-firebase-id-token',
   'Content-Type':'application/json','X-Samosval-Writer-Epoch':'1'},
  body:JSON.stringify({id:'smoke_no_write',type:'load'})});
 if(illegalWrite.status!==401)throw Error('smoke-invalid-token-write-'+illegalWrite.status);
 const cors=await call('/api/v1/session',{method:'OPTIONS',
  headers:{Origin:'https://iluxaspb.github.io',
   'Access-Control-Request-Method':'GET'}});
 if(cors.status!==204||
    cors.headers.get('Access-Control-Allow-Origin')!=='https://iluxaspb.github.io')
  throw Error('smoke-cors-preflight-invalid');
 const wrongOrigin=await call('/api/v1/session',
  {headers:{Origin:'https://wrong-origin.example'}});
 if(wrongOrigin.status!==403)throw Error('smoke-cross-origin-bypass-'+wrongOrigin.status);
 return Object.freeze({projectId:EXPECTED_PROJECT,mode:data.mode,
  health:health.status,noToken:noToken.status,invalidToken:wrongToken.status,
  unauthorizedWrite:illegalWrite.status,cors:cors.status,
  forbiddenOrigin:wrongOrigin.status});
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 checkReserveEndpoint(process.argv[2]).then(result=>{
  console.log('TEST_RESERVE_CLOUD_RUN_SMOKE_OK',JSON.stringify(result));
 }).catch(e=>{console.error('TEST_RESERVE_CLOUD_RUN_SMOKE_FAILED',e.code||e.message);
  process.exitCode=1;});
}
