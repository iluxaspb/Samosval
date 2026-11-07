// Scope-specific namespace: never remove or read another application's caches.
const BASE = new URL('./', self.location.href);
const PREFIX = 'wincor-android-printer:' + BASE.pathname + ':';
const CACHE = PREFIX + 'v0.1.6';
const FILES = ['./','index.html','style.css','app.js','core.js','usb.js','manifest.webmanifest','assets/ttn.jpg','assets/icon-192.png','assets/icon-512.png'];
self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE).then(cache => cache.addAll(FILES.map(path => new URL(path, BASE).href)))
));
self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim())
));
self.addEventListener('message', event => {
  if (event.data === 'UPDATE') self.skipWaiting();
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request)).then(response => response || fetch(event.request)));
});


