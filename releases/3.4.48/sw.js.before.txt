/* Production page only. Cache Storage holds application files, NEVER user data/API replies. */
'use strict';
const VERSION = 'd7399f63cbcbabc7';
const PREFIX = 'samosval-shell-';
const CACHE = PREFIX + VERSION;
const RECORDS = [{"url":"./index.html","sha256":"b61e537b57d45aff70df2d25b05bc4d5e41fa7b0b9baf5cbbfa072aa9399fe3b"},{"url":"./manifest.json","sha256":"9e025678a228ddd287d82a07e45521039ce182513543ab6def574501a5202275"},{"url":"./icon.svg","sha256":"b1e61c32259a7eae65befc51d5d8d108ccc61be55a2bf4cbc2c846db83b7a378"},{"url":"./app/vendor/caveat-0.ttf","sha256":"012f33f9814bf9614973983335c3a375fe267c094e7c09a02a276cd1dcd4180a"},{"url":"./app/vendor/caveat-1.ttf","sha256":"f4365d9874c1b64026aca48786cf835a5decf2c740c06de04dbb05ce8c93ff37"},{"url":"./app/vendor/caveat.css","sha256":"51379e1bf96c50d0ebabe82c65a8d426ba516e1c9d9fc6916a35dcdad2f55863"},{"url":"./app/vendor/firebase-app-compat-10.8.0.js","sha256":"94842f6f47f9077e6eec909936bac5924ad95bca8db73425dd48715f47a9d5b6"},{"url":"./app/vendor/firebase-auth-compat-10.8.0.js","sha256":"3adf710ab8cffed4e8afc1e4368e636d8f97633409291c39f83500516526a524"},{"url":"./app/vendor/firebase-firestore-compat-10.8.0.js","sha256":"1b122566975332a8b7059e1b435df73122b6e4947b312360b518936be219b6fc"},{"url":"./app/vendor/firebase-storage-compat-10.8.0.js","sha256":"a93a20f09fd70fda9434c45abb0e386005148f843f31111488c9912c107dd7ba"},{"url":"./app/vendor/html2pdf-0.10.1.bundle.min.js","sha256":"85e6ee9ce246e3ae4424313f7e46a5ed860a28d757811de8dc9c43f306049d65"},{"url":"./app/build/d7399f63cbcbabc7/core.js","sha256":"44a0f216e62953021f79a23d5fb02433ee8323a8209f07957285d6b1524ce074"},{"url":"./app/build/d7399f63cbcbabc7/history-recorder.js","sha256":"80d18f6ece45b79b028012aa3e66e8e826b71105e30a6c38052ae4c134c6b2fb"},{"url":"./app/build/d7399f63cbcbabc7/built-in-patches.js","sha256":"02fd7fd95b5818fb024d8beeff9007fe04ef37a379541c01833bec21cdaa518a"},{"url":"./app/build/d7399f63cbcbabc7/line-card-layers.js","sha256":"b3049b4af37f4ec202fb4685b9008dd7fa290057df5c91717cdc4c60ad343ba0"},{"url":"./app/build/d7399f63cbcbabc7/closed-shift-duplicates.js","sha256":"8f49eecc63385ed402d789c811458e8a15dc400208c68d99b81f15e350b07155"},{"url":"./app/build/d7399f63cbcbabc7/paper-viewer.js","sha256":"4ae0a1ebb39d64df2a41a284b8651ee2c698fe2472e843debc5aafc4b956a151"},{"url":"./app/build/d7399f63cbcbabc7/gai-report-toggle.js","sha256":"584a1b9bfb8c3edd8229fe73be5db55788dc251c182b545c27a4cac1b9c1455a"},{"url":"./app/build/d7399f63cbcbabc7/trip-analytics.js","sha256":"1782f14ac8deb2a5794574e9ce56bc51aacbf8ab48050a114b4e63ab3c745dc1"},{"url":"./app/build/d7399f63cbcbabc7/offline-feedback.js","sha256":"94b6082bc2d2939da2214787ad258b870c426ef0475220b7dd364d3959498db7"},{"url":"./app/build/d7399f63cbcbabc7/release-history.js","sha256":"9375d30af2cca756913512b533a516538b1d32bd081fc29badd5c42df8e0097a"},{"url":"./app/build/d7399f63cbcbabc7/confirm-bridge.js","sha256":"c8649b01fe4060878492f0723080f0f41f88a0adce8a08b3c32bcbf2a99f588e"},{"url":"./app/build/d7399f63cbcbabc7/reset-settings.js","sha256":"416078dbe3a699fe4d25a3eedc5a97edabe705732715aac90bfb13b09f5af335"},{"url":"./app/build/d7399f63cbcbabc7/game-coins-v2.js","sha256":"38e64cf8f9434b7e8ca6c31210038f37749f2eb46bda7a7b3bcd7a367b80cae4"},{"url":"./app/build/d7399f63cbcbabc7/road-shop-v1.js","sha256":"6331cb853a83b2a025650ce9272e20f46cc796a4c4ce17b100b1a7b652a94ff2"},{"url":"./app/build/d7399f63cbcbabc7/road-jokes-v1.js","sha256":"8034c5a9d0f83742e7007c57e9ed2cc6927054f4666bb5daef88f1fdf0b506ea"},{"url":"./app/build/d7399f63cbcbabc7/road-season-effects-v1.js","sha256":"280137ae4c6e677516c0d5171b7ec822f8d11150bc26e25afe81a220ec53bd00"},{"url":"./app/build/d7399f63cbcbabc7/road-arcade-core.js","sha256":"10da96381e9f6662cf571a05a08839a9cc369440a289de656ba4ce1e1bfaee3f"},{"url":"./app/build/d7399f63cbcbabc7/road-arcade-runtime.js","sha256":"991ddcb72f33961973fbf8de908de81c0b03dfc5fea8e019b30e53889edccc82"},{"url":"./app/build/d7399f63cbcbabc7/road-arcade-ui.js","sha256":"6437eef1903c213b858c416a8b069da405396e71860777a5fd7b42124e50efba"},{"url":"./app/build/d7399f63cbcbabc7/global-interface-haptics.js","sha256":"cb9695c568c866a5403268629d6b07629b0a2444de1ced98b088e027963b0d7f"},{"url":"./app/build/d7399f63cbcbabc7/prod-release.js","sha256":"17db41e5daa898081d475e3677377ed5fbacf9e944acb5d37c0c18461cb10287"},{"url":"./app/build/d7399f63cbcbabc7/pwa.js","sha256":"0197c6c3c5ebaf8883384706e6d4379cbfbd838f839ffe735ce128edce9b2d8b"}];
const BASE = new URL('./', self.location.href);
const PAGE = new URL('index.html', BASE).href;
const ALLOWED = new Set(RECORDS.map(r => new URL(r.url, BASE).href));
const COMPLETE = new URL('app/.complete-' + VERSION, BASE).href;
const hash = async buffer => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),b=>b.toString(16).padStart(2,'0')).join('');

