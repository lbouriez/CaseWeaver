# Roadmap

## Milestone 1: walking skeleton

- Monorepo, configuration, PostgreSQL, migrations, queue, API, worker, and CLI.
- Workspace-scoped records and durable job leasing.
- Fake connectors and fake AI providers proving the full state machine.

Exit: a fake case can move from request through stored structured analysis and preview.

## Milestone 2: AI and pricing foundation

- Provider-neutral AI contracts.
- Immutable model-binding versions and deterministic fake repository-agent provider.
- OpenAI-compatible embedding, vision, and generation.
- Copilot SDK BYOK repository-agent adapter.
- LiteLLM catalog snapshot/import and overrides.
- Usage ledger and hard/soft budgets.

Exit: each model role can be configured independently and every invocation is costed or
explicitly marked unknown.

## Milestone 3: knowledge foundation

- Incremental ingestion framework.
- Per-source scheduling, cursors, external fingerprints, and no-op synchronization.
- Knowledge collections with independently configured embedding bindings.
- Git/Markdown and Docusaurus conventions.
- Chunking, embeddings, activation, deletion, and hybrid retrieval.

Exit: changed documentation becomes searchable without re-embedding unchanged chunks.

## Milestone 4: portable case integration

- Helpdesk-neutral case, message, attachment, webhook, and destination contracts.
- Connector contract test kit.
- Jitbit reference connector for resolved knowledge, live cases, attachments, webhooks,
  and internal-note publication.

Exit: no core package imports or branches on Jitbit.

## Milestone 5: secure investigation

- Attachment processors and content-addressed derivative cache.
- Repository checkout and sandbox.
- Optional Copilot SDK BYOK repository-agent provider.
- Structured analysis and evidence validation.
- Preview, approval, and idempotent internal publication.

Exit: one real Jitbit case is safely analyzed against documentation, history,
attachments, and a pinned repository commit.

## Milestone 6: production operations

- Polling and cron triggers.
- Retry, lease recovery, dead-letter operations, retention, diagnostics, and metrics.
- Docker Compose deployment and installation documentation.

Exit: CaseWeaver operates autonomously with bounded cost and recoverable failures.

## Later milestones

- Odoo reference connector.
- Additional document and helpdesk connectors.
- MCP server.
- Administration and review UI.
- Evidence-aware chat.
- Optional reranking and external vector-store adapters.
