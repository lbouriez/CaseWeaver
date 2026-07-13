# Chat and MCP implementation guide

## Purpose

Expose existing CaseWeaver knowledge and analysis capabilities to humans and external
assistants without creating a parallel platform.

## Chat service

Chat reuses:

- workspace authorization,
- knowledge collection selection,
- hybrid retrieval,
- prompt templates,
- metered AI execution,
- evidence references,
- usage/cost ledger,
- retention policy,
- and attachment derivatives where explicitly allowed.

Chat does not ingest content, own embeddings, call providers directly, or implement a
second retrieval store.

## Conversation model

- Sessions and messages are workspace-scoped.
- Message content and retention are explicit.
- Every answer stores selected evidence and immutable binding/template versions.
- Tool calls and AI operations correlate to the message.
- Context is bounded; older messages are summarized only through a separately metered
  operation when configured.

## MCP

MCP is a transport over application use cases. Initial tools:

- search knowledge,
- retrieve evidence,
- retrieve an analysis,
- request case analysis when enabled,
- and inspect job status.

Each tool has:

- strict input/output schema,
- authenticated principal and workspace,
- explicit read/write capability,
- authorization,
- bounded result size,
- audit correlation,
- cancellation,
- and citations.

Write-capable tools are disabled by default. MCP must not expose raw connector/provider
credentials, arbitrary SQL, filesystem access, or unrestricted repository tools.

## Prompt and injection safety

External MCP/chat content is untrusted. Retrieved documents and tool results are labeled
as evidence. Tool selection is server-controlled and allowlisted. A model cannot grant
itself permissions or change workspace/source scope.

## Minimum tests

- Workspace/source authorization.
- Citation preservation.
- Bounded search/context.
- Read-only default MCP configuration.
- Write tool authorization and idempotency.
- Chat answer uses metered AI gateway.

Do not test exact prose. Test schemas, evidence, permissions, tool calls, and accounting.