self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  try {
    // Limit parallel requests on phones. A partial install must never replace the last working app.
    let next = 0;
    const results = await Promise.allSettled(Array.from({length:4}, async () => {
      while (next < RECORDS.length) {
        const record = RECORDS[next++], url = new URL(record.url, BASE).href;
        const response = await fetch(new Request(url, {cache:'reload',credentials:'same-origin'}));
        if (!response.ok || response.type === 'opaque') throw Error('Cannot cache '+url);
        if (await hash(await response.clone().arrayBuffer()) !== record.sha256) throw Error('Release mismatch: '+url);
        await cache.put(url,response);
      }
    }));
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
    await cache.put(COMPLETE,new Response(VERSION));
    // No skipWaiting: finish the current session before switching code versions.
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  if (!await cache.match(COMPLETE)) throw Error('Incomplete production release');
  // Activation waits for the old production clients to close. Never touch production caches or IndexedDB.
  for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== BASE.origin) return; // Firebase/Auth/Storage/MAX keep their existing protocols.
  const isPage = url.pathname === new URL(PAGE).pathname || url.pathname === BASE.pathname;
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
  if (!port || (type !== 'PROD_PWA_STATUS' && type !== 'PROD_PWA_APPLY')) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const complete = !!await cache.match(COMPLETE);
    if (type === 'PROD_PWA_STATUS') {
      port.postMessage({type:'PROD_PWA_STATUS',version:VERSION,complete});
      return;
    }
    // Only activate a complete, hash-verified release requested explicitly by
    // the user. Never call skipWaiting during automatic installation.
    const accepted = complete && event.data?.version === VERSION;
    port.postMessage({type:'PROD_PWA_APPLY',version:VERSION,accepted});
    if (accepted) await self.skipWaiting();
  })());
});
