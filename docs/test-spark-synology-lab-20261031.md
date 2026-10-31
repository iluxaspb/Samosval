# TEST 4.1.2 — Synology-like isolated rehearsal (31.10.2026)

**Status:** first run on GitHub Actions is required before trying this on a NAS. This is a SYNTHETIC, ephemeral lab, not the installed DSM TEST server and not physical two-device acceptance.

## Strict boundary

- `server/compose.spark-lab.test.yaml` creates **only** `postgres` and `runner` in a dedicated Compose project `samosval-spark-lab`, on an `internal: true` network.
- There are **no published ports, bind mounts, external networks, Docker socket, Synology paths, Firebase service credentials, live Firebase Security Rules, or existing NAS credentials**.
- The PostgreSQL container stores test data in tmpfs; `down --volumes` destroys both disposable containers and their temporary state. The database is generated from SQL001–015, then clone/recovery tests exercise SQL016 separately.
- The script hard-requires the internal `postgres` hostname, the disposable database `samosval_test`, the lab-only DB user and `SPARK_LAB_ONLY=1`. This is a guardrail, not a security substitute for restricting access to Docker.
- The LAB must never be attached to `samosval-test_default`, the live NAS database, or Synology production volumes. Never reuse it as a production Compose stack.

## Non-destructive rehearsal on Synology *after* CI passes

Clone the PR branch into an isolated temporary directory; inspect the two files before use. The user or an authorized operator must run these steps intentionally; GitHub Actions does not access DSM.

```sh
git clone --branch feature/test-replication-20261030 --single-branch https://github.com/iluxaspb/Samosval.git samosval-spark-lab-code
cd samosval-spark-lab-code
git rev-parse HEAD
docker compose -p samosval-spark-lab -f server/compose.spark-lab.test.yaml config --format json > /tmp/spark-lab-compose.json
node server/scripts/verify-spark-lab-compose.mjs /tmp/spark-lab-compose.json
docker compose -p samosval-spark-lab -f server/compose.spark-lab.test.yaml up --build --abort-on-container-exit --exit-code-from runner
docker compose -p samosval-spark-lab -f server/compose.spark-lab.test.yaml down --volumes --remove-orphans
```

Run the last `down` command even if any test fails. The commands download Docker images and npm dependencies during the **build**; the executing containers use an internal-only network. On DSM without a `node` command, inspect the Compose file with `docker compose ... config` and use GitHub Actions for the separate Node verifier. Do not replace these commands with an Admin Update of the live NAS.

**Acceptance for the synthetic lab:** the output includes `SPARK_LAB_COMPOSE_ISOLATION_VERIFIED` and `SPARK_ISOLATED_LAB_SUCCESS_SYNTHETIC_ONLY_NO_NAS_OR_PHONES`. Every SQL recovery, epoch gate, TTN/race and database-clone test must pass, and the Compose project must be removed afterward.

## Physical acceptance — explicitly NOT performed by the synthetic lab

1. Obtain a new verified TEST NAS backup and restore it into an independently isolated test DB/volume without modifying or connecting to the installed `samosval-test` Postgres container. Validate real row counts and restore timestamps. **Never restore over an active database.**
2. Inventory every HTTP route and background worker that writes to PostgreSQL. Prove SQL016 protects each of the 39 tracked business tables, and that no writer can bypass Firestore-permit/SQL-fence rules. Only then certify a restored TEST writer.
3. In a separate TEST Firebase Spark project (`samosval-offline`) deploy reviewed **test-only** Rules. Confirm no production Firebase project is modified and no actual worksite data is used.
4. Prepare an installable **candidate** of the PWA with `synology-auto-candidate` enabled only for TEST. Verify two independent Firebase Auth users and two physical browsers/phones; normal `index-test.html` does not yet enable this candidate.
5. While Synology is healthy, both phones must show `S`, with one accepted load when two users act concurrently. Verify one journal entry and TTN linkage.
6. Block NAS access deliberately in the isolated TEST topology, not the real working NAS. Once the independently certified lease expires and pending requests are resolved, both phones must switch to `F`. Confirm neither client can open a second writer independently.
7. On Firebase make arrival/load/TTN from separate phones, repeat a request after lost acknowledgement and queue one during temporary mobile disconnection. Restore connectivity and verify exactly-once counts and preserved timestamps.
8. Restore NAS: freeze Firestore writer, replay the immutable operations, verify SQL015 checkpoint, typed generation, Firestore read-back, SQL016 epoch rebind, then certify the rebuilt mirror. Both phones return to `S`, without duplicate trips.
9. Repeat a second failover/recovery cycle and inspect audit/TTN/permissions. Other modules (табель, архив, смены, игры, админка) are **unsupported in Firebase owner mode** unless separately implemented and tested.
10. Only after physical acceptance and actual data backups should an authorized operator explicitly decide whether to publish and install TEST 4.1.2. **Do not merge PR 71 into root, enable failover, or change the working app merely because CI is green.**

## Stop conditions

Stop immediately if any device shows different writer epochs, a lease cannot be proved, the SQL gate is missing or unarmed, the Firestore generation/checkpoint is inconsistent, the offline queue changes an operation ID, a duplicate log appears, or a third-party module attempts to write directly to a stale NAS. Report failed precondition rather than force a writer handoff.
