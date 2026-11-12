/* Test page only. Cache Storage holds application files, NEVER user data/API replies. */
'use strict';
const VERSION = '0f0881040d710261';
const PREFIX = 'samosval-working-test-shell-';
const CACHE = PREFIX + VERSION;
const RECORDS = [{"url":"./index-working-test.html","sha256":"62b31848dcbf4fa2f8cec276a5afa13ef3172ba85ec8f4d53554f7c9d4608efe"},{"url":"./manifest-working-test.webmanifest","sha256":"379149c95d8fcf01caa5c2a10e03c934ac29548e60f6e06c6105a3c97137ae27"},{"url":"./working-test/src/features/timesheet-core.js","sha256":"85e282fe2ce0223f71f1215e2d9826c4ab3747aed62012533cea82a0f125907e"},{"url":"./working-test/src/features/timesheet-app.js","sha256":"b42ff6ce485150a99865e5359a5015300431ec778b4d73ba79b5237e2a2712de"},{"url":"./working-test/src/styles/timesheet-css.css","sha256":"eef779cfa5fdd0edad39ca45793549b49050e4b13858d65cfb49a665a060157a"},{"url":"./working-test/src/pwa.js","sha256":"cb529c5e4374b1b4398b8d9ab95e313b971cce8a1e600db14f1f161a62462ef5"},{"url":"./working-test/vendor/firebase-app-compat-10.8.0.js","sha256":"94842f6f47f9077e6eec909936bac5924ad95bca8db73425dd48715f47a9d5b6"},{"url":"./working-test/vendor/firebase-auth-compat-10.8.0.js","sha256":"3adf710ab8cffed4e8afc1e4368e636d8f97633409291c39f83500516526a524"},{"url":"./working-test/vendor/firebase-firestore-compat-10.8.0.js","sha256":"1b122566975332a8b7059e1b435df73122b6e4947b312360b518936be219b6fc"},{"url":"./working-test/vendor/html2pdf-0.10.1.bundle.min.js","sha256":"85e6ee9ce246e3ae4424313f7e46a5ed860a28d757811de8dc9c43f306049d65"},{"url":"./working-test/vendor/caveat.css","sha256":"51379e1bf96c50d0ebabe82c65a8d426ba516e1c9d9fc6916a35dcdad2f55863"},{"url":"./working-test/vendor/caveat-0.ttf","sha256":"012f33f9814bf9614973983335c3a375fe267c094e7c09a02a276cd1dcd4180a"},{"url":"./working-test/vendor/caveat-1.ttf","sha256":"f4365d9874c1b64026aca48786cf835a5decf2c740c06de04dbb05ce8c93ff37"},{"url":"./working-test/icons/icon-192.png","sha256":"cb63c9b1cab9bfe3b4946d03b2f46772083c76ad03938e4f24581cd4480cedc4"},{"url":"./working-test/icons/icon-512.png","sha256":"4e57fcca475e0141b5242f471600fe4cc9e527be267e8337b927b3e2e99d9e64"}];
const BASE = new URL('./', self.location.href);
const PAGE = new URL('index-working-test.html', BASE).href;
const ALLOWED = new Set(RECORDS.map(r => new URL(r.url, BASE).href));
const COMPLETE = new URL('working-test/.complete-' + VERSION, BASE).href;
let completedFiles=0;
async function publishProgress(){
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for(const client of windows){if(new URL(client.url).pathname===new URL(PAGE).pathname)client.postMessage({type:'WORKING_TEST_PWA_PROGRESS',version:VERSION,completed:completedFiles,total:RECORDS.length});}
}
const hash = async buffer => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),b=>b.toString(16).padStart(2,'0')).join('');
// One hanging download on a mobile network must never block installation for
// good: each attempt has a timeout, three attempts with a growing pause, and
// an overall install deadline guarantees a clear failure instead of a stall.
const FETCH_TIMEOUT = 30000;
const FETCH_ATTEMPTS = 3;
const INSTALL_DEADLINE = 240000;
const fetchWithTimeout = async url => {
  let lastError;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const response = await fetch(url, {cache:'reload',credentials:'same-origin',signal:controller.signal});
      if (!response.ok || response.type === 'opaque') {
        throw Error('Cannot cache '+url+' (HTTP '+(response.status||'?')+')');
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < FETCH_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || Error('Cannot fetch '+url);
};

self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  const deadlineAt = Date.now() + INSTALL_DEADLINE;
  let deadlineTimer;
  const deadline = new Promise((resolve, reject) => {
    deadlineTimer = setTimeout(() => reject(Error('Install deadline exceeded: '+VERSION)), INSTALL_DEADLINE);
  });
  try {
    // Limit parallel requests on phones. A partial install must never replace the last working app.
    const work = (async () => {
      let next = 0;
      const results = await Promise.allSettled(Array.from({length:4}, async () => {
        while (next < RECORDS.length) {
          if (Date.now() >= deadlineAt) throw Error('Install deadline exceeded: '+VERSION);
          const record = RECORDS[next++], url = new URL(record.url, BASE).href;
          const response = await fetchWithTimeout(url);
          // response.ok/opaque already checked inside fetchWithTimeout; keep the SHA-256 check.
          if (await hash(await response.clone().arrayBuffer()) !== record.sha256) throw Error('Release mismatch: '+url);
          await cache.put(url,response);completedFiles++;await publishProgress().catch(()=>{});
        }
      }));
      const failed = results.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
      await cache.put(COMPLETE,new Response(VERSION));
      // No skipWaiting: finish the current session before switching code versions.
    })();
    // The whole installation must finish within the deadline: a stalled network
    // fails with a clear error instead of hanging forever. The timer is cleared
    // as soon as the install work succeeds.
    await Promise.race([work, deadline]);
    work.catch(() => {});
    clearTimeout(deadlineTimer);
  } catch (error) {
    clearTimeout(deadlineTimer);
    await caches.delete(CACHE);
    throw error;
  }
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  if (!await cache.match(COMPLETE)) throw Error('Incomplete test release');
  // Explicit APPLY can activate with open windows. Cache housekeeping must not
  // delay activation; the reloaded page requests it after taking the new controller.
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== BASE.origin) return; // Firebase/Auth/Storage/MAX keep their existing protocols.
  const isPage = url.pathname === new URL(PAGE).pathname;
  const key = isPage ? PAGE : url.href;
  if (!ALLOWED.has(key)) return; // In particular: index.html and all other pages are outside this cache.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    if (cached) return cached;
    // Recovery from eviction verifies the exact release; never mix old HTML with new code.
    const response = await fetch(new Request(key,{cache:'reload',credentials:'same-origin'}));
    const record = RECORDS.find(r=>new URL(r.url,BASE).href===key);
    if (!response.ok || await hash(await response.clone().arrayBuffer()) !== record.sha256) {
      return new Response('Файлы обновляются. Подключитесь к сети и откройте приложение заново.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
    }
    await cache.put(key,response.clone());
    return response;
  })());
});

