---
sidebar_position: 11
title: Operations overview
---

# Operations overview

Use [Self-hosting](./self-hosting.md) for installation, [Persistence and recovery](./persistence-recovery.md)
for data safety, and [Troubleshooting](./troubleshooting.md) for a bounded first check.

An operator can inspect jobs, dead letters, costs, retention, privacy, diagnostics, and
the append-only audit log only when their workspace permissions allow it. Sensitive
reads and downloads fail closed when their required audit record cannot be persisted.

The supported production path uses a private database, one public TLS edge, static
Admin assets, separate migration/runtime database roles, explicit forward migration,
and exactly one runtime mode. Do not treat `compose.test.yml`, `compose.admin.yml`, or a
locally built image as a production installation.
