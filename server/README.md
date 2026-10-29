# Synology backend migration — isolated TEST branch

This branch introduces an initial PostgreSQL-backed API for line operations. **The TEST API foundation is deployed on Synology; it MUST NOT serve the production client.** Production HTML/JavaScript, Firebase databases, and Firestore rules are unchanged.

## Code already ported (first phase)

- `src/line-rules.mjs`: server-side validations for `arrive`, `load`, `ttn`, and admin `reset`, based on the existing Firestore transaction in `app/src/core/16-offline-replay.js`.
- `src/line-store.mjs`: PostgreSQL transactions, row locks on truck status, deterministic load IDs, and durable operation receipts. Two concurrent load requests for the same arrival cannot both be accepted.
- `src/auth.mjs`: Firebase Auth ID-token signature verification; every line command must also find an active user in the local `app_users` table, with permission in `role_permissions` (default deny).
- `src/index.mjs`: guarded `POST /api/v1/line/operations`; `GET /health/live` and `GET /health/ready`. Explicit CORS origin allowlist.
- `src/line-read.mjs`: guarded `GET /api/v1/line/snapshot`, one repeatable-read read-only transaction for the current shift, trucks, statuses and logs; active account and line permission required.
- `sql/001_init.sql`: **new** isolated test tables, no import or deletion from Firebase.
- `tests/`: pure business-rule tests and concurrent PostgreSQL request test; GitHub Actions runs tests with an isolated PostgreSQL service.

## Deployment prerequisites (DSM / Container Manager)

1. Inspect DSM version, available memory, free storage and Container Manager before installation.
2. Use a **separate TEST project** and database volume. Do not attach existing personal NAS directories to untrusted containers.
3. Copy `.env.example` to private `.env.test`; set a strong password and confirm the test Firebase Auth project. Never push passwords, private keys, or administrator credentials to GitHub.
4. For a new TEST volume, `docker compose -f compose.test.yaml up -d --build` runs `sql/001_init.sql` once at PostgreSQL first initialization. For an existing volume, migrations must be applied separately and explicitly.
5. Verify locally on the NAS: `http://127.0.0.1:18080/health/live` and `http://127.0.0.1:18080/health/ready`. Test API is bound to **NAS loopback only** and PostgreSQL has **no published host port**.
6. Do **not** forward API, database, SSH, or DSM ports to the public internet for this prototype. HTTPS/reverse-proxy deployment, backups, rate limits, and full migration remain unfinished.

### API request shape (for future client adapter)

`POST /api/v1/line/operations`
with headers `Authorization: Bearer <Firebase ID token>`, `Content-Type: application/json`.
Body is the existing offline-queue record fields: `id`, `type` (`arrive`, `load`, `ttn`, `reset`), `shiftId`, `truckId`, `createdAt`, `expectedRevision`, `expectedTtnRevision`, `arrivalTimestamp`, `lastLoadTimestamp`, `wantArrived`, `collect`, `cycleMinutes`, optionally `logId`.
`actor`, `email`, truck name/volume, and `beforeStatus` supplied by the client are *not* trusted. The server obtains them from authenticated identity and database state.

Responses include `outcome: confirmed | rejected`, `reason`, server `status`, and optional `log`; a successful repeat of the same operation ID returns its prior result with `replayed: true`.

### Data readiness / test fixture requirements

The API intentionally does not create user accounts, shift state, or trucks on behalf of untrusted requests. Before testing with real devices, a dedicated test-only migration must populate active user profiles, role permissions, current shift, trucks and truck statuses **after** inspecting Firestore exports. No production data has been copied.

### Not yet migrated — do not enable failover

Realtime subscriptions/WebSocket, starts/closes of shifts, truck registration, cancel/undo/history, permissions editing from phone, timesheets, Excel formulas, analytics, gaming, backup/restore, and safe bidirectional replication to Firebase are **not implemented on the new API**. Existing GitHub Pages applications continue to use Firebase unchanged. A hot standby needs strict rules for who may write after an outage to avoid divergent data or lost trips.

### Current test commands

`npm install`, `npm run check`, `npm test`.
The PostgreSQL concurrency test executes when `TEST_DATABASE_URL` points at a disposable test database containing `sql/001_init.sql`; GitHub Actions configures this automatically.

## Source mapping

- `app/src/core/05-authentication.js`: Firebase Authentication + registration.
- `app/src/core/02-permissions.js`: client-side permissions (not a trusted server authority).
- `app/src/core/04-subscriptions.js`: Firestore live subscriptions.
- `app/src/core/16-offline-replay.js`: queued line operations and transaction rules.
- `app/src/core/17-trip-actions.js`: UI line-action dispatch.
- `app/src/core/15-shifts.js`: shift creation/closure and truck lineup.
- `app/tabel-v2/`: timesheets and spreadsheet modules.

Next: inspect/port shift and truck onboarding, integrate secured read APIs and build real-time sync, migrate **test-only** data, then integrate the TEST frontend behind a feature flag. Production promotion requires separately tested backup, rollback, permissions parity, and failover.


On 2026-10-30, all seven line-read PostgreSQL scenarios passed directly on the NAS (8 tests including parent, no skips). Source backup: `src-before-api-snapshot-20261030-0118.zip`. Test API image: `samosval-test-api:read-v1-20261030`; old image is retained for rollback. The published frontend has not been switched to this API.

The verified TEST export was imported on the NAS on 2026-10-30: 4 users, 23 trucks, 11 statuses, 28 log records; 1,989 original exported documents are retained in migration_documents. SQL checks confirmed 20 ordinary trips and 530 cubic metres. An authenticated browser read over HTTPS and a live isolated-fixture operation probe passed. The normal TEST app remains on Firebase; raw document import does not implement the remaining module APIs. See docs/synology-v4-test-status.md for current scope.
