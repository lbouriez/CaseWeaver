# PBI-013: Production operations

## Outcome

Make CaseWeaver operable as an autonomous, recoverable service.

## Delivery status

**Completed.** The initial completion claim was reopened because the required runtime
processes and immutable production composition were missing. Those gaps are now
implemented and validated. The API, standalone, webhook, scheduler, and worker are
real signal-safe processes; standalone and distributed modes use the same PostgreSQL
queue, outbox, leases, immutable configuration pins, and feature-owned handler
registrations.

### Acceptance evidence

- `apps/api`, `apps/standalone`, `apps/webhook`, `apps/scheduler`, and `apps/worker`
  expose real lifecycle entrypoints with bounded database readiness, liveness/readiness,
  ordered shutdown, and non-zero startup failure behavior.
- The production composition registers knowledge, analysis, publication, trigger,
  retention, privacy, and diagnostic work. Unsupported envelopes remain visible through
  the durable queue/dead-letter path; no host no-op acknowledges them.
- Source, schedule, webhook, publication, trigger, analysis, attachment, and retention
  records retain the exact immutable configuration/version references needed by their
  adapter. Historical records without required pins remain readable and fail closed.
- Production Git/Markdown and Jitbit runtime contributions, object-storage/attachment
  processing, immutable analysis evidence/runtime resolution, and publication/trigger
  execution are composed from their feature-owned ports rather than test fakes.
- The full PostgreSQL integration suite applies all 44 migrations and passes 117 tests.
  It covers durable queue/outbox behavior, immutable configuration pins, retention, and
  integration boundaries.
- A built standalone image was started against the same retained PostgreSQL volume as a
  distributed local stack, passed liveness/readiness, shut down with exit code 0, and
  the distributed API was recreated afterwards without losing service readiness.
- `pnpm run ci` passes the repository format, lint, dependency, type, build, unit, and
  contract gates. The Docker Compose browser acceptance also passes against the built
  API and static Admin artifacts.

PBI-017 remains responsible for release-profile TLS, backup/restore, image scanning,
and attestation verification; those delivery controls are not PBI-013 runtime gaps.

## Scope

- Queue, synchronization, cache, cost, budget, and publication metrics.
- OpenTelemetry traces across API, worker, database, connectors, providers, and sandbox.
- Dead-letter inspection, authorized retry, cancellation, and lease-recovery commands.
- Retention jobs and privacy deletion with audit events and tombstones.
- Redacted diagnostic export.
- Docker Compose production example and installation documentation.
- Distributed and standalone profiles using the identical durable queue and handlers.
- Documented disposable PostgreSQL/pgvector integration-test environment.

## Acceptance criteria

- Operators can identify why a job failed without exposing secrets.
- Lease recovery and dead-letter retry work end to end.
- Cost and reservations can be queried by analysis, model role, connector, and time.
- Privacy deletion removes governed content and leaves the documented audit tombstone.
- Operational commands enforce workspace permissions and record their actor.
- Switching between standalone and distributed deployment preserves queued work and
  execution semantics.

## Excluded

MCP and user interfaces.
