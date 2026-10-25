/* Emergency rollback of production 4.0. User data and test installation stay intact. */
'use strict';
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  // Claim before removing the obsolete shell; never reload an operator's page.
  await self.clients.claim();
  for (const key of await caches.keys()) {
    if (key.startsWith('samosval-shell-')) await caches.delete(key);
  }
  await self.registration.unregister();
})()));
// No fetch interception, localStorage or IndexedDB changes.
