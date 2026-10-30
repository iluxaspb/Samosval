/* Test page only. Cache Storage holds application files, NEVER user data/API replies. */
'use strict';
const VERSION = 'aeb585d1041708ca';
const PREFIX = 'samosval-test-shell-';
const CACHE = PREFIX + VERSION;
const RECORDS = [{"url":"./index-test.html","sha256":"5f3fb3d5dd8eb8efa4aaf53d6c94f5d9264b6fc1fae498790d67e93ec3c4f794"},{"url":"./manifest-test.webmanifest","sha256":"379149c95d8fcf01caa5c2a10e03c934ac29548e60f6e06c6105a3c97137ae27"},{"url":"./test-app/src/pwa.js","sha256":"ba63edcb198227a8352365b4248ded127ae94be98314636719adb164b20b4c41"},{"url":"./test-app/vendor/firebase-app-compat-10.8.0.js","sha256":"94842f6f47f9077e6eec909936bac5924ad95bca8db73425dd48715f47a9d5b6"},{"url":"./test-app/vendor/firebase-auth-compat-10.8.0.js","sha256":"3adf710ab8cffed4e8afc1e4368e636d8f97633409291c39f83500516526a524"},{"url":"./test-app/vendor/firebase-firestore-compat-10.8.0.js","sha256":"1b122566975332a8b7059e1b435df73122b6e4947b312360b518936be219b6fc"},{"url":"./test-app/vendor/html2pdf-0.10.1.bundle.min.js","sha256":"85e6ee9ce246e3ae4424313f7e46a5ed860a28d757811de8dc9c43f306049d65"},{"url":"./test-app/vendor/caveat.css","sha256":"51379e1bf96c50d0ebabe82c65a8d426ba516e1c9d9fc6916a35dcdad2f55863"},{"url":"./test-app/vendor/caveat-0.ttf","sha256":"012f33f9814bf9614973983335c3a375fe267c094e7c09a02a276cd1dcd4180a"},{"url":"./test-app/vendor/caveat-1.ttf","sha256":"f4365d9874c1b64026aca48786cf835a5decf2c740c06de04dbb05ce8c93ff37"},{"url":"./test-app/icons/icon-192.png","sha256":"cb63c9b1cab9bfe3b4946d03b2f46772083c76ad03938e4f24581cd4480cedc4"},{"url":"./test-app/icons/icon-512.png","sha256":"4e57fcca475e0141b5242f471600fe4cc9e527be267e8337b927b3e2e99d9e64"},{"url":"./test-app/vendor/exceljs-4.4.0.min.js","sha256":"7e49da68588e250dbb8bba190d2caa8ab3787cc0284bda1d8b2f805c4df742c9"},{"url":"./test-app/tabel-v2/backend.mjs","sha256":"29e6f294887577362a64ccc7d8c675664a36cb7bac15de285ace6d0506891fb4"},{"url":"./test-app/tabel-v2/catalog.mjs","sha256":"ba3f39024f12c0420f93134cbc979bc8063954e42a9fbe6ad6953e916f557dda"},{"url":"./test-app/tabel-v2/color-palette.mjs","sha256":"b2383a2455b3bf2c846db7f754964af4b49cfde9b3ceb121807fe641257c3860"},{"url":"./test-app/tabel-v2/conflict-view.mjs","sha256":"6dc13b8bb33c78552f3d07dc97aaf3725d45917b5d2abe88e1a9aea605a5e1c7"},{"url":"./test-app/tabel-v2/domain.mjs","sha256":"a5c2a103e7bd7e60ae853366421dd399f7558d9118a4b7ec1b24715dba1d4618"},{"url":"./test-app/tabel-v2/entry.mjs","sha256":"81c5c8cc9a3b10efbc530abe234f1463aa025022a2e96584afdab32ab3136701"},{"url":"./test-app/tabel-v2/file-transfer.mjs","sha256":"2f3eedf211ca9dbe441d2a7fec8f52446c5dded1329d25b9d48ea164725ea22f"},{"url":"./test-app/tabel-v2/formula-catalog.mjs","sha256":"7463d9a22af0e8024a404a87ef07bec4c2135e5c1b7c5253dfeb61553db16149"},{"url":"./test-app/tabel-v2/formula-engine.mjs","sha256":"86ae1a034542b10542065d390998efe577eaa30a0b60401cdf94ea59e3e3432d"},{"url":"./test-app/tabel-v2/formula-help.mjs","sha256":"0d4b12b67f45112ee27a7cef5bfe90bdeac1c41ed6a464aaeecd4b12d275156e"},{"url":"./test-app/tabel-v2/formula-syntax.mjs","sha256":"3cc6a5eeaf4e2a3122d6f935f54c8453c1f7dca4e361ea277ba8cdf32648926b"},{"url":"./test-app/tabel-v2/grid.mjs","sha256":"f004bc8ac7578a204e50a699a283a6a8ee951cfa4ab9dc8f901248377354e0ec"},{"url":"./test-app/tabel-v2/history-view.mjs","sha256":"1e394ecf298456aa01c0103ba7d361764381d2f465bf569bfc1e520fb1b95401"},{"url":"./test-app/tabel-v2/legacy-equipment.mjs","sha256":"a7240a6e395d4b2aaf323caa74a6aa26b3f02093bc796e7d39c875ab6cf92248"},{"url":"./test-app/tabel-v2/line.mjs","sha256":"11eb614739a4ba08f4433f88e3263d7b93af2d6fe4b1fa11490520208209b869"},{"url":"./test-app/tabel-v2/material-transfer.mjs","sha256":"fe3469543722d954340f7f0e4aed20ece529bb7691f5bd8b2a544e8270238894"},{"url":"./test-app/tabel-v2/merge-record.mjs","sha256":"cc8b8059761b7da46292e5dc8a2545d8f0cd36496bf177df70487b9c161a7ceb"},{"url":"./test-app/tabel-v2/messages.mjs","sha256":"ce4fbb130b34df12c9d6fc2f0f4f6edac2b5a18cd04fa6d9f0b1fc132340cc3c"},{"url":"./test-app/tabel-v2/migration.mjs","sha256":"9444ec78ad96e9398f16f28936d487c9f12473cd4182bd0bd4bc559f6a0ea532"},{"url":"./test-app/tabel-v2/number-input.mjs","sha256":"f5574bb9e699167fd1bcca693de0a0ffa7fe2c3de9b9448fc81298b032f204a9"},{"url":"./test-app/tabel-v2/object-default.mjs","sha256":"5d6fbba81e73a060da7ac4a031fbafa3c3a04fea85aa5f4b091c86ae1c18a310"},{"url":"./test-app/tabel-v2/online-policy.mjs","sha256":"026f0e039c1744573afa1bb4199da5e154a983ac0984e5614391964a9229e86e"},{"url":"./test-app/tabel-v2/pdf-transfer.mjs","sha256":"48fe8f20c2a4a3bdc3bccb3ecb624292e05fef8a6dea05e8a3613a2da1d10b7e"},{"url":"./test-app/tabel-v2/permissions.mjs","sha256":"88c1ccb5634f7de93d8be804005ae8b0334bf767aa6ba1e65c7dc912f06482f5"},{"url":"./test-app/tabel-v2/presence-nas.mjs","sha256":"16ba62f87bd171a2930e7d87285b3a2d7a875e8f5e774f73cc58536594d34510"},{"url":"./test-app/tabel-v2/presence.mjs","sha256":"1fa71dbb4d5533c08f5dcbfea24bed183fdb9f6be1db998edf2963a4d212cad2"},{"url":"./test-app/tabel-v2/read-flight.mjs","sha256":"c717790fce4999d16a8d8e37387fe07753a89377a08fbd93dffcaaccf81c6ce2"},{"url":"./test-app/tabel-v2/request-domain.mjs","sha256":"aabbf8e3934a9849ca8d2c40756db54e9dab3976c16eb2a32355a2fc71c41ce6"},{"url":"./test-app/tabel-v2/settings-menu.mjs","sha256":"145cacff52610d5008ef0e5795e39d7ad2dec20fb522a31fea962a6a593fc23e"},{"url":"./test-app/tabel-v2/sheet-access.mjs","sha256":"46d29ea6e8bea20d8723a42c022b2db8b052c2b45e762ed4876958112175cd91"},{"url":"./test-app/tabel-v2/shift-cards.mjs","sha256":"dc2bebac72a53f6db32b71caa1186b05d3ae01c2be97ce643b34a7963458ace6"},{"url":"./test-app/tabel-v2/store.mjs","sha256":"36f0b9de97703b8979ce38b6eda2e74d6fdc9efb2a1ff3c153ecc23686902c1e"},{"url":"./test-app/tabel-v2/summary.mjs","sha256":"d3f04bd2d7ac39b7d4f64eda0be9386d00cf54e3907ab5cc88def3fd15c576af"},{"url":"./test-app/tabel-v2/table-domain.mjs","sha256":"a9ce4a31c3312fdc5c18df112a3ab1e093bb8adf7db6280554b451569869f37c"},{"url":"./test-app/tabel-v2/ui.css","sha256":"23bd0c0275cabbd4806ba67ce855edb6443f2c023ef7dab7370c36a0d7bdb48a"},{"url":"./test-app/tabel-v2/ui.mjs","sha256":"cd0fdf2d404c01d6240ed4885e2a216686bf2ac3c1230bffabcaae643abf1ef9"},{"url":"./test-app/tabel-v2/view.html","sha256":"08513346c5c9ce5f65b8e3fbd76bc5f226117ac843582a80c71b0542f197ba5c"},{"url":"./test-app/tabel-v2/workspace.css","sha256":"c3509e00e3ae0624677e932505d9df5c6887bcfb71d969803350dabcbdd09f9d"},{"url":"./test-app/tabel-v2/workspace.mjs","sha256":"af0a6b1106429b9cf43bd797490f540fb1c5313b00805fda6563d29000dd5d55"},{"url":"./test-app/build/aeb585d1041708ca/built-in-patches.js","sha256":"4f43da50cc9d49b1f3d0778f671d80154518ca47b3d0c89f6c20c72cbe305238"},{"url":"./test-app/build/aeb585d1041708ca/closed-shift-duplicates.js","sha256":"8f49eecc63385ed402d789c811458e8a15dc400208c68d99b81f15e350b07155"},{"url":"./test-app/build/aeb585d1041708ca/confirm-bridge.js","sha256":"c8649b01fe4060878492f0723080f0f41f88a0adce8a08b3c32bcbf2a99f588e"},{"url":"./test-app/build/aeb585d1041708ca/core.js","sha256":"fa60a9f57207920b393da7906d11a0886d4c14f2bcf54091c7e7a5ec32a84a94"},{"url":"./test-app/build/aeb585d1041708ca/firebase-traffic-dashboard.js","sha256":"2fbbe5a7eaee83d4921fc2873d769866ca2a5d2d3762d3a662ae1bf86ce8a2d7"},{"url":"./test-app/build/aeb585d1041708ca/firebase-traffic-hook.js","sha256":"3fef9e5baa93925de8d60286b90840f1057aedf8633d6e92041717d480c33129"},{"url":"./test-app/build/aeb585d1041708ca/firebase-traffic-inference.js","sha256":"65093633cd300a9e7c2a9da78142049ef544392f71b835297b007b852247f13e"},{"url":"./test-app/build/aeb585d1041708ca/gai-report-toggle.js","sha256":"584a1b9bfb8c3edd8229fe73be5db55788dc251c182b545c27a4cac1b9c1455a"},{"url":"./test-app/build/aeb585d1041708ca/game-coins-v2.js","sha256":"5862946d52d4cbfec475ac911330d051c7bb928558fd5e188de86c844aca219b"},{"url":"./test-app/build/aeb585d1041708ca/global-interface-haptics.js","sha256":"cb9695c568c866a5403268629d6b07629b0a2444de1ced98b088e027963b0d7f"},{"url":"./test-app/build/aeb585d1041708ca/history-recorder.js","sha256":"5055dbd55b08ac58520cc8ab10cc1d5942e736a53830640cbaf797b4cdcb4398"},{"url":"./test-app/build/aeb585d1041708ca/line-card-layers.js","sha256":"b3049b4af37f4ec202fb4685b9008dd7fa290057df5c91717cdc4c60ad343ba0"},{"url":"./test-app/build/aeb585d1041708ca/offline-feedback.js","sha256":"94b6082bc2d2939da2214787ad258b870c426ef0475220b7dd364d3959498db7"},{"url":"./test-app/build/aeb585d1041708ca/paper-viewer.js","sha256":"4ae0a1ebb39d64df2a41a284b8651ee2c698fe2472e843debc5aafc4b956a151"},{"url":"./test-app/build/aeb585d1041708ca/release-history.js","sha256":"2f5f339cc24494ac4c463a0497a45bd25a92a0daf2d82e31fab9c47436303a33"},{"url":"./test-app/build/aeb585d1041708ca/reset-settings.js","sha256":"416078dbe3a699fe4d25a3eedc5a97edabe705732715aac90bfb13b09f5af335"},{"url":"./test-app/build/aeb585d1041708ca/road-arcade-core.js","sha256":"10da96381e9f6662cf571a05a08839a9cc369440a289de656ba4ce1e1bfaee3f"},{"url":"./test-app/build/aeb585d1041708ca/road-arcade-runtime.js","sha256":"b671f8d7a950b149127a54a9561d19f20b24a18439ba3285920db67eb58831c4"},{"url":"./test-app/build/aeb585d1041708ca/road-arcade-ui.js","sha256":"8100b57c5d253bca2a0f3894ca4631dca5cbab8367e9e9a8fee6cf261b1c9463"},{"url":"./test-app/build/aeb585d1041708ca/road-jokes-v1.js","sha256":"8034c5a9d0f83742e7007c57e9ed2cc6927054f4666bb5daef88f1fdf0b506ea"},{"url":"./test-app/build/aeb585d1041708ca/road-season-effects-v1.js","sha256":"280137ae4c6e677516c0d5171b7ec822f8d11150bc26e25afe81a220ec53bd00"},{"url":"./test-app/build/aeb585d1041708ca/road-shop-v1.js","sha256":"6331cb853a83b2a025650ce9272e20f46cc796a4c4ce17b100b1a7b652a94ff2"},{"url":"./test-app/build/aeb585d1041708ca/settings-hub.js","sha256":"23ed7100ec57cb522adaf9839fb39ceb73ba3cdb711dd44aad9ef4cff0561438"},{"url":"./test-app/build/aeb585d1041708ca/test-release.js","sha256":"62f62c6a5e577444fa01e7b65a51a6e36f487685ea5dffa952d207b5f81324c3"},{"url":"./test-app/build/aeb585d1041708ca/trip-analytics.js","sha256":"1782f14ac8deb2a5794574e9ce56bc51aacbf8ab48050a114b4e63ab3c745dc1"},{"url":"./test-app/tabel/app.mjs","sha256":"dca1cd65378fc0c94b4b9f41520a959f1169a24ad4c21d045adb649ac3bd8065"},{"url":"./test-app/tabel/catalog.mjs","sha256":"598ead803702aea2060956ecbac3ef2ffe68652d8c9fabd84ac154bbde1e1757"},{"url":"./test-app/tabel/domain.mjs","sha256":"597748f872aa45c73ca1f91a463b16f97190d6988cfcdd323a9b3148bc7d9d23"},{"url":"./test-app/tabel/editor.mjs","sha256":"876614080d9e3ff2f0fa45b196251cc4e75d2bf96f06b2aa8d600277ce294c71"},{"url":"./test-app/tabel/entry.mjs","sha256":"fde4a95e6083e37c51f5db3ba66ce38753dfb1faaeb83f65d49ade4055f93811"},{"url":"./test-app/tabel/forms.mjs","sha256":"b3b4e9197270345a559ea07552674e2992f67f4946b54033926ba3704a64a923"},{"url":"./test-app/tabel/plugin.js","sha256":"9ab13bc8c55d2901181a5592e24bf4c861c0cfedf8010e0eb511a2be6c216fb3"},{"url":"./test-app/tabel/report.mjs","sha256":"fb072967cc642b0cdeb1db9e71d16a2c84bdb8eb1d50a29e7c1ac7807565ddab"},{"url":"./test-app/tabel/request.mjs","sha256":"ffbe528d2fba452439ce1fb74ee8700af0159335eb4538da2cf41059ee62bb8c"},{"url":"./test-app/tabel/service.mjs","sha256":"4351a34713a77b289487bb42061499ad2ba80d26147618b345238ca576332e46"},{"url":"./test-app/tabel/settings.mjs","sha256":"3dfdafac5465bdf06faff877fb0f98f165c130739f93bb4a14cebfc910043846"},{"url":"./test-app/tabel/shift.mjs","sha256":"f576b7f9e311605fe9ef5c8c4dce3140b14aaed385c0181ee0fe9bfee7b9575e"},{"url":"./test-app/tabel/storage-core.mjs","sha256":"4a98267009e04ac55df3136e32074541bc7579c27aad82910597ad6b9c3e9c3e"},{"url":"./test-app/tabel/tabel.css","sha256":"3b09afeed246adda5eec26fdd175ac61e504f8dd78ce54c1361cd40dd41411fe"},{"url":"./test-app/tabel/ui.mjs","sha256":"22076e454243b03c9f7c3b35a4806634eac20f6cd3cebf004a9f6f2255e09970"},{"url":"./test-app/synology/connection-check.mjs","sha256":"cadb814a81941a4afc2127a2c3c5ac96599ee674e919a888c08212cd130ecdb0"},{"url":"./test-app/synology/session-client.mjs","sha256":"fb391934c15804e2f04a1fa28891e1c0847ec99a729b0ce1965e0afb1816d6c2"},{"url":"./test-app/synology/tabel-remote.mjs","sha256":"347db821746f39aeff9b1cde6f04137411e51d0ec4736a97880ae2d222ac319a"}];
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
