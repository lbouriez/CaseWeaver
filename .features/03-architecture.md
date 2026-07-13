# Architecture

## Runtime topology

```text
CLI / API / Webhooks / Scheduler
              |
              v
       Durable PostgreSQL queue
              |
              v
            Worker
   +----------+-----------+
   |          |           |
Connectors  AI ports  Repository sandbox
   |          |           |
   +----------+-----------+
              |
   PostgreSQL + pgvector
              |
      Object storage (optional)
```

PostgreSQL is the initial system of record, vector store, full-text index, lease store,
and queue backend. This minimizes required infrastructure for self-hosters.

Multiple configured instances of the same or different connector may run concurrently.
The core addresses them through capability ports and configuration IDs, never tool or
vendor names.

## Workspace layout

```text
apps/
  api
  webhook
  scheduler
  worker
  cli
  mcp
  standalone
  web                  # future
packages/
  domain
  application
  connector-sdk
  ai-sdk
  ai-config
  ai-execution
  knowledge
  retrieval
  attachments
  analysis
  publication
  prompts
  scheduling
  webhooks
  chat
  security
  observability
connectors/
  _template
  git-markdown
  jitbit
providers/
  _template
  openai-compatible
  copilot-sdk-agent
infrastructure/
  postgres
  queue-postgres
  object-storage
  attachment-runtime
  repository-runtime
deploy/
  docker
tests/
  contract
  integration
  e2e
```

## Process responsibilities

- `api` is the authenticated control plane. It manages configuration, jobs, approvals,
  evidence, and cost queries.
- `webhook` is the public event ingress. It verifies connector signatures, translates
  events, and enqueues commands. It performs no ingestion or analysis.
- `scheduler` evaluates per-source synchronization and case-analysis schedules and
  enqueues due commands. It performs no connector synchronization or AI work.
- `worker` owns all retryable execution: source synchronization, attachments, embedding,
  retrieval, repository investigation, analysis, and publication.
- `mcp` exposes authenticated external tools by calling application use cases.
- `cli` administers the same application use cases without parallel business logic.
- `standalone` composes API, webhook, scheduler, and worker modules for small
  installations; it contains composition only.
- `web` is a future client of the API.

Webhook and scheduler processes remain thin so public requests and clock ticks cannot
hold expensive work, bypass budgets, or create a second orchestration path.

## Dependency direction

- `domain` depends on no application, database, connector, or provider package.
- Connector and AI SDK packages depend only on domain contracts and shared primitives.
- `application` owns use cases and ports but no vendor implementations.
- Feature packages implement reusable vendor-neutral policies behind application ports.
- `ai-execution` is the exclusive metered path to concrete AI providers.
- Infrastructure packages implement ports defined inward.
- Applications compose implementations and own process lifecycle.
- Connector packages must never import the analysis engine or persistence implementation.
- Core services must not branch on connector, provider, model, or agent-runtime names.
- Apps contain dependency composition and transport code only; business behavior belongs
  in packages.

## Cross-cutting execution boundaries

- Feature packages never call provider adapters directly. `ai-execution` resolves an
  immutable binding, reserves budget, invokes the provider, normalizes usage, finalizes
  cost/ledger state, and returns the normalized result.
- Verified webhook events are committed through an inbox/outbox transaction before
  asynchronous queue delivery.
- Queue job leases belong to the queue adapter. Schedule/domain leases are separate
  records owned by PostgreSQL repositories.
- Standalone and distributed deployments use the same PostgreSQL queue, handlers, leases,
  migrations, and configuration. Standalone only co-locates process lifecycle.

## Technology baseline

- Node.js 22 or later.
- Strict TypeScript with ESM.
- pnpm workspaces.
- Fastify with Zod-derived validation.
- PostgreSQL with pgvector and full-text search.
- A PostgreSQL-backed job queue such as pg-boss.
- Explicit SQL migrations with a typed query layer.
- OpenTelemetry-compatible tracing and metrics.
- Structured logging with secret and content redaction.
- Vitest for unit, integration, and contract tests.

The exact library may change through an architecture decision record, but the boundaries
and behavior in this directory must remain.

## Deployment modes

- Standalone process for local development and small installations, using the same
  durable PostgreSQL queue and handlers.
- Separate API, webhook, scheduler, and worker processes for production.
- Multiple workers using database leases.
- Optional isolated repository-agent runner.

No feature may depend on Azure DevOps pipelines, Nectari modules, ReKindle services, or a
specific cloud provider.