self.addEventListener('message', event => {
  const type = event.data?.type, port = event.ports?.[0];
  if(type==='WORKING_TEST_PWA_PRUNE'){
    event.waitUntil((async()=>{
      const keys=(await caches.keys()).filter(key=>key.startsWith(PREFIX)&&key!==CACHE);
      // Keep two older complete app shells for existing windows and recovery.
      for(const key of keys.slice(0,-2))await caches.delete(key);
    })());return;
  }
  if (!port || (type !== 'WORKING_TEST_PWA_STATUS' && type !== 'WORKING_TEST_PWA_APPLY')) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const complete = !!await cache.match(COMPLETE);
    if (type === 'WORKING_TEST_PWA_STATUS') {
      port.postMessage({type:'WORKING_TEST_PWA_STATUS',version:VERSION,complete,completed:complete?RECORDS.length:completedFiles,total:RECORDS.length});
      return;
    }
    // Only activate a complete, hash-verified release requested explicitly by
    // the user. Never call skipWaiting during automatic installation.
    const accepted = complete && event.data?.version === VERSION;
    port.postMessage({type:'WORKING_TEST_PWA_APPLY',version:VERSION,accepted});
    // Do not keep the APPLY message event pending on activation itself.
    if (accepted) void self.skipWaiting();
  })());
});
