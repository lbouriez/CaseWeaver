---
sidebar_position: 12
title: Persistence, backup, and recovery
---

# Persistence, backup, upgrade, and recovery

PostgreSQL/pgvector is CaseWeaver's system of record: configuration history, audit
events, durable queue/outbox records, leases, source/analysis state, retrieval data, and
cost attribution live there. Object storage holds bounded attachment bytes and
derivatives. The production named database volume survives normal stop/start and mode
changes; the disposable local/test volumes do not have that retention promise.

## Backup and restore

Before an upgrade or topology transition, make a backup. The production helper stops the
selected runtime, copies the configured object prefix to the separate backup bucket,
writes a PostgreSQL custom-format dump, and emits a non-secret manifest. It leaves the
runtime stopped for inspection.

```powershell
node deploy\docker\production-operations.mjs backup --env-file <operator-env-file> --mode standalone --output <backup-dump-path>
node deploy\docker\production-operations.mjs restore --env-file <operator-env-file> --mode standalone --input <backup-dump-path>
```

Restore requires a compatible configuration and clean/deliberately emptied target object
prefix. The helper verifies bucket/prefix relationships, does not delete target objects,
restores PostgreSQL, reapplies the controlled migration/grant sequence, and requires a
separate `start` after success. Preserve the dump, manifest, and redacted diagnostics if
it fails; do not run ad-hoc destructive SQL.

## Upgrade and rollback

Verify the new digest and attestations, back up, stop/drain the old runtime, run
`migrate`, and start the chosen mode. Migrations are forward-only. An image rollback is
safe only when the existing schema is known compatible; otherwise restore the tested
backup. There is intentionally no automatic destructive downgrade.

Measure a restore drill for your own RPO/RTO. Protect and version the backup bucket with
an identity separate from the runtime identity. Never use `docker compose down -v` on
production data.
