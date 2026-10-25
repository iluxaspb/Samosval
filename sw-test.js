/* Test page only. Cache Storage holds application files, NEVER user data/API replies. */
'use strict';
const VERSION = '93c3fea4099fbd8a';
const PREFIX = 'samosval-test-shell-';
const CACHE = PREFIX + VERSION;
const RECORDS = [{"url": "./index-test.html", "sha256": "69472bd1919f0d46b980263ef1aa2c11952162824fe6a0bd5d7168f97b2db741"}, {"url": "./manifest-test.webmanifest", "sha256": "988ba7e5dc3e3d632b757cff04bb5a4023ae4ea133c8f6bd63aebaf5c836e589"}, {"url": "./test-app/build/93c3fea4099fbd8a/archive-test-layout-20261025.css", "sha256": "16239d85763a6babfcea71e9d2e1185010882a0b5280484cb2c218cd92cdfaa6"}, {"url": "./test-app/build/93c3fea4099fbd8a/base.css", "sha256": "1c4bcfc803a2f7f622a427c4182cc8a63bc8ae0ef4a4a3199428f90fc2ad6e65"}, {"url": "./test-app/build/93c3fea4099fbd8a/built-in-features.js", "sha256": "3d9060e64d0880462d15e2738feda8d68ed65674c2edef7f0f63f17fb9124713"}, {"url": "./test-app/build/93c3fea4099fbd8a/closed-shift-duplicates.js", "sha256": "8f49eecc63385ed402d789c811458e8a15dc400208c68d99b81f15e350b07155"}, {"url": "./test-app/build/93c3fea4099fbd8a/confirmation-adapter.js", "sha256": "c8649b01fe4060878492f0723080f0f41f88a0adce8a08b3c32bcbf2a99f588e"}, {"url": "./test-app/build/93c3fea4099fbd8a/core.js", "sha256": "c04712465f985d35e3d03651e2ef3e90ec3d936015f0542f3bce2b59a578fb98"}, {"url": "./test-app/build/93c3fea4099fbd8a/game-coins-style.css", "sha256": "e7cb2b4093d28a8f7cee3acc1bc8197b7e320b5a023f2c285e9b3e8d0166bbd0"}, {"url": "./test-app/build/93c3fea4099fbd8a/game-coins-v2.js", "sha256": "a3112c91eff7fbbe3f5690655881778e25b1082461778d50c95d3ae4d3091f15"}, {"url": "./test-app/build/93c3fea4099fbd8a/geo-photo-script.js", "sha256": "57657b2f6f721937079cf22e03c07dc43f3f87ebfe45a02126d8f0873042d4e9"}, {"url": "./test-app/build/93c3fea4099fbd8a/geo-photo-style.css", "sha256": "ba7f911c82400a593433bf3c3da268ee5856a02dc5c7baff9c799701f0ec8f7b"}, {"url": "./test-app/build/93c3fea4099fbd8a/history-recorder.js", "sha256": "962245b295e1a166d9a565192274e5faa4d42df85e86c3ab2ff0324a69b057e6"}, {"url": "./test-app/build/93c3fea4099fbd8a/line-card-layers.js", "sha256": "b3049b4af37f4ec202fb4685b9008dd7fa290057df5c91717cdc4c60ad343ba0"}, {"url": "./test-app/build/93c3fea4099fbd8a/local-photos-style.css", "sha256": "f851a5967d3f436f284a0cd69c7219424a4274397964257cb08f2783d93f7c70"}, {"url": "./test-app/build/93c3fea4099fbd8a/local-photos-ui.js", "sha256": "7156ede41fd12306c4fa96af675ed6a5ea608a3f0944d1fd4996a4fb9a56bfdc"}, {"url": "./test-app/build/93c3fea4099fbd8a/max-plate-notifications.js", "sha256": "dfd4a74ba3510cbe193b3ca19a2fb0f1fbcd06459bb1e698d82024f5e48eaa81"}, {"url": "./test-app/build/93c3fea4099fbd8a/object-photos-service.js", "sha256": "ee4a21e3b58fdcd624b15f0043b4de68a7070c1397f3cb9e7aba8bf83f639c03"}, {"url": "./test-app/build/93c3fea4099fbd8a/object-photos-style.css", "sha256": "2bca9280cb342c58b6a15b8bad80aba1cba7f19fb62bfe1d130e645a034dd274"}, {"url": "./test-app/build/93c3fea4099fbd8a/object-photos-ui.js", "sha256": "92baaa04cec4b33606d268b6f21d2e36e1f8619c852706272835f209ee8315c7"}, {"url": "./test-app/build/93c3fea4099fbd8a/offline-feedback.js", "sha256": "94b6082bc2d2939da2214787ad258b870c426ef0475220b7dd364d3959498db7"}, {"url": "./test-app/build/93c3fea4099fbd8a/offline-load-solo-style.css", "sha256": "5bb961c257c4b2ee387cc37fe8b6ffbfdaa16f85a61755a9e06637da159a5b72"}, {"url": "./test-app/build/93c3fea4099fbd8a/photo-files.js", "sha256": "6cb6df21319dd711f1523be6dbc2112b5185adc0aa4f47fa3ef72f563940b94c"}, {"url": "./test-app/build/93c3fea4099fbd8a/pwa.js", "sha256": "c91d0ff454e4e0ce3ae33142056602f92c2ba66aa8da791159e3697d519bb6e7"}, {"url": "./test-app/build/93c3fea4099fbd8a/release-history.js", "sha256": "9d435410332d840ea5382ec263ec1f60f3107a4d90a7e1dbb95f86ac3019c79f"}, {"url": "./test-app/build/93c3fea4099fbd8a/review-config.js", "sha256": "b3a29627cbcff104707fcbfbee1f4fb522aba116320b77816cfb2021decf35ad"}, {"url": "./test-app/build/93c3fea4099fbd8a/road-arcade-core.js", "sha256": "10da96381e9f6662cf571a05a08839a9cc369440a289de656ba4ce1e1bfaee3f"}, {"url": "./test-app/build/93c3fea4099fbd8a/road-arcade-runtime.js", "sha256": "cac8c82ca0c215c2cf4ed8094cc89149458be7c27d0d52e037b64317b3f76e80"}, {"url": "./test-app/build/93c3fea4099fbd8a/road-arcade-style.css", "sha256": "07d479db20ededc54ecd6a8bc2769b528ebeda20bad4037f7b47ff63d0261ee2"}, {"url": "./test-app/build/93c3fea4099fbd8a/road-arcade-ui.js", "sha256": "e017a9adb44f2b84ea0e3ab864c97580497b47ebf47ccfd1d3c3538261c4fde5"}, {"url": "./test-app/build/93c3fea4099fbd8a/road-jokes-style.css", "sha256": "8d5f0225bbadcb005ed8b35c42da8522d10c6c2325cdd083cdaa7355bd89dd55"}, {"url": "./test-app/build/93c3fea4099fbd8a/road-jokes-v1.js", "sha256": "a76c09f983b0c98a75cbddfac41aa32f2b96c06cf9bcc17a628042078bb20f2d"}, {"url": "./test-app/build/93c3fea4099fbd8a/road-season-effects-style.css", "sha256": "1316108b882c07cc196303c3411877ecc6adad7152cf9187033d0e333f86e34e"}, {"url": "./test-app/build/93c3fea4099fbd8a/road-season-effects-v1.js", "sha256": "84b2611e7e5555ea586558632f04e813633317041237b906fd439ee8274034ee"}, {"url": "./test-app/build/93c3fea4099fbd8a/road-shop-style.css", "sha256": "03556c119e329120dab1ee04b4dfcc394b8dfe079bade748131a1d554f5ef88a"}, {"url": "./test-app/build/93c3fea4099fbd8a/road-shop-v1.js", "sha256": "cd0620342fa047eea4cd2bde4e7b1fcd0967fc373f5d76cc3db93810b427bb68"}, {"url": "./test-app/build/93c3fea4099fbd8a/summary-hold.js", "sha256": "51c7baa1026486b2c817b9b505c77ac3d977a74cfe48a6788d11e1186fa1cba7"}, {"url": "./test-app/build/93c3fea4099fbd8a/summary-viewer.js", "sha256": "9f82ca990a8ecac5c003fc3d3488114e886598643583438070df1d9657f2ccff"}, {"url": "./test-app/build/93c3fea4099fbd8a/test-analytics-compact-20261025.css", "sha256": "7007e9498438bbd81eb63a96471eb34b502dfd11cf649eef40f0552713fdef76"}, {"url": "./test-app/build/93c3fea4099fbd8a/test-review-core.js", "sha256": "964e365595c4559c1d11a80bd26917c01d01e0cfa6865d54f709b36125094d9c"}, {"url": "./test-app/build/93c3fea4099fbd8a/timesheet-app.js", "sha256": "e85556f66369f89fb4df03781b26717b7ea38aee6ce49a06b0b48872cd10371e"}, {"url": "./test-app/build/93c3fea4099fbd8a/timesheet-core.js", "sha256": "bb732af49a2e5a48e6dcbd17daf2fa967aa3b813ad0e8b7954cb728650f85a81"}, {"url": "./test-app/build/93c3fea4099fbd8a/timesheet-css.css", "sha256": "eef779cfa5fdd0edad39ca45793549b49050e4b13858d65cfb49a665a060157a"}, {"url": "./test-app/build/93c3fea4099fbd8a/trip-analytics.js", "sha256": "98d90f9a4ce3323a80882b38cbd94c3af4361cd06633354326a5b77889b08e19"}, {"url": "./test-app/build/93c3fea4099fbd8a/work-report.js", "sha256": "271356fd614d43a6e24d19e2758bd3132acd8c4d075ec59a15fe3d0acca711cf"}, {"url": "./test-app/vendor/caveat-0.ttf", "sha256": "012f33f9814bf9614973983335c3a375fe267c094e7c09a02a276cd1dcd4180a"}, {"url": "./test-app/vendor/caveat.css", "sha256": "51379e1bf96c50d0ebabe82c65a8d426ba516e1c9d9fc6916a35dcdad2f55863"}, {"url": "./test-app/vendor/firebase-auth-compat-10.8.0.js", "sha256": "3adf710ab8cffed4e8afc1e4368e636d8f97633409291c39f83500516526a524"}, {"url": "./test-app/vendor/firebase-firestore-compat-10.8.0.js", "sha256": "1b122566975332a8b7059e1b435df73122b6e4947b312360b518936be219b6fc"}, {"url": "./test-app/vendor/caveat-1.ttf", "sha256": "f4365d9874c1b64026aca48786cf835a5decf2c740c06de04dbb05ce8c93ff37"}, {"url": "./test-app/vendor/firebase-storage-compat-10.8.0.js", "sha256": "a93a20f09fd70fda9434c45abb0e386005148f843f31111488c9912c107dd7ba"}, {"url": "./test-app/vendor/html2pdf-0.10.1.bundle.min.js", "sha256": "85e6ee9ce246e3ae4424313f7e46a5ed860a28d757811de8dc9c43f306049d65"}, {"url": "./test-app/vendor/firebase-app-compat-10.8.0.js", "sha256": "94842f6f47f9077e6eec909936bac5924ad95bca8db73425dd48715f47a9d5b6"}, {"url": "./test-app/icons/icon-192.png", "sha256": "cb63c9b1cab9bfe3b4946d03b2f46772083c76ad03938e4f24581cd4480cedc4"}, {"url": "./test-app/icons/icon-512.png", "sha256": "4e57fcca475e0141b5242f471600fe4cc9e527be267e8337b927b3e2e99d9e64"}];
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
  if (event.data?.type !== 'TEST_PWA_STATUS' || !event.ports?.[0]) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const complete = !!await cache.match(COMPLETE);
    event.ports[0].postMessage({type:'TEST_PWA_STATUS',version:VERSION,complete});
  })());
});
