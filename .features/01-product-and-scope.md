# Product and scope

## Problem

Support engineers investigate cases by manually combining:

- the current conversation and attachments,
- previous support cases and resolutions,
- product documentation,
- operational knowledge,
- and the source code matching the deployed product.

This is slow, inconsistent, difficult to audit, and expensive when implemented as an
unbounded LLM prompt.

## Product statement

CaseWeaver receives a support case, gathers and normalizes its evidence, retrieves
relevant knowledge, optionally investigates a pinned code repository, and returns a
structured analysis that can be reviewed or published through a destination adapter.

## Primary actors

- **Support engineer:** reviews the analysis and follows its evidence.
- **Administrator:** configures connectors, model roles, budgets, and schedules.
- **Connector developer:** adds a source or destination without modifying core logic.
- **External assistant:** queries CaseWeaver through its future MCP server or API.

## First-release capabilities

- Multiple independently configured knowledge-source instances.
- Git/Markdown knowledge ingestion with incremental synchronization.
- Resolved-case ingestion through a generic helpdesk connector.
- Jitbit as the first source and destination adapter.
- Multimodal attachment extraction and reusable derived-content cache.
- Hybrid retrieval over documentation and historical cases.
- Read-only repository investigation.
- Manual, webhook, and scheduled analysis triggers.
- Structured analysis, evidence, publication, audit, and cost records.

Each knowledge source has its own synchronization policy and may target a configured
knowledge collection. Analysis profiles independently select knowledge collections,
destination adapters, and immutable model bindings for embedding, vision, analysis, and
repository-agent roles.

## Explicit non-goals for the first release

- Replacing a helpdesk product.
- Automatically replying to customers.
- A general workflow automation platform.
- A general-purpose coding agent.
- A broad chat UI.
- Supporting every document format or vector database.
- Training or fine-tuning models.

## Differentiation

CaseWeaver is ticket/case-native rather than chat-native. The product boundary includes:

- portable source and destination contracts,
- source-owned schedules and change detection with no-op unchanged synchronization,
- provider- and agent-runtime-neutral AI contracts,
- durable case-analysis orchestration,
- attachment and vision result reuse,
- evidence-linked repository investigation,
- safe and idempotent write-back,
- and complete per-analysis cost attribution.

General RAG systems may be used behind an adapter later, but CaseWeaver owns this
workflow and its audit model.
