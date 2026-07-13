# PBI-014: MCP foundation

## Outcome

Expose authenticated, evidence-oriented CaseWeaver capabilities to external assistants.

## Scope

- MCP application and authentication.
- Workspace and source authorization.
- `search_knowledge`, `get_evidence`, `get_analysis`, and analysis-status tools.
- Optional `analyze_case` tool behind explicit write-capability configuration.
- Citation-rich result schemas, rate limits, audit events, and usage correlation.

## Acceptance criteria

- Search and evidence tools cannot cross workspace or source permissions.
- Responses include stable evidence citations.
- Write-capable analysis is disabled by default.
- Every MCP call has an authenticated principal and audit correlation.
- MCP reuses core retrieval and orchestration services rather than parallel logic.

## Excluded

Chat UI and destination publication tools.
