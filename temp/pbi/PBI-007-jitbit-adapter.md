# PBI-007: Jitbit reference adapter

## Outcome

Prove the helpdesk-neutral contracts with a complete Jitbit implementation.

## Existing implementation reference

Before implementing, inspect
`C:\GIT\Nectari\Scripts\Cloud\Modules\HelpDeskHelper.psm1`, especially:

- `Get-JitbitAllTicketSummaries` for cheap paginated ticket discovery;
- `Get-JitbitTicketDetail` and `Get-JitbitTicketComments` for full records, ordered
  comments, and system/agent-comment exclusion;
- `Get-JitbitTicketAttachments` for attachment metadata from ticket bodies, ticket
  attachments, and comments;
- `Get-UnanalyzedJitbitTickets`, `Publish-JitbitComment`, and
  `Register-TicketAnalysis` for the current selection, publication, and reconciliation
  behavior.

This is behavioral reference material, not a dependency or a design template. Reuse
the API knowledge and edge cases while implementing the CaseWeaver contracts,
incremental fingerprints, secret references, typed failures, and publication marker
semantics defined in `.features/15-connectors-and-destinations-guide.md`.

## Scope

- Jitbit configuration and authenticated client.
- `KnowledgeSource` implementation for resolved cases and `CaseSource` implementation
  for live cases.
- Incremental resolved-case discovery and revision detection.
- Current case, ordered messages, actors, visibility, and attachment metadata loading.
- Webhook verification and domain-event translation where supported.
- Internal-note publication lookup and write.
- Rate-limit, retry-after, pagination, and typed-error handling.
- Connector contract-suite execution.

## Acceptance criteria

- Core packages do not import Jitbit code or branch on connector identity.
- Updated resolved cases are rediscovered and reingested.
- An unchanged resolved case is skipped using the best available API revision, update
  sequence, or deterministic connector fingerprint without generating embeddings.
- If Jitbit reports an update but normalized problem/resolution content is unchanged,
  synchronization records the observation without embedding again.
- Problem and verified resolution content remain distinguishable.
- CaseWeaver publications are excluded using publication identity.
- Publication supports stable marker lookup before write.
- All neutral connector contract tests pass.

## Excluded

Attachment parsing and analysis orchestration.
