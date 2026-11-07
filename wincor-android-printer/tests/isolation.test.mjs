import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
function worker() {
  const handlers = {}, opened = [], deleted = [], fetched = [];
  const origin = 'https://iluxaspb.github.io';
  const prefix = 'wincor-android-printer:/Samosval/wincor-android-printer/:';
  const cache = { addAll: async () => {}, match: async () => undefined };
  vm.runInNewContext(read('sw.js'), {
    URL, Promise,
    self: { location: { href: origin + '/Samosval/wincor-android-printer/sw.js' }, addEventListener: (n,f) => handlers[n]=f, clients: {claim:async()=>{}},skipWaiting:()=>{} },
    caches: { open:async key=>(opened.push(key),cache), keys:async()=>['samosval-v4', 'wincor-legacy',prefix+'v0.0.1',prefix+'v0.1.0','wincor-android-printer:/another/:v0.0.1'],delete:async key=>deleted.push(key) },
    fetch: async req => (fetched.push(req.url), {ok:true})
  });
  return {handlers,opened,deleted,fetched,prefix,origin};
}
test('manifest is separately identified and scoped to this folder',()=>{
 const m=JSON.parse(read('manifest.webmanifest'));
 assert.equal(m.name,'Винкор Android принтер');assert.equal(m.short_name,'Винкор');
 for(const key of ['scope','start_url','id']) assert.equal(m[key],'./');
 assert.match(read('app.js'), /indexedDB\.open\('wincor-android-printer-db-v1',1\)/);
 assert.match(read('app.js'), /register\('\.\/sw\.js',\{scope:'\.\/'\}\)/);
});
test('activation only deletes older caches of this exact path',async()=>{
 const w=worker();let done;w.handlers.activate({waitUntil:p=>done=p});await done;
 assert.deepEqual(w.deleted,[w.prefix+'v0.0.1']);
});
test('fetch ignores sibling apps, lookalike paths, external origins and writes',async()=>{
 const w=worker();let calls=0;
 for(const [method,url] of [['GET',w.origin+'/Samosval/index.html'],['GET',w.origin+'/Samosval/wincor-android-printer-other/index.html'],['GET','https://other.example/Samosval/wincor-android-printer/index.html'],['POST',w.origin+'/Samosval/wincor-android-printer/index.html']])w.handlers.fetch({request:{method,url},respondWith:()=>calls++});
 assert.equal(calls,0);assert.deepEqual(w.opened,[]);
});
test('own requests only consult this app cache, then network',async()=>{
 const w=worker();let done;const url=w.origin+'/Samosval/wincor-android-printer/index.html';w.handlers.fetch({request:{method:'GET',url},respondWith:p=>done=p});await done;
 assert.deepEqual(w.opened,[w.prefix+'v0.1.0']);assert.deepEqual(w.fetched,[url]);
});
