# TEST 4.0.2: NAS/VPN installation evidence — 2026-10-30

The user's mobile connection worked normally while VPN caused historical game/auxiliary/archive reads to time out. Published TEST originally had build d575058362b02368 and the old NAS client.

## Published client
PR #65 merged as 247206bc9f4d6063db0fd0aeda32516e5bbc07ae. The public index reports version 4.0.2 and build 25139ff6198e59a9. The served session-client SHA256 is 6039bd40a72975dff1d780e7fcc47b3c8b4d9fe8d55ee9ac4dc4366ed09acc96, identical to merged source. Root publish 41056662044, Pages 41056662075 and modular audit 41056663125 passed. Browser integration 41055796433 and server checks on the PR passed.

## NAS API
The first installation log confirmed only the two transport files, so the compact game API was installed separately using deploy-vpn-games-402-20261030.sh. It builds from the verified release-402-20261030 image and only replaces four pinned source files. No migration SQL, game bets, shift writes, or production changes were executed.

The second installation log, timestamp 15:55:47 DSM time, confirms:
- all four source hashes match the pinned source;
- DATABASE_BACKUP_RESTORE_VERIFIED after a fresh pg_dump and isolated restore;
- READINESS {"status":"ready","database":"connected"};
- nine protected endpoints return 401 without a session;
- CORS_ETAG_VERIFIED 204;
- VPN_GAMES_402_API_DEPLOYED.

Running image tag: samosval-test-api:release-402-vpn-20261030.
Backup: /volume2/docker/samosval-test/migration-backups/vpn-games-402-20261030.
The prior transport backup remains separate and preserved.

Installed source hashes:
- index.mjs: 132b2e914835a5f9a3193af766e36b0628439ce37800a3cda5e8fe17468602fc
- json-response.mjs: ca516df3ca33d965f4c138f038cfdbc562ebc9fdddc78707a054eacdb40b70ff
- game-store.mjs: 026947b996099898c1a4ffbeb4b75064b1fde3707d03e989d3add9df26fb126e
- game-transfer.mjs: c276e952007ffae08a1c027e7125f56c3b68a1818262b88b326ce1655279e211

Public HTTPS readiness also returned ready/connected; unauthenticated games returned 401 and no-store. Production shell/worker/manifest have no changes relative to the pre-release root.

## Acceptance limits
The normal update-recovery page passed its pending-journal guard and loaded the 25139ff6198e59a9 client. No browser data, IndexedDB, auth, or local queues were cleared. Fresh app startup displayed the current shift. Subsequent cloud-browser DOM/screenshot calls stalled, so full live wallet/mini-game readiness and physical phone/VPN acceptance are still unverified. No claim is made that the user's VPN route was reproduced.

The user must retest the same VPN on version 4.0.2. Firebase reserve/failover remains separate in draft #62 and is not enabled by this release.
