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

## Planned workspace layout

```text
apps/
  api
  worker
  cli
  mcp
  web                  # future
packages/
  domain
  connector-sdk
  ai-sdk
  persistence
  ingestion
  retrieval
  attachment-processing
  analysis-engine
connectors/
  git-markdown
  jitbit
providers/
  openai-compatible
  azure-openai
  copilot-sdk-agent
  other-agent-runtime     # future provider, no core changes
```

## Dependency direction

- `domain` depends on no application, database, connector, or provider package.
- Connector and AI SDK packages depend only on domain contracts and shared primitives.
- Infrastructure packages implement ports defined inward.
- Applications compose implementations and own process lifecycle.
- Connector packages must never import the analysis engine or persistence implementation.
- Core services must not branch on connector, provider, model, or agent-runtime names.

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

- Single process for local development and small installations.
- Separate API and worker processes for production.
- Multiple workers using database leases.
- Optional isolated repository-agent runner.

No feature may depend on Azure DevOps pipelines, Nectari modules, ReKindle services, or a
specific cloud provider.
