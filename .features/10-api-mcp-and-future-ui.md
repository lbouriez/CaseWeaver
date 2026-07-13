# API, MCP, and future UI

## Initial API

The API provides versioned operations for:

- health and readiness,
- connector configuration and capability discovery,
- knowledge-source schedules, collections, and synchronization policy,
- synchronization requests and status,
- case analysis requests and status,
- approval and publication,
- analysis/evidence retrieval,
- model catalog import and overrides,
- model-role bindings,
- budgets,
- and usage/cost queries.

Mutation endpoints accept idempotency keys. Long-running work returns a job resource and
does not keep an HTTP request open.

## Authentication and authorization

API, CLI, and MCP requests resolve an authenticated principal and workspace. Roles and
permissions govern connector/model configuration, secret references, raw case content,
evidence, analysis requests, approvals, publication, retry, cancellation, pricing,
budget changes, retention, and deletion.

The initial local deployment may bootstrap one administrator, but authorization checks
remain in application services rather than being deferred to a future UI. Every
privileged action emits an immutable audit event.

## Triggers

- CLI and API manual analysis.
- Per-knowledge-source cron schedules, interval polling, and verified webhooks.
- Optional periodic full rescan per source.
- Case-analysis cron schedules, connector polling, and verified webhooks.

All triggers translate into the same domain command and idempotency path. A webhook must
not bypass queueing, budgets, attachment limits, or publication policy.

Knowledge synchronization and case analysis are separate command types and schedules.
Running one source never implicitly synchronizes every configured source.

Public webhook URLs contain a server-generated opaque endpoint ID. Server-side
configuration maps that ID to workspace, connector instance, adapter, and secret
reference before any body/header value is trusted. Signature verification uses exact raw
request bytes.

After verification, webhook idempotency/inbox and command outbox records commit in one
transaction. Queue delivery is performed by a deduplicating outbox relay, so a crash
cannot leave a persisted event without its command or enqueue an unpersisted event.

## CLI

The CLI supports local administration and automation:

- initialize and migrate,
- validate configuration,
- test connectors and model bindings,
- synchronize a source,
- analyze a case,
- inspect a job,
- import LiteLLM pricing,
- and export diagnostics with sensitive content removed.

## MCP server

The later MCP application exposes narrowly scoped tools:

- `search_knowledge`
- `get_evidence`
- `get_analysis`
- `analyze_case`
- `get_case_analysis_status`

Write-capable tools require explicit enablement and authentication. MCP search enforces
workspace and source access metadata. Tool responses include citations, not only
generated prose.

## Future UI

The first UI should be operational rather than chat-first:

- connector and model configuration,
- synchronization status,
- job queue and failures,
- analysis review and approval,
- evidence inspection,
- and cost dashboards.

Chat can later reuse the same retrieval, evidence, AI-operation, and access-control
services. It must not introduce a parallel knowledge implementation.
