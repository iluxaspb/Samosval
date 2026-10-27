/* Test page only. Cache Storage holds application files, NEVER user data/API replies. */
'use strict';
const VERSION = '94b297b31a1ef857';
const PREFIX = 'samosval-production-shell-';
const CACHE = PREFIX + VERSION;
const RECORDS = [{"url":"./index.html","sha256":"48041acaaf79afb1c9594c8cb452a29a885eeba0d60e7600e99886f658d3b785"},{"url":"./manifest.json","sha256":"9e025678a228ddd287d82a07e45521039ce182513543ab6def574501a5202275"},{"url":"./icon.svg","sha256":"b1e61c32259a7eae65befc51d5d8d108ccc61be55a2bf4cbc2c846db83b7a378"},{"url":"./app/build/94b297b31a1ef857/built-in-patches.js","sha256":"643d8296fa21b99701b7b021c3bb973307688d9d7f68f3437b7a4cd3e9cd8b7c"},{"url":"./app/build/94b297b31a1ef857/closed-shift-duplicates.js","sha256":"8f49eecc63385ed402d789c811458e8a15dc400208c68d99b81f15e350b07155"},{"url":"./app/build/94b297b31a1ef857/confirm-bridge.js","sha256":"c8649b01fe4060878492f0723080f0f41f88a0adce8a08b3c32bcbf2a99f588e"},{"url":"./app/build/94b297b31a1ef857/core.js","sha256":"2931fc4ccb7217f3d9ab1860bef51e3c5faa23ca2ff0e39a26c6e921848ec938"},{"url":"./app/build/94b297b31a1ef857/gai-report-toggle.js","sha256":"584a1b9bfb8c3edd8229fe73be5db55788dc251c182b545c27a4cac1b9c1455a"},{"url":"./app/build/94b297b31a1ef857/game-coins-v2.js","sha256":"38e64cf8f9434b7e8ca6c31210038f37749f2eb46bda7a7b3bcd7a367b80cae4"},{"url":"./app/build/94b297b31a1ef857/global-interface-haptics.js","sha256":"cb9695c568c866a5403268629d6b07629b0a2444de1ced98b088e027963b0d7f"},{"url":"./app/build/94b297b31a1ef857/history-recorder.js","sha256":"80d18f6ece45b79b028012aa3e66e8e826b71105e30a6c38052ae4c134c6b2fb"},{"url":"./app/build/94b297b31a1ef857/line-card-layers.js","sha256":"b3049b4af37f4ec202fb4685b9008dd7fa290057df5c91717cdc4c60ad343ba0"},{"url":"./app/build/94b297b31a1ef857/offline-feedback.js","sha256":"94b6082bc2d2939da2214787ad258b870c426ef0475220b7dd364d3959498db7"},{"url":"./app/build/94b297b31a1ef857/paper-viewer.js","sha256":"452edec9e65c7a48929221af761992e589ad21c69af4126d02d180f37257e8fc"},{"url":"./app/build/94b297b31a1ef857/pwa.js","sha256":"258b30070231d87150672ba23c8f206ecd6e3cff3f4e16fec368fd57fdcc9fa9"},{"url":"./app/build/94b297b31a1ef857/release-history.js","sha256":"6f5915760a1d51f3134698d8ae39f72c17019304ec0ca125e628f30c2d99c9f5"},{"url":"./app/build/94b297b31a1ef857/reset-settings.js","sha256":"f0111176964314364c8d0fde3f8b79ac6e8f31f7cee2362e80fd1822e00ca3d7"},{"url":"./app/build/94b297b31a1ef857/road-arcade-core.js","sha256":"10da96381e9f6662cf571a05a08839a9cc369440a289de656ba4ce1e1bfaee3f"},{"url":"./app/build/94b297b31a1ef857/road-arcade-runtime.js","sha256":"991ddcb72f33961973fbf8de908de81c0b03dfc5fea8e019b30e53889edccc82"},{"url":"./app/build/94b297b31a1ef857/road-arcade-ui.js","sha256":"6437eef1903c213b858c416a8b069da405396e71860777a5fd7b42124e50efba"},{"url":"./app/build/94b297b31a1ef857/road-jokes-v1.js","sha256":"8034c5a9d0f83742e7007c57e9ed2cc6927054f4666bb5daef88f1fdf0b506ea"},{"url":"./app/build/94b297b31a1ef857/road-season-effects-v1.js","sha256":"280137ae4c6e677516c0d5171b7ec822f8d11150bc26e25afe81a220ec53bd00"},{"url":"./app/build/94b297b31a1ef857/road-shop-v1.js","sha256":"6331cb853a83b2a025650ce9272e20f46cc796a4c4ce17b100b1a7b652a94ff2"},{"url":"./app/build/94b297b31a1ef857/test-release.js","sha256":"c35f045392c7426cfef50d171186f8d1d23ffbd6e950839f563cb164a0303553"},{"url":"./app/build/94b297b31a1ef857/trip-analytics.js","sha256":"1782f14ac8deb2a5794574e9ce56bc51aacbf8ab48050a114b4e63ab3c745dc1"},{"url":"./app/vendor/caveat-0.ttf","sha256":"012f33f9814bf9614973983335c3a375fe267c094e7c09a02a276cd1dcd4180a"},{"url":"./app/vendor/caveat-1.ttf","sha256":"f4365d9874c1b64026aca48786cf835a5decf2c740c06de04dbb05ce8c93ff37"},{"url":"./app/vendor/caveat.css","sha256":"51379e1bf96c50d0ebabe82c65a8d426ba516e1c9d9fc6916a35dcdad2f55863"},{"url":"./app/vendor/firebase-app-compat-10.8.0.js","sha256":"94842f6f47f9077e6eec909936bac5924ad95bca8db73425dd48715f47a9d5b6"},{"url":"./app/vendor/firebase-auth-compat-10.8.0.js","sha256":"3adf710ab8cffed4e8afc1e4368e636d8f97633409291c39f83500516526a524"},{"url":"./app/vendor/firebase-firestore-compat-10.8.0.js","sha256":"1b122566975332a8b7059e1b435df73122b6e4947b312360b518936be219b6fc"},{"url":"./app/vendor/html2pdf-0.10.1.bundle.min.js","sha256":"85e6ee9ce246e3ae4424313f7e46a5ed860a28d757811de8dc9c43f306049d65"}];
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
  if (!await cache.match(COMPLETE)) throw Error('Incomplete test release');
  // Activation waits for the old test clients to close. Never touch production caches or IndexedDB.
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
  if (event.data?.type !== 'APP_PWA_STATUS' || !event.ports?.[0]) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const complete = !!await cache.match(COMPLETE);
    event.ports[0].postMessage({type:'APP_PWA_STATUS',version:VERSION,complete});
  })());
});
