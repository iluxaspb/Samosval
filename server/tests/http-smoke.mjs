// Run inside the deployed TEST API container. This performs no data writes.
import assert from 'node:assert/strict';
const base='http://127.0.0.1:8080';
const get=(path,options={})=>fetch(base+path,{...options,signal:AbortSignal.timeout(5000)});
const live=await get('/health/live'); assert.equal(live.status,200); assert.equal((await live.json()).status,'ok');
console.log('PASS live health');
const ready=await get('/health/ready'); assert.equal(ready.status,200); assert.equal((await ready.json()).database,'connected');
console.log('PASS PostgreSQL readiness');
for(const [path,options] of [['/api/v1/line/snapshot',{}],['/api/v1/line/snapshot',{headers:{Authorization:'Bearer invalid.token.value'}}],['/api/v1/line/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}]]){
  const response=await get(path,options); assert.equal(response.status,401); assert.equal((await response.json()).error,'unauthorized');
}
console.log('PASS read/write require Firebase authentication');
const cors=await get('/api/v1/line/snapshot',{method:'OPTIONS',headers:{Origin:'https://iluxaspb.github.io','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}});
assert.equal(cors.status,204); assert.equal(cors.headers.get('access-control-allow-origin'),'https://iluxaspb.github.io'); assert.match(cors.headers.get('access-control-allow-methods'),/GET/); assert.match(cors.headers.get('access-control-allow-headers'),/Authorization/);
console.log('PASS GitHub Pages GET preflight');
const denied=await get('/api/v1/line/snapshot',{headers:{Origin:'https://untrusted.example'}}); assert.equal(denied.status,403); assert.equal((await denied.json()).error,'origin-not-allowed');
console.log('PASS foreign origin denied');
console.log('ALL DEPLOYED API SMOKE CHECKS PASSED');
