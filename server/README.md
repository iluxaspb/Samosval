# Samosval — Synology server bootstrap (TEST ONLY)

This is the first isolated backend foundation for Synology DS923+.
**It does not yet implement trips, permissions, authentication, offline sync, or Firebase failover.**
No production application files or Firebase rules were changed.

## Existing frontend integration points found in repository

- `app/src/core/05-authentication.js` — Firebase Authentication and registration.
- `app/src/core/02-permissions.js` — current client-side permissions.
- `app/src/core/04-subscriptions.js` — Firestore realtime subscriptions.
- `app/src/core/16-offline-replay.js` — offline event queue / replay.
- `app/src/core/17-trip-actions.js` — trip actions.
- `app/tabel-v2/` — timesheet and spreadsheet modules.

## Local TEST deployment (not production)

1. Install **Container Manager** in DSM and prepare an isolated TEST project.
2. Copy `.env.example` to local `.env.test`. Replace the sample password with a strong random secret. **Never commit this file.**
3. In the `server/` directory run `docker compose -f compose.test.yaml up -d --build`, or import this Compose project into Container Manager with the source files available.
4. On the NAS itself, check `http://127.0.0.1:18080/health/live` and `http://127.0.0.1:18080/health/ready`.
5. PostgreSQL does not publish any host port. API access is bound to NAS loopback ONLY. No public routing is configured.

`/health/live` checks that the API process runs; `/health/ready` also checks a PostgreSQL connection. Neither contains private data.

**Do not expose these endpoints directly to the Internet.** Public HTTPS, Firebase ID-token verification, authorization, rate limiting, backups, schemas, data migration, and safe failover have not been implemented.

## Next development steps

1. Inventory Firestore collections, transaction boundaries, current access rules, and test/production IDs.
2. Define database migrations and server-side permission checks (deny by default).
3. Add Firebase ID-token validation and server-side role lookup before adding protected data endpoints.
4. Implement idempotent trip commands and server-authoritative conflict checks with integration tests.
5. Integrate with existing offline queue and real-time updates.
6. Design a provably safe Firebase standby/replication protocol before enabling automatic failover.
7. Add deployment and rollback pipeline with independent test and production releases.

Current container images/tags and dependency versions must be reviewed and pinned before any production deployment.
