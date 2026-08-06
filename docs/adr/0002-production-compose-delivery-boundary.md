# ADR 0002: Use a digest-pinned TLS-edge Compose topology for production delivery

## Status

Accepted.

## Context

CaseWeaver's disposable local Compose stack deliberately co-locates the API, webhook,
scheduler, worker, and relay in one standalone process. It is useful for evaluation but
does not provide a production TLS boundary, least-privilege database roles, secret-file
bootstrap, backup/restore operations, or a release verification boundary.

PBI-017 requires a self-hosted installation that can use the existing PBI-013 standalone
or distributed runtime without changing its durable queue, outbox, leases, immutable
configuration pins, or PBI-016 cookie-session administration contract.

## Decision

- Production uses `deploy/docker/compose.production.yml` with digest-pinned runtime,
  Admin, PostgreSQL, and TLS-edge images. `linux/amd64` is the only supported platform.
- A non-root TLS edge is the only service with published ports. It provides same-origin
  Admin, API, health, and webhook routing, replaces incoming forwarded headers, and
  forwards them only from an explicit internal CIDR trusted by the API.
- Compose selects exactly one application profile, `standalone` or `distributed`.
  A separate, explicit migration sequence runs Prisma migration, pg-boss migration,
  and runtime-role grants before either runtime profile can start.
- PostgreSQL initializes a migration owner and a separate runtime role. Runtime services
  receive only the runtime connection secret and have DML privileges; migration services
  receive only the migration connection secret and own DDL/queue migration.
- Bootstrap secrets are read from named Docker secret files. Optional application secret
  values are loaded from an operator-owned read-only secret directory by the baked
  runtime entrypoint; values never enter Compose environment values, image layers,
  browser configuration, logs, diagnostics, or command arguments.
- The delivery workflow scans images and Docker configuration, creates GitHub provenance
  and SBOM attestations for immutable registry digests, verifies those attestations by
  digest, and creates a release record only after the scanned, verified image smoke.

## Consequences

- Operators must create restrictive secret files and choose a digest for every image.
  There is intentionally no production `latest` fallback or password default.
- Runtime rollback is an image-digest rollback only while the forward-only database
  migration remains compatible. Otherwise recovery is the tested backup restore path.
- The TLS edge is a transport boundary, not an identity or authorization implementation:
  API origin, CSRF, cookie, OIDC, and authorization behavior remain owned by PBI-016.
- The deployment helper is the supported way to validate a profile, migrate, start,
  back up, and restore. Direct `docker compose --profile` use remains possible for
  advanced operators but cannot bypass the documented profile and migration invariants.
