# Isolated TEST reserve API candidate

Runs as a separate Cloud Run container inside Google Cloud project `samosval-offline`; it does not require Synology to be online.
Deployment is NOT automatic: Firebase/Google Cloud credentials, billing and service identity must be configured outside GitHub.

Build source with `docker build -f server/Dockerfile.reserve server`. The independent service entry point is `server/src/test-reserve-service.mjs`.
Set `FIREBASE_PROJECT_ID=samosval-offline` and `TEST_RESERVE_SERVE_ENABLED=0` until the promotion protocol and back-sync are verified.
Once eligible in isolated integration tests, it accepts Firebase Auth ID tokens, then serves `GET /api/v1/session`, `GET /api/v1/line/snapshot`, `POST /api/v1/line/operations`, `GET /api/v1/reserve/status`.
Never configure a production endpoint or expose private `samosval_test_replica` documents through direct client Firestore rules.

Currently only line commands are implemented, and the published mirror is explicitly not ready for promotion. This is not a finished or deployed failover release.
