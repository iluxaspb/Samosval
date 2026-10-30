# Independent Firebase reserve / TEST auto-router candidate

**Status: development only — not a full TEST release and not deployed.**
This branch does not change the published TEST shell, Synology containers,
production, phone caches or any live Firebase rules.

## Separate reserve service

- Cloud Run container in **Google Cloud project \`samosval-offline\`**,
  independent of Synology/PostgreSQL.
- Build: \`docker build -f server/Dockerfile.reserve -t samosval-test-reserve server\`.
  GitHub CI verifies this Dockerfile in addition to the NAS image.
- Entry: \`server/src/test-reserve-service.mjs\`; runs with Application Default
  Credentials and a dedicated Firestore-authorized identity. Never commit
  service-account JSON; use Cloud Run workload identity/service account.
- Mandatory environment: \`FIREBASE_PROJECT_ID=samosval-offline\`;
  \`TEST_RESERVE_SERVE_ENABLED=0\` until isolated promotion and reverse-replay
  have been accepted. This default denies all business endpoints.
- Only these business endpoints are implemented: \`GET /api/v1/session\`,
  \`GET /api/v1/line/snapshot\`, \`POST /api/v1/line/operations\`.
  \`GET /api/v1/owner/status\` reports independent coordinator ownership and
  is **not** a promotion command. \`GET /health/live\` is liveness only.
- The browser supplies Firebase Auth ID tokens; the service verifies tokens
  server-side before reading or writing its private replica namespace.
  CORS restricts browser origin but **is not** an authentication mechanism.
  Never open direct Firestore client rules to \`samosval_test_replica\`.

## TEST-only browser routing (feature branch only)

The new \`test-app/synology/auto-line-client.mjs\` routes line reads and
operations according to an **authenticated** \`/api/v1/owner/status\`
response from the independent reserve service. It does not promote on a
NAS timeout, failed health check, user click, or cached owner state.

- If the coordinator confirms \`synology\`, use the existing NAS adapter.
  Any NAS write must *also* be covered by the server-side Firestore permit
  and PostgreSQL fencing experiment; the browser is not a writer authority.
- If it confirms \`firebase\`, a matching head/generation and
  \`readyForFailover=true\`, use the independent Firebase line adapter.
  The write includes the exact writer epoch; the server rechecks that epoch
  transactionally and returns an idempotent operation receipt.
- If the authority is absent, stale, contradictory, handoff, or reconciling,
  **do not write anywhere**. Keep the same operation ID in the phone's
  durable line queue and retry after authority becomes readable.
- Session and line snapshots must have matching ownership on both sides of
  the read; if ownership changes, discard the mixed snapshot.
- All non-line operations (tabель, archive, games, settings, administration,
  undo/redo etc.) fail closed when Firebase is the writer. They **do not**
  silently write to the old NAS. Full business support is still a blocker.

The ordinary TEST build is unaffected: auto mode in its settings still uses
the existing Firebase adapter, as before this branch. An isolated NAS
candidate can opt in **only via explicit HTML meta tags**:

\`\`\`html
<meta name="test-data-provider" content="synology-auto-candidate">
<meta name="test-reserve-api-url" content="https://REPLACE-WITH-REAL-TEST-CLOUD-RUN-URL/">
\`\`\`

**Do not add these tags to the published TEST shell or enable the mode until**
the real Cloud Run endpoint, current NAS writer fence, Firestore rules,
initial snapshot, and two-way recovery are verified. The connection string
must be the actual TEST Cloud Run HTTPS origin without a path or query. No
service URL is presently configured in the repository.

## Required acceptance before a phone TEST release

1. Validate a restored **disposable TEST database backup**, SQL 014 outbox,
   exact snapshot fingerprint and zero unreplicated PostgreSQL commits.
2. Deploy the independent Cloud Run service to \`samosval-offline\` with
   restricted service identity and Firebase ID-token validation, verify
   both authenticated and unauthorized HTTP responses.
3. Install the separately verified NAS API candidate with
   \`TEST_REPLICA_ENABLED=1\` and server-side
   \`TEST_WRITER_FENCE_ENABLED=1\` **only on isolated TEST data**.
   Confirm no active permit or uncommitted SQL operation at handoff.
4. Activate the isolated auto candidate and test on **two distinct Firebase
   Auth accounts and two actual devices**: arrival, load race, TTN, reset,
   offline action queue, lost network reply, route change and idempotency.
5. Verify source transfer **NAS → Firebase → NAS**, including back-sync
   hashes, receipts, audit history, and prevention of a second writer during
   network partition. Never promote from a mere timeout or zero lag.
6. Implement and test all other modules required for a complete app:
   open/close shift, archive, tabель, journal undo/redo, games, settings,
   membership, permissions and admin actions. Prove no previously queued
   operation is discarded by an update or rollback.
7. Run current server and browser CI against one immutable release commit,
   then publish the TEST manifest and PWA update through the existing
   administrator release channel. Keep \`index.html\` and production intact.

CI uses synthetic Firestore for determinism and PostgreSQL 16 for its
integration suite. Passing CI proves the source and simulation,
**not** a live Google Cloud deployment, real Firebase Auth, or a tested
phone failover. No production deployment is authorized by this document.
