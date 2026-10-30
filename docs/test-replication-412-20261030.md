# TEST 4.1.2 — server-owned passive PostgreSQL → Firebase mirror

**Not a failover release.** There is one business writer, Synology. The mirror never
authorizes a browser to submit Firebase writes. Client mode \`auto\` is intentionally
not activated, and return-to-NAS/reconciliation is not implemented.

## Source of truth and installation boundary

- API and persisted TEST business data: Synology DS923+, PostgreSQL \`samosval_test\`.
- API endpoint for the installed TEST client: \`https://iluxa.synology.me:18443\`.
  DSM port \`5001\` is **not** an API endpoint.
- Firebase Authentication stays with \`samosval-offline\`; the mirror also targets
  **only** that exact project, enforced in code. Production and \`index.html\` untouched.
- Outbox source is existing SQL 014, preserving its strictly committed cursor,
  39-table audited inventory and \`reserve_replica_receipt\` record.
- Remote server-owned records are under the private, otherwise unused
  \`samosval_test_replica/v1\` Firestore document and generation subcollections.
  They are **not** the legacy \`workspaces/main_workspace\` app schema. The
  historical Firebase queue is not imported, replayed, cleared or changed.

## Implementation

1. Opt-in TEST API process independently connects to PostgreSQL, acquires a
   PostgreSQL advisory lock and reads SQL 014. No phone, PWA or browser required.
2. When both remote checkpoint and local receipt are absent, require a live
   control-worker heartbeat and a backup marked **restored** made within 6 hours.
   Only then read 39 tables and outbox highwater in one REPEATABLE READ snapshot.
3. Upload row documents into a new private generation. Check remote row count,
   key identities, and SHA-256 of canonicalized payloads **by reading back**
   the generation. Only after this succeeds publish its singleton checkpoint.
4. Then advance ordered outbox batches in Firestore transactions. Each batch
   contains row upserts/deletes, a per-sequence immutable event document and an
   updated hash-chain checkpoint. Local \`reserve_replica_receipt\` advances
   **only after** the Firebase transaction reports success. Multiple updates to
   the same row in one batch are folded in materialized state but retain all
   audit events. Primary-key changes produce both remove and add.
5. When Firestore committed but its response was lost, compare remote checkpoint
   to local outbox and verify the exact history before accepting its receipt.
   A remote mismatch, missing sequence, deleted checkpoint or wrong project
   fails closed. Restarts resume from the persisted cursor.
6. Admin \`GET /api/v1/admin/server\` returns passive mirror health:
   head, confirmed sequence, lag, last receipt, last success, last safe error,
   owner=Synology, backup readiness=false. The TEST admin center shows it in
   the new «Репликация» section. No untrusted user inputs control the worker.

## Opt-in prerequisites (NOT performed by this code release)

1. In TEST admin center create a **new** database backup; confirm the control
   worker marks it restored and its heartbeat is fresh. Keep prior backups.
   The API will reject initial mirroring if the verification is stale.
2. Firebase console: confirm **samosval-offline**, correct TEST user directory
   and that current Firestore rules do **not** grant clients access to the
   \`samosval_test_replica\` namespace. Unknown matches should be default-denied.
   Do not touch production rules. Provision a dedicated service account with
   \`roles/datastore.user\` **only on that TEST project**, not Owner/Editor.
   This role is project-wide; use a dedicated test project and service account.
3. Place its credential outside the GitHub repo on NAS, readable only by the
   container administrator. Do **not** paste or upload keys to ChatGPT. Ensure
   candidate Compose has a read-only volume mapping such as:
   \`/volume2/docker/samosval-test-private/firebase-replica.json:/run/secrets/firebase-replica.json:ro\`.
   Do not grant this mount to the production container.
4. Configure candidate API environment on NAS:
   \`FIREBASE_PROJECT_ID=samosval-offline\`,
   \`GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/firebase-replica.json\`,
   \`TEST_REPLICA_ENABLED=1\`.
   A Docker **recreate** (via an authorized TEST server update) is needed for
   new env/mount settings; simply restarting an old container doesn't reread
   Compose configuration. Do not change \`TEST_REPLICA_ENABLED\` until the
   credential mount and verified backup are ready.
5. Install only a CI-verified, checksummed TEST server release through the
   current admin server updater. It takes its own validated backup.
   Check «Репликация» for increasing delivered sequence and zero lag.
   Stop/restart simulation must be on a disposable TEST database, never
   by disturbing a current shift. \`TEST_REPLICA_ENABLED=0\` stops background
   sends after recreating the candidate container; it does not delete data.
6. Treat the mirrored data as **unusable for failover** until there is a separate
   tested Firebase business transaction adapter, a shared fencing/lease
   authority, secure two-way reconciliation, and acceptance by two distinct users.

## Failure behaviour

- Firebase down: no confirmed receipt advances; NAS remains the sole writer.
  Worker retries with capped backoff. Lag grows; no automatic switch.
- NAS down: phones retain their offline queues. Remote copy is **read-only**;
  last NAS commits not yet transmitted cannot be assumed present. Do not
  activate legacy Firebase business writes or declare zero data loss.
- Network partition / unstable links: refuse to create a second writer.
  No split-brain by automatic promotion; require verified ownership
  coordination before implementing promotion.
- Partial initial upload: unpublished generation remains inaccessible through
  the singleton metadata. A retry re-snapshots to a fresh generation; old
  unpublished generations require controlled later garbage collection.
- Wrong credentials/denied access: runner reports a bounded error; no secrets
  or upstream response bodies are logged.
- Rollback to API 4.1.1: leaves PostgreSQL 014, its journal, receipts, and
  Firebase mirror data intact, disabling this background runner. Restore
  the original API image through the admin center. Never restore an older
  backup over current business data as part of API rollback.

## Verification matrix

Automated on isolated PostgreSQL + in-memory Firestore transaction simulator:
first snapshot with readback count/fingerprint, forward delivery, delete, several
updates in one batch, unavailable remote, lost commit reply, no duplicate
ledger entry after retry, receipt deletion/recovery, remote tamper rejection,
rollback cursor preservation, project isolation. Separate SQL 014 tests check
39 capture triggers, commit/rollback and concurrency. Browser regression
checks inner center navigation against the fixed app bottom nav.

**Not covered by those tests:** real Firestore service-account round-trip,
Firestore security rules deployment, an actual NAS install of 4.1.2, two
real user accounts/phones, browser cold PWA offline launch, failover/back-sync
and split-brain under real partition. These remain blockers to final failover.

## Work-in-progress ownership gate (PR #71, not a deployable failover)

In the test development branch, `server/src/test-writer-coordinator.mjs`
adds Firestore ownership epochs and per-request write permits. The opt-in
`server/src/test-writer-guard.mjs` checks the server-side owner before each
TEST API business POST; the admin center reports the last known epoch and
lease. `server/src/test-replica.mjs` now reads the same authority inside the
outbox transaction, preventing NAS from overwriting an active Firebase owner.
No direct browser write access to private replica documents is permitted.

- **Default:** `TEST_WRITER_FENCE_ENABLED=0`. No phone or production change.
- To even experiment with this gate, the NAS must have a verified initial
  mirror, confirmed local Firestore receipt and server-only credentials.
- Lease: 60 seconds; per-request permit: 15 seconds; takeover grace: 30 seconds.
  Tests simulate parallel NAS nodes, lost coordinator connection, expired
  leases, stale permits and fencing the forward mirror.
- **This is not yet a complete distributed transaction fence.** Expiring a
  permit does not, by itself, cancel a PostgreSQL transaction that might still
  be running. No automatic promotion should be allowed until that race and
  durability/ordering on both sides are addressed.
- **Availability tradeoff:** With this experimental flag enabled, loss of
  Firestore access prevents new NAS writes, even if PostgreSQL is healthy.
  This is deliberate fail-closed behavior, but is NOT acceptable as a final
  production failover policy without explicit operational review.
- Neither the Firebase business operation adapter, reverse receipts, client
  automatic source switching, nor a real two-account phone exercise is
  implemented by this gate. The present passive mirror keeps
  `readyForFailover=false`; `promoteTestReserve` is test-only and cannot
  promote that mirror.
- Do not enable `TEST_WRITER_FENCE_ENABLED=1` on the live TEST shift just to
  "try the switch": that would make valid NAS actions fail closed without a
  working Firebase business endpoint. Test first with isolated data.

No API installation or Firebase credential deployment is performed by
merging development code to the feature branch. Existing 4.1.1 on NAS remains
untouched until the user installs a verified TEST release through Admin.
