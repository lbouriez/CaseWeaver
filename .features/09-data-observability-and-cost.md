# Data, observability, and cost

## Principal records

- Workspace and connector configuration.
- Principal, credential registration, role/permission assignment, and immutable audit
  event.
- Secret reference and connector capability registration.
- Source item, immutable revision, and synchronization cursor.
- Chunk, embedding, and active-revision mapping.
- Case snapshot, message, attachment, and derivative.
- Repository binding and analyzed commit.
- Analysis profile and immutable version.
- Analysis job, attempt, lease, result, and evidence.
- Publication attempt and remote receipt.
- AI provider, model catalog snapshot, price override, operation, usage, and cost.

All records that belong to a workspace carry its ID. The MVP may expose one workspace,
but the schema must not require a destructive redesign for multiple workspaces.

## AI operation ledger

Every call records:

- purpose and role,
- provider and configured model,
- effective model returned by the provider,
- related workspace, job, analysis, source, or attachment,
- request and response times,
- success or typed error,
- retry count and provider request ID,
- normalized usage,
- catalog snapshot and override IDs,
- estimated and provider-reported costs,
- and cost calculation status.

Embedding batches retain per-item attribution or a documented allocation method.

## Budget enforcement

Budgets may be configured per operation, analysis, day, and workspace. The system
transactionally reserves an estimated upper bound at every applicable scope before a
call, then reconciles or releases the reservation afterward. Concurrent jobs cannot each
spend the same remaining allowance. Exceeding a hard budget prevents the call with a
typed error; soft budgets emit events and metrics.

Unknown pricing cannot satisfy a hard monetary budget unless explicitly allowed.
Timeout, cancellation, retry, absent usage, and a provider-reported cost above the
reservation produce explicit reconciliation states and operator-visible events.

## Actor audit

Configuration changes, approvals, publications, retries, cancellations, secret-reference
changes, retention actions, and privacy deletion record the authenticated actor,
workspace, action, target, before/after hashes, time, and request correlation.

## Observability

Logs are structured and correlate:

- request ID,
- job and attempt,
- connector synchronization,
- case and analysis,
- AI operation,
- and publication.

Metrics cover queue depth, job duration, connector errors, chunks and embeddings,
retrieval latency, cache hit rate, token usage, cost, publication outcome, and lease
recovery.

OpenTelemetry spans cross API, queue, connector, AI, database, and sandbox boundaries.
Raw prompts, responses, attachment content, and secrets are excluded from telemetry by
default.

## Retention

Retention is configurable by data category. Deleting raw content must preserve enough
metadata to explain cost, state transitions, and publication history. Source deletion
and privacy requests must remove active retrieval material and stored binaries according
to policy.
