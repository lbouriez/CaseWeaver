# PBI-015: Evidence-aware chat service

## Outcome

Add reusable conversation use cases after MCP/search foundations are stable.

## Scope

- Workspace-scoped sessions and messages.
- Bounded conversational context.
- Retrieval/evidence reuse.
- Metered chat model binding through `ai-execution`.
- Message-level evidence, tool, usage, and cost correlation.
- Optional read-oriented MCP/API chat transport integration.

## Acceptance criteria

- Chat uses existing knowledge collections and retrieval.
- No parallel ingestion, vector store, provider invocation, or authorization path exists.
- Answers preserve evidence citations.
- Context and optional compaction are bounded and separately metered.
- Tests use deterministic fake AI providers.

## Excluded

Full chat UI and customer-facing automated support conversations.
