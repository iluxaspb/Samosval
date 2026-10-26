/* Test page only. Cache Storage holds application files, NEVER user data/API replies. */
'use strict';
const VERSION = '40edb1fa15971a82';
const PREFIX = 'samosval-test-shell-';
const CACHE = PREFIX + VERSION;
const RECORDS = [{"url": "./index-test.html", "sha256": "3afaded9464399659b2598db73a593687120473f3eb81e2a39d131b032f8f1a3"}, {"url": "./manifest-test.webmanifest", "sha256": "988ba7e5dc3e3d632b757cff04bb5a4023ae4ea133c8f6bd63aebaf5c836e589"}, {"url": "./test-app/build/40edb1fa15971a82/archive-test-layout-20261025.css", "sha256": "16239d85763a6babfcea71e9d2e1185010882a0b5280484cb2c218cd92cdfaa6"}, {"url": "./test-app/build/40edb1fa15971a82/base.css", "sha256": "555c078a03b371aec23d881e873f25517f9c5c51d7dd2f7576f99e16e46141cd"}, {"url": "./test-app/build/40edb1fa15971a82/built-in-features.js", "sha256": "ebce9629fab8e85ee1e26d788d222aed73a39db37da36e75b89bf1b1d7d26df4"}, {"url": "./test-app/build/40edb1fa15971a82/closed-shift-duplicates.js", "sha256": "8f49eecc63385ed402d789c811458e8a15dc400208c68d99b81f15e350b07155"}, {"url": "./test-app/build/40edb1fa15971a82/confirmation-adapter.js", "sha256": "c8649b01fe4060878492f0723080f0f41f88a0adce8a08b3c32bcbf2a99f588e"}, {"url": "./test-app/build/40edb1fa15971a82/core.js", "sha256": "2245114368f4e0c3de7f63378dc4283fb636504ad01efce73d45b8e955d2d559"}, {"url": "./test-app/build/40edb1fa15971a82/game-coins-style.css", "sha256": "889173f219331afe1144c8548a75c244b928987416f62a36fdffb98fcdcdf337"}, {"url": "./test-app/build/40edb1fa15971a82/game-coins-v2.js", "sha256": "a4d57b92af89abd2deb65c78c5a08fc1fdb19bd97888c7912958db7cb2442060"}, {"url": "./test-app/build/40edb1fa15971a82/history-recorder.js", "sha256": "646c2e77897db9b13989d244d7542615b37ab949360b3530a0116ce933d477c4"}, {"url": "./test-app/build/40edb1fa15971a82/line-card-layers.js", "sha256": "b3049b4af37f4ec202fb4685b9008dd7fa290057df5c91717cdc4c60ad343ba0"}, {"url": "./test-app/build/40edb1fa15971a82/max-plate-notifications.js", "sha256": "ad76f6121fc40ed6a53824b0a9e493a3c473834131796e6d45059eccef1ab9b5"}, {"url": "./test-app/build/40edb1fa15971a82/offline-feedback.js", "sha256": "94b6082bc2d2939da2214787ad258b870c426ef0475220b7dd364d3959498db7"}, {"url": "./test-app/build/40edb1fa15971a82/offline-load-solo-style.css", "sha256": "5bb961c257c4b2ee387cc37fe8b6ffbfdaa16f85a61755a9e06637da159a5b72"}, {"url": "./test-app/build/40edb1fa15971a82/pwa.js", "sha256": "cb529c5e4374b1b4398b8d9ab95e313b971cce8a1e600db14f1f161a62462ef5"}, {"url": "./test-app/build/40edb1fa15971a82/release-history.js", "sha256": "7a9b139d93da08ad246ba6e492d9922e1ddc0b7f545d380da5883ad40d931b1f"}, {"url": "./test-app/build/40edb1fa15971a82/review-config.js", "sha256": "fa398d41f48b46336b758aded932f431ae666d745151a79b7e0057efea1c00f4"}, {"url": "./test-app/build/40edb1fa15971a82/road-arcade-core.js", "sha256": "10da96381e9f6662cf571a05a08839a9cc369440a289de656ba4ce1e1bfaee3f"}, {"url": "./test-app/build/40edb1fa15971a82/road-arcade-runtime.js", "sha256": "cac8c82ca0c215c2cf4ed8094cc89149458be7c27d0d52e037b64317b3f76e80"}, {"url": "./test-app/build/40edb1fa15971a82/road-arcade-style.css", "sha256": "07d479db20ededc54ecd6a8bc2769b528ebeda20bad4037f7b47ff63d0261ee2"}, {"url": "./test-app/build/40edb1fa15971a82/road-arcade-ui.js", "sha256": "e017a9adb44f2b84ea0e3ab864c97580497b47ebf47ccfd1d3c3538261c4fde5"}, {"url": "./test-app/build/40edb1fa15971a82/road-jokes-style.css", "sha256": "8d5f0225bbadcb005ed8b35c42da8522d10c6c2325cdd083cdaa7355bd89dd55"}, {"url": "./test-app/build/40edb1fa15971a82/road-jokes-v1.js", "sha256": "a76c09f983b0c98a75cbddfac41aa32f2b96c06cf9bcc17a628042078bb20f2d"}, {"url": "./test-app/build/40edb1fa15971a82/road-season-effects-style.css", "sha256": "1316108b882c07cc196303c3411877ecc6adad7152cf9187033d0e333f86e34e"}, {"url": "./test-app/build/40edb1fa15971a82/road-season-effects-v1.js", "sha256": "84b2611e7e5555ea586558632f04e813633317041237b906fd439ee8274034ee"}, {"url": "./test-app/build/40edb1fa15971a82/road-shop-style.css", "sha256": "03556c119e329120dab1ee04b4dfcc394b8dfe079bade748131a1d554f5ef88a"}, {"url": "./test-app/build/40edb1fa15971a82/road-shop-v1.js", "sha256": "cd0620342fa047eea4cd2bde4e7b1fcd0967fc373f5d76cc3db93810b427bb68"}, {"url": "./test-app/build/40edb1fa15971a82/summary-hold.js", "sha256": "584a1b9bfb8c3edd8229fe73be5db55788dc251c182b545c27a4cac1b9c1455a"}, {"url": "./test-app/build/40edb1fa15971a82/summary-viewer.js", "sha256": "452edec9e65c7a48929221af761992e589ad21c69af4126d02d180f37257e8fc"}, {"url": "./test-app/build/40edb1fa15971a82/test-analytics-compact-20261025.css", "sha256": "7007e9498438bbd81eb63a96471eb34b502dfd11cf649eef40f0552713fdef76"}, {"url": "./test-app/build/40edb1fa15971a82/test-review-core.js", "sha256": "8607c3cf8da44c0c03b80d538cc903b8f47349d25a9da1707a7903353f64ebd7"}, {"url": "./test-app/build/40edb1fa15971a82/timesheet-app.js", "sha256": "b42ff6ce485150a99865e5359a5015300431ec778b4d73ba79b5237e2a2712de"}, {"url": "./test-app/build/40edb1fa15971a82/timesheet-core.js", "sha256": "85e282fe2ce0223f71f1215e2d9826c4ab3747aed62012533cea82a0f125907e"}, {"url": "./test-app/build/40edb1fa15971a82/timesheet-css.css", "sha256": "eef779cfa5fdd0edad39ca45793549b49050e4b13858d65cfb49a665a060157a"}, {"url": "./test-app/build/40edb1fa15971a82/trip-analytics.js", "sha256": "98d90f9a4ce3323a80882b38cbd94c3af4361cd06633354326a5b77889b08e19"}, {"url": "./test-app/build/40edb1fa15971a82/work-report.js", "sha256": "271356fd614d43a6e24d19e2758bd3132acd8c4d075ec59a15fe3d0acca711cf"}, {"url": "./test-app/vendor/caveat-0.ttf", "sha256": "012f33f9814bf9614973983335c3a375fe267c094e7c09a02a276cd1dcd4180a"}, {"url": "./test-app/vendor/caveat-1.ttf", "sha256": "f4365d9874c1b64026aca48786cf835a5decf2c740c06de04dbb05ce8c93ff37"}, {"url": "./test-app/vendor/caveat.css", "sha256": "51379e1bf96c50d0ebabe82c65a8d426ba516e1c9d9fc6916a35dcdad2f55863"}, {"url": "./test-app/vendor/firebase-app-compat-10.8.0.js", "sha256": "94842f6f47f9077e6eec909936bac5924ad95bca8db73425dd48715f47a9d5b6"}, {"url": "./test-app/vendor/firebase-auth-compat-10.8.0.js", "sha256": "3adf710ab8cffed4e8afc1e4368e636d8f97633409291c39f83500516526a524"}, {"url": "./test-app/vendor/firebase-firestore-compat-10.8.0.js", "sha256": "1b122566975332a8b7059e1b435df73122b6e4947b312360b518936be219b6fc"}, {"url": "./test-app/vendor/html2pdf-0.10.1.bundle.min.js", "sha256": "85e6ee9ce246e3ae4424313f7e46a5ed860a28d757811de8dc9c43f306049d65"}, {"url": "./test-app/icons/icon-192.png", "sha256": "cb63c9b1cab9bfe3b4946d03b2f46772083c76ad03938e4f24581cd4480cedc4"}, {"url": "./test-app/icons/icon-512.png", "sha256": "4e57fcca475e0141b5242f471600fe4cc9e527be267e8337b927b3e2e99d9e64"}];
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
