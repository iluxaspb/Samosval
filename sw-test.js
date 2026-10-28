/* Test page only. Cache Storage holds application files, NEVER user data/API replies. */
'use strict';
const VERSION = 'e635f1a3f92ee39b';
const PREFIX = 'samosval-test-shell-';
const CACHE = PREFIX + VERSION;
const RECORDS = [{"url":"./index-test.html","sha256":"d4c6a5c1acf73c2fa6ab1fdfe3c59fdfab895e2d492cc7b36b7048c2e00bebaf"},{"url":"./manifest-test.webmanifest","sha256":"379149c95d8fcf01caa5c2a10e03c934ac29548e60f6e06c6105a3c97137ae27"},{"url":"./test-app/src/pwa.js","sha256":"ba63edcb198227a8352365b4248ded127ae94be98314636719adb164b20b4c41"},{"url":"./test-app/vendor/firebase-app-compat-10.8.0.js","sha256":"94842f6f47f9077e6eec909936bac5924ad95bca8db73425dd48715f47a9d5b6"},{"url":"./test-app/vendor/firebase-auth-compat-10.8.0.js","sha256":"3adf710ab8cffed4e8afc1e4368e636d8f97633409291c39f83500516526a524"},{"url":"./test-app/vendor/firebase-firestore-compat-10.8.0.js","sha256":"1b122566975332a8b7059e1b435df73122b6e4947b312360b518936be219b6fc"},{"url":"./test-app/vendor/html2pdf-0.10.1.bundle.min.js","sha256":"85e6ee9ce246e3ae4424313f7e46a5ed860a28d757811de8dc9c43f306049d65"},{"url":"./test-app/vendor/caveat.css","sha256":"51379e1bf96c50d0ebabe82c65a8d426ba516e1c9d9fc6916a35dcdad2f55863"},{"url":"./test-app/vendor/caveat-0.ttf","sha256":"012f33f9814bf9614973983335c3a375fe267c094e7c09a02a276cd1dcd4180a"},{"url":"./test-app/vendor/caveat-1.ttf","sha256":"f4365d9874c1b64026aca48786cf835a5decf2c740c06de04dbb05ce8c93ff37"},{"url":"./test-app/icons/icon-192.png","sha256":"cb63c9b1cab9bfe3b4946d03b2f46772083c76ad03938e4f24581cd4480cedc4"},{"url":"./test-app/icons/icon-512.png","sha256":"4e57fcca475e0141b5242f471600fe4cc9e527be267e8337b927b3e2e99d9e64"},{"url":"./test-app/tabel-v2/catalog.mjs","sha256":"5e7a65e3a55112b1c2e1010a03eec0393fb41f497abc02a6b3ec6e66a5cb3c55"},{"url":"./test-app/tabel-v2/domain.mjs","sha256":"c949c17606cfc8678d327371fc67feed50fcb88cb027971a97ae43f4ca3584af"},{"url":"./test-app/tabel-v2/entry.mjs","sha256":"070b4900c9e0af06fcf61cce63046faf343fb18693b0b93a7401f3299885996a"},{"url":"./test-app/tabel-v2/grid.mjs","sha256":"260f9d1def2b161404ca46830901f938d29fe2bc84be157291a3cfe33c5ae16a"},{"url":"./test-app/tabel-v2/line.mjs","sha256":"f76b60ebc7c0444070762eda086ada96657fa641d141f608116c2c63fe665535"},{"url":"./test-app/tabel-v2/messages.mjs","sha256":"4b2c413e971162e6acc8f4c3c7ba94a61cac061d08e4e8d4ca9baf71f61f297e"},{"url":"./test-app/tabel-v2/migration.mjs","sha256":"9444ec78ad96e9398f16f28936d487c9f12473cd4182bd0bd4bc559f6a0ea532"},{"url":"./test-app/tabel-v2/permissions.mjs","sha256":"88c1ccb5634f7de93d8be804005ae8b0334bf767aa6ba1e65c7dc912f06482f5"},{"url":"./test-app/tabel-v2/request-domain.mjs","sha256":"a658d689c14e2a2c5a2f7b9d4fdc0671fd65f129b5ffb3eca8413d2c59b6a5c4"},{"url":"./test-app/tabel-v2/settings-menu.mjs","sha256":"ae1df2d1bab9c2f07bbc51be1d10592f807caed4f7742bcabc88ebffe6eb2749"},{"url":"./test-app/tabel-v2/store.mjs","sha256":"23ce1a118526080edd8a3be2cb65d1ac0e44184233cd34e53d94d75b0cd094f5"},{"url":"./test-app/tabel-v2/summary.mjs","sha256":"236a34d14ca323ca9483e620cbc65e8f30c8f2ccdcb1671ec8fb472f538fe17a"},{"url":"./test-app/tabel-v2/table-domain.mjs","sha256":"5bd4d4f959890ea377b3edd03114f6962fd833fa896645837da191467bbe32a1"},{"url":"./test-app/tabel-v2/ui.css","sha256":"23bd0c0275cabbd4806ba67ce855edb6443f2c023ef7dab7370c36a0d7bdb48a"},{"url":"./test-app/tabel-v2/ui.mjs","sha256":"cd0fdf2d404c01d6240ed4885e2a216686bf2ac3c1230bffabcaae643abf1ef9"},{"url":"./test-app/tabel-v2/view.html","sha256":"08513346c5c9ce5f65b8e3fbd76bc5f226117ac843582a80c71b0542f197ba5c"},{"url":"./test-app/tabel-v2/workspace.css","sha256":"cb60e399c867f41685b7751d9ef803e0ce927e11feb108374150559b445ebe4c"},{"url":"./test-app/tabel-v2/workspace.mjs","sha256":"d71a701666149cc7a59436999dca98557f800938aa2dac5955b30915868fd781"},{"url":"./test-app/build/e635f1a3f92ee39b/built-in-patches.js","sha256":"e20cff31c41838c91dc8c96ccacff7ed6c1cde516de4aa9b40c3cbe6d9ad9dca"},{"url":"./test-app/build/e635f1a3f92ee39b/closed-shift-duplicates.js","sha256":"8f49eecc63385ed402d789c811458e8a15dc400208c68d99b81f15e350b07155"},{"url":"./test-app/build/e635f1a3f92ee39b/confirm-bridge.js","sha256":"c8649b01fe4060878492f0723080f0f41f88a0adce8a08b3c32bcbf2a99f588e"},{"url":"./test-app/build/e635f1a3f92ee39b/core.js","sha256":"f8ba1827d6078e5d3de777b4f7410e9520b760b23be3455c2ef777b06f2b69f8"},{"url":"./test-app/build/e635f1a3f92ee39b/gai-report-toggle.js","sha256":"584a1b9bfb8c3edd8229fe73be5db55788dc251c182b545c27a4cac1b9c1455a"},{"url":"./test-app/build/e635f1a3f92ee39b/game-coins-v2.js","sha256":"38e64cf8f9434b7e8ca6c31210038f37749f2eb46bda7a7b3bcd7a367b80cae4"},{"url":"./test-app/build/e635f1a3f92ee39b/global-interface-haptics.js","sha256":"cb9695c568c866a5403268629d6b07629b0a2444de1ced98b088e027963b0d7f"},{"url":"./test-app/build/e635f1a3f92ee39b/history-recorder.js","sha256":"80d18f6ece45b79b028012aa3e66e8e826b71105e30a6c38052ae4c134c6b2fb"},{"url":"./test-app/build/e635f1a3f92ee39b/line-card-layers.js","sha256":"b3049b4af37f4ec202fb4685b9008dd7fa290057df5c91717cdc4c60ad343ba0"},{"url":"./test-app/build/e635f1a3f92ee39b/offline-feedback.js","sha256":"94b6082bc2d2939da2214787ad258b870c426ef0475220b7dd364d3959498db7"},{"url":"./test-app/build/e635f1a3f92ee39b/paper-viewer.js","sha256":"4ae0a1ebb39d64df2a41a284b8651ee2c698fe2472e843debc5aafc4b956a151"},{"url":"./test-app/build/e635f1a3f92ee39b/release-history.js","sha256":"1ea5b707acb6aacc4febfe363610cd0d473118cfd2569a062d1152f907462bf8"},{"url":"./test-app/build/e635f1a3f92ee39b/reset-settings.js","sha256":"416078dbe3a699fe4d25a3eedc5a97edabe705732715aac90bfb13b09f5af335"},{"url":"./test-app/build/e635f1a3f92ee39b/road-arcade-core.js","sha256":"10da96381e9f6662cf571a05a08839a9cc369440a289de656ba4ce1e1bfaee3f"},{"url":"./test-app/build/e635f1a3f92ee39b/road-arcade-runtime.js","sha256":"991ddcb72f33961973fbf8de908de81c0b03dfc5fea8e019b30e53889edccc82"},{"url":"./test-app/build/e635f1a3f92ee39b/road-arcade-ui.js","sha256":"6437eef1903c213b858c416a8b069da405396e71860777a5fd7b42124e50efba"},{"url":"./test-app/build/e635f1a3f92ee39b/road-jokes-v1.js","sha256":"8034c5a9d0f83742e7007c57e9ed2cc6927054f4666bb5daef88f1fdf0b506ea"},{"url":"./test-app/build/e635f1a3f92ee39b/road-season-effects-v1.js","sha256":"280137ae4c6e677516c0d5171b7ec822f8d11150bc26e25afe81a220ec53bd00"},{"url":"./test-app/build/e635f1a3f92ee39b/road-shop-v1.js","sha256":"6331cb853a83b2a025650ce9272e20f46cc796a4c4ce17b100b1a7b652a94ff2"},{"url":"./test-app/build/e635f1a3f92ee39b/settings-hub.js","sha256":"23ed7100ec57cb522adaf9839fb39ceb73ba3cdb711dd44aad9ef4cff0561438"},{"url":"./test-app/build/e635f1a3f92ee39b/test-release.js","sha256":"cc9c6cab0467bedeaf11d80e25c2aeaec5dbae0a20fb3d59c92bc4702cc30b71"},{"url":"./test-app/build/e635f1a3f92ee39b/trip-analytics.js","sha256":"1782f14ac8deb2a5794574e9ce56bc51aacbf8ab48050a114b4e63ab3c745dc1"},{"url":"./test-app/tabel/app.mjs","sha256":"dca1cd65378fc0c94b4b9f41520a959f1169a24ad4c21d045adb649ac3bd8065"},{"url":"./test-app/tabel/catalog.mjs","sha256":"598ead803702aea2060956ecbac3ef2ffe68652d8c9fabd84ac154bbde1e1757"},{"url":"./test-app/tabel/domain.mjs","sha256":"597748f872aa45c73ca1f91a463b16f97190d6988cfcdd323a9b3148bc7d9d23"},{"url":"./test-app/tabel/editor.mjs","sha256":"876614080d9e3ff2f0fa45b196251cc4e75d2bf96f06b2aa8d600277ce294c71"},{"url":"./test-app/tabel/entry.mjs","sha256":"fde4a95e6083e37c51f5db3ba66ce38753dfb1faaeb83f65d49ade4055f93811"},{"url":"./test-app/tabel/forms.mjs","sha256":"b3b4e9197270345a559ea07552674e2992f67f4946b54033926ba3704a64a923"},{"url":"./test-app/tabel/plugin.js","sha256":"06148dec512b8c0be14183dad1d4a364ab127ec52b1eec49cbf78eae430b8601"},{"url":"./test-app/tabel/report.mjs","sha256":"fb072967cc642b0cdeb1db9e71d16a2c84bdb8eb1d50a29e7c1ac7807565ddab"},{"url":"./test-app/tabel/request.mjs","sha256":"ffbe528d2fba452439ce1fb74ee8700af0159335eb4538da2cf41059ee62bb8c"},{"url":"./test-app/tabel/service.mjs","sha256":"4351a34713a77b289487bb42061499ad2ba80d26147618b345238ca576332e46"},{"url":"./test-app/tabel/settings.mjs","sha256":"3dfdafac5465bdf06faff877fb0f98f165c130739f93bb4a14cebfc910043846"},{"url":"./test-app/tabel/shift.mjs","sha256":"f576b7f9e311605fe9ef5c8c4dce3140b14aaed385c0181ee0fe9bfee7b9575e"},{"url":"./test-app/tabel/storage-core.mjs","sha256":"4a98267009e04ac55df3136e32074541bc7579c27aad82910597ad6b9c3e9c3e"},{"url":"./test-app/tabel/tabel.css","sha256":"3b09afeed246adda5eec26fdd175ac61e504f8dd78ce54c1361cd40dd41411fe"},{"url":"./test-app/tabel/ui.mjs","sha256":"22076e454243b03c9f7c3b35a4806634eac20f6cd3cebf004a9f6f2255e09970"}];
const BASE = new URL('./', self.location.href);
const PAGE = new URL('index-test.html', BASE).href;
const ALLOWED = new Set(RECORDS.map(r => new URL(r.url, BASE).href));
const COMPLETE = new URL('test-app/.complete-' + VERSION, BASE).href;
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
  if (!port || (type !== 'TEST_PWA_STATUS' && type !== 'TEST_PWA_APPLY')) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const complete = !!await cache.match(COMPLETE);
    if (type === 'TEST_PWA_STATUS') {
      port.postMessage({type:'TEST_PWA_STATUS',version:VERSION,complete});
      return;
    }
    // Only activate a complete, hash-verified release requested explicitly by
    // the user. Never call skipWaiting during automatic installation.
    const accepted = complete && event.data?.version === VERSION;
    port.postMessage({type:'TEST_PWA_APPLY',version:VERSION,accepted});
    if (accepted) await self.skipWaiting();
  })());
});
