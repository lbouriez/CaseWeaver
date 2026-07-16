# Worker application

**PBIs:** 001, 002, 004, 008, 009, 010, 011, 012, 013, 016

Executes durable commands through application use cases. The dispatcher routes only
feature handlers that outer deployment composition has explicitly registered; it must
never acknowledge a missing feature with a no-op.

The worker owns retries and heartbeats but delegates policy to reusable packages.

Hosts the application-layer outbox relay in distributed mode. Multiple replicas safely
claim envelopes without duplicate effects.

Knowledge commands use v2 envelopes containing distinct immutable source and connector
configuration version pins. Historical v1 envelopes deserialize for audit/history only
and fail closed with a stable non-retryable runtime error before any connector I/O.
The production host must obtain private connector settings solely through the
administration runtime resolver using the supplied connector pin; it may not reinterpret
the source pin or resolve a mutable connector-current version.

PBI-012's unregistered analysis-trigger capture bridge resolves a `CaseSource` only
through the same runtime resolver using the durable request's exact connector
registration and configuration-version pins. It loads only the persisted opaque target
and rejects a response whose normalized reference differs from that target before it
reaches the injected snapshot projector. A v1 analysis trigger is rejected by the
application capture use case before this bridge can resolve a connector; integration
ownership of the dispatcher and production composition remains outside this feature
module.

`NormalizedCaseSnapshotProjector` is the generic connector-neutral bridge from a
validated `NormalizedCase` to capture content. It assigns deterministic snapshot/message
hashes and passes only opaque attachment external references to PostgreSQL; PostgreSQL
binds those references to already verified derivatives atomically when the snapshot is
new. It rejects a cross-connector attachment rather than mixing workspaces.

The feature-owned publication module also provides an exact-pin
`RuntimePublicationDestinationResolver` and a structural publication-executor bridge:
both execution and reconciliation envelopes reach the supplied real executor unchanged.
Missing connector capability is surfaced as unavailable; no worker module falls back to
a mutable configuration or a vendor-specific implementation.

`caseweaver-worker health` performs only a bounded `SELECT 1` PostgreSQL
connectivity check (no queue work, migrations, or command execution) and fails
closed with a redacted status when `DATABASE_URL` is absent or unavailable.

`caseweaver-worker start` is the production host. It composes the PostgreSQL
outbox, pg-boss queue, descriptor-registered Git/Markdown and Jitbit runtimes,
immutable knowledge/trigger/publication/retention/diagnostics use cases,
object-storage evidence, and the exclusive metered AI gateway. Run
`caseweaver-worker migrate-queue` from the controlled installation job after
Prisma migrations and before starting a worker; runtime queue startup never
creates DDL objects. A configured analysis repository stage first resolves the
exact workspace-scoped immutable `repository-runtimes` version, active opaque
checkout-credential metadata, and matching repository-agent binding before it
can call the exclusive metered AI gateway. It never substitutes a current
runtime version. Its provider contribution must still be composed with an
attested checkout broker and OCI sandbox; if that provider is not installed,
the registered AI dispatcher fails the enabled stage closed without a raw model
or filesystem fallback. Profiles with the stage disabled remain fully executable.

The optional repository-agent stage is registered only when both
`WORKER_REPOSITORY_AGENT_SOURCES_JSON` (a server-managed JSON array of exact
repository IDs and absolute local Git worktree roots) and
`WORKER_REPOSITORY_AGENT_SANDBOX_IMAGE` (an immutable `@sha256` OCI image) are
configured. `WORKER_REPOSITORY_AGENT_DOCKER_SOCKET_PATH` optionally selects a
local Unix Docker socket. This Linux-only boundary is deliberately explicit:
the normal local stack has no repository-agent source mapping or Docker socket,
so an enabled repository stage fails closed until an operator deploys the
attested worker configuration. Source paths, sockets, model keys, and checkout
references are server-private and never form API, queue, or browser values.

Known commands without a complete production dependency (for example an absent
object-storage adapter or source factory) must fail with a feature-specific, redacted
runtime-unavailable error so the durable queue/dead-letter path remains observable.

The analysis handler is only a transport adapter over a prebuilt
`AnalysisExecutionService`. It never manufactures unavailable or deterministic stage
ports. Production composition must construct real frozen attachment evidence, immutable
retrieval runtime, model-compatible prompt-token counting, pinned repository sandbox,
and the exclusive `ai-execution` gateway before registering the handler; tests may use
deterministic fixtures only outside that composition path.

PBI-013 registers both durable retention reaping and purge envelopes when their real
application use cases and configured object-storage bridge are injected. Reaping is
the only expiry producer; it first queues reference-only work and later backend-pinned
object work. Purge claims a fenced work item, deletes only its exact immutable
workspace/backend/key reference, then atomically marks metadata complete and appends
its audit event. Historical key-only work fails closed before storage I/O.

PBI-016 adds an injected `diagnostics.export.generate.v1` handler. It receives only an
opaque export ID and workspace ID, claims a bounded export, serializes already-redacted
audit-safe events, and writes server-private artifact bytes. Periodic maintenance
expires and deletes artifacts through the same bounded lifecycle; neither command nor
handler receives storage URLs, secret values, or browser input.
