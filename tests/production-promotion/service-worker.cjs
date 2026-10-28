// Production offline routing and update isolation, without any live Firebase or network requests.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {webcrypto, createHash} = require('node:crypto');
const base = 'https://example.test/Samosval/';
const fixture = new Map([
  ['./index.html', Buffer.from('<!doctype html><title>4.0</title><script src="./app/build/fixture/core.js"></script>')],
  ['./manifest.json', Buffer.from('{}')],
  ['./app/build/fixture/core.js', Buffer.from('/* application fixture */')],
  ['./app/vendor/firebase-auth.js', Buffer.from('/* vendor fixture */')],
  ['./app/icons/icon-192.png', Buffer.from([137, 80, 78, 71])]
]);
const records = [...fixture].map(([url, data]) => ({url, sha256: createHash('sha256').update(data).digest('hex')}));
const source = fs.readFileSync('app/src/service-worker.js', 'utf8');
const compile = version => source.replace('__BUILD_VERSION__', version).replace('__PRECACHE_RECORDS__', JSON.stringify(records));
function harness({version = 'fixture', fail = '', storage = new Map()} = {}) {
  const handlers = {}, requests = [], deleted = [], claims = [];
  const cacheAPI = {
    open: async name => {
      if (!storage.has(name)) storage.set(name, new Map());
      const data = storage.get(name);
      return {match: async key => data.get(String(key))?.clone(), put: async (key, value) => data.set(String(key), value.clone())};
    },
    keys: async () => [...storage.keys()],
    delete: async key => { deleted.push(key); return storage.delete(key); }
  };
  const scope = {
    self: {location: {href: base + 'sw.js'}, clients: {claim: async () => claims.push(true)}, addEventListener: (name, cb) => handlers[name] = cb},
    caches: cacheAPI, crypto: webcrypto, URL, Response, Request, console,
    fetch: async request => {
      const url = typeof request === 'string' ? request : request.url;
      requests.push(url);
      if (fail && url.includes(fail)) throw Error('network down');
      const key = './' + new URL(url).pathname.slice('/Samosval/'.length);
      assert(fixture.has(key), 'unexpected network URL: ' + url);
      return new Response(fixture.get(key));
    }
  };
  vm.runInNewContext(compile(version), scope);
  async function event(name, data = {}) {
    let promise;
    handlers[name]({...data, waitUntil: p => promise = p});
    await promise;
  }
  async function request(url, method = 'GET') {
    let promise;
    handlers.fetch({request: new Request(url, {method}), respondWith: p => promise = p});
    return promise ? await promise : undefined;
  }
  return {event, request, storage, scope, requests, deleted, claims};
}
(async () => {
  const h = harness();
  h.storage.set('samosval-test-shell-existing', new Map());
  h.storage.set('unrelated-cache', new Map());
  await h.event('install');
  assert.equal(h.requests.length, records.length);
  assert.equal(h.claims.length, 0);
  await h.event('activate');
  assert.equal(h.claims.length, 1);
  h.scope.fetch = async () => { throw Error('offline'); };
  for (const path of ['', '?installed=1', 'index.html', 'index.html?installed=1']) {
    const response = await h.request(base + path);
    assert.equal(response.status, 200);
    assert((await response.text()).includes('<title>4.0</title>'));
  }
  for (const r of records) assert((await h.request(new URL(r.url, base))).ok);
  for (const path of ['index-test.html', 'index-test.html?installed=1', 'sw-test.js', 'manifest-test.webmanifest', 'test-app/build/test/core.js', 'app/private-data', 'index.html.other', 'api/send']) {
    assert.equal(await h.request(base + path), undefined, path);
  }
  assert.equal(await h.request('https://firestore.googleapis.com/v1/projects/x'), undefined);
  assert.equal(await h.request(base + 'index.html', 'POST'), undefined);
  let status;
  await h.event('message', {data: {type: 'PROD_PWA_STATUS'}, ports: [{postMessage: value => status = value}]});
  assert.equal(status.complete, true);
  assert.equal(status.version, 'fixture');
  console.log('PASS production directory/index/query offline navigation; every listed asset; test/API/write isolation; status handshake');

  const failed = harness({version: 'failed', fail: 'firebase-auth', storage: h.storage});
  await assert.rejects(() => failed.event('install'));
  assert(!h.storage.has('samosval-shell-failed'));
  assert(h.storage.has('samosval-shell-fixture'));
  const corrupt = harness();
  corrupt.scope.fetch = async () => new Response('wrong release');
  await assert.rejects(() => corrupt.event('install'));
  assert.equal(corrupt.storage.size, 0);
  const next = harness({version: 'next', storage: h.storage});
  await next.event('install');
  assert.equal(next.deleted.length, 0);
  assert(h.storage.has('samosval-shell-fixture'));
  await next.event('activate');
  assert(!h.storage.has('samosval-shell-fixture'));
  assert(h.storage.has('samosval-shell-next'));
  assert(h.storage.has('samosval-test-shell-existing'));
  assert(h.storage.has('unrelated-cache'));
  assert(source.includes('if (accepted) await self.skipWaiting()'), 'activation only follows explicit verified apply');
  assert(!/indexedDB|localStorage\./.test(source));
  const assetURL = new URL('./app/build/fixture/core.js', base).href;
  h.storage.get('samosval-shell-next').delete(assetURL);
  next.scope.fetch = async () => new Response('mismatched file after eviction');
  assert.equal((await next.request(assetURL)).status, 503);
  console.log('PASS incomplete/mixed update rejected; old shell retained until activation; only production caches removed; corrupt recovery blocked');

  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  for (const key of ['id', 'start_url', 'scope']) assert.equal(manifest[key], '/Samosval/');
  assert(!manifest.name.includes('Табель'));
  assert(manifest.icons.some(icon => icon.type === 'image/svg+xml'));
  const pwa = fs.readFileSync('app/src/pwa.js', 'utf8');
  new vm.Script(pwa);
  assert(pwa.includes("register('./sw.js',{scope:'./'"));
  assert(!pwa.includes('/test-app/'));
  assert(pwa.includes("location.pathname.endsWith('/index.html') || location.pathname.endsWith('/Samosval/')"));
  assert(pwa.includes('window.TestPWA={snapshot:state,inlineHtml}'));
  console.log('PASS installed production app identity preserved; PNG icons; production registration/export; existing export API retained');
})().catch(error => { console.error(error); process.exitCode = 1; });
