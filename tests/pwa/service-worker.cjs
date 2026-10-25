const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),{webcrypto}=require('crypto');
const code=fs.readFileSync('sw-test.js','utf8'),base='https://example.test/Samosval/',records=JSON.parse(fs.readFileSync('test-app/build-manifest.json')).assets;
function harness({fail='',storage=new Map(),version=code}={}){
 const handlers={},requests=[],deleted=[],claims=[],cacheAPI={
  open:async name=>{if(!storage.has(name))storage.set(name,new Map());const data=storage.get(name);return{match:async k=>data.get(String(k))?.clone(),put:async(k,v)=>data.set(String(k),v.clone())}},
  keys:async()=>[...storage.keys()],delete:async key=>{deleted.push(key);return storage.delete(key)}
 };
 const scope={self:{location:{href:base+'sw-test.js'},clients:{claim:async()=>claims.push(true)},addEventListener:(n,cb)=>handlers[n]=cb},caches:cacheAPI,crypto:webcrypto,URL,Response,Request,console,fetch:async req=>{
  const url=typeof req==='string'?req:req.url;requests.push(url);if(url.includes(fail)&&fail)throw Error('network down');
  const path=new URL(url).pathname.replace('/Samosval/','');return new Response(fs.readFileSync(path),{status:200});
 }};
 vm.runInNewContext(version,scope);
 async function event(type,data={}){let promise;handlers[type]({...data,waitUntil:p=>promise=p});await promise}
 async function request(url,method='GET'){let promise;handlers.fetch({request:new Request(url,{method}),respondWith:p=>promise=p});return promise?await promise:undefined}
 return{storage,handlers,requests,deleted,claims,event,request,scope};
}
(async()=>{
 const h=harness();h.storage.set('production-shell-v3',new Map([['protected','yes']]));
 await h.event('install');assert.equal(h.requests.length,records.length);assert.equal(h.claims.length,0);await h.event('activate');assert.equal(h.claims.length,1);assert(h.storage.has('production-shell-v3'));
 h.scope.fetch=async()=>{throw Error('offline')};
 const html=await h.request(base+'index-test.html?installed=1');assert(html.ok);assert((await html.text()).includes('test-app/build/'));
 for(const r of records)assert((await h.request(new URL(r.url,base).href)).ok);
 assert.equal(await h.request(base+'index.html'),undefined);assert.equal(await h.request(base),undefined);assert.equal(await h.request('https://firestore.googleapis.com/v1/projects/x'),undefined);assert.equal(await h.request(base+'index-test.html','POST'),undefined);
 console.log('PASS offline shell, every script/font/icon, query navigation; production/API/write requests untouched');
 const failed=harness({fail:'firebase-auth',storage:h.storage,version:code.replace(/const VERSION = '[^']+'/,'const VERSION = \'failed-release\'')});await assert.rejects(()=>failed.event('install'));assert(!h.storage.has('samosval-test-shell-failed-release'));assert(h.storage.has('production-shell-v3'));assert(h.storage.has('samosval-test-shell-'+JSON.parse(fs.readFileSync('test-app/build-manifest.json')).version));
 const corrupt=harness();corrupt.scope.fetch=async()=>new Response('wrong release');await assert.rejects(()=>corrupt.event('install'));assert.equal(corrupt.storage.size,0);
 console.log('PASS failed/inconsistent update cannot replace cached app; no IndexedDB/localStorage deletion or skipWaiting');
 assert(!/skipWaiting\s*\(/.test(code));assert(!/indexedDB|localStorage\./.test(code));
 const second=harness({storage:h.storage,version:code.replace(/const VERSION = '[^']+'/,'const VERSION = \'next-release\'')});await second.event('install');assert.equal(second.deleted.length,0);await second.event('activate');assert(h.storage.has('production-shell-v3'));assert(h.storage.has('samosval-test-shell-next-release'));
 console.log('PASS update waits for activation and cleans only its own shell caches');
})().catch(e=>{console.error(e);process.exitCode=1});
