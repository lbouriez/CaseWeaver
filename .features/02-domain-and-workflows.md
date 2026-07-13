# Domain and workflows

## Terminology

The core uses **case**, not ticket. A connector may map a Jitbit ticket, an Odoo helpdesk
ticket, an issue, or another support record to a Case.

| Term | Meaning |
|---|---|
| Workspace | Isolation and configuration boundary |
| Connector | Configured adapter instance |
| Case | Current support request being investigated |
| Case message | Description, comment, note, or reply |
| Knowledge item | External document or resolved-case representation |
| Revision | Immutable observed version of an external item |
| Chunk | Retrieval-sized segment of normalized content |
| Attachment | Binary object associated with a case or knowledge item |
| Derivative | Text extracted or generated from an attachment |
| Analysis | Structured investigation result for a case snapshot |
| Evidence | Verifiable source supporting an analysis statement |
| Publication | Attempt to send an analysis to a destination |

## Normative case shape

A normalized case snapshot must represent, without connector-specific assumptions:

- connector-scoped external identity and external revision information,
- subject, description, lifecycle state, priority, category, and tags when available,
- tenant, company, requester, assignee, and participant identities as optional actors,
- created, updated, resolved, and closed timestamps,
- ordered messages with stable identity, author, timestamp, visibility
  (`public`, `internal`, or `system`), body format, normalized text, and attachments,
- case-level attachment references,
- access metadata,
- resolution status and resolution semantics when the connector can identify them,
- and connector-owned metadata validated by the connector schema.

Missing capabilities remain absent; connectors must not invent values to satisfy a
helpdesk-specific core schema.

## Workflow A: synchronize knowledge

1. Scheduler or API requests synchronization for a connector.
2. Connector discovers changed and deleted external items from a cursor.
3. Each item is normalized into a source-neutral document and immutable revision.
4. Attachments are processed only when their content hash and processor version are new.
5. Text is chunked deterministically.
6. Only new or changed chunks are embedded.
7. New revisions become searchable atomically.
8. Cursor and synchronization statistics are committed.

An unsuccessful revision must not replace the last searchable successful revision.

## Workflow B: analyze a case

1. A manual request, webhook, or poller creates an analysis request.
2. The request is deduplicated by workspace, connector, external case ID, case revision,
   and analysis profile.
3. A worker leases the job and captures an immutable case snapshot.
4. Attachments are fetched and processed within configured limits.
5. The query builder produces a bounded retrieval query.
6. Hybrid retrieval returns evidence from configured sources.
7. The repository agent inspects an explicitly configured repository and pinned commit.
8. The analysis model produces a validated structured result.
9. The destination-neutral analysis and `AnalysisCompleted` event are stored atomically.

## Workflow C: publish an analysis

1. A trigger/application transaction creates or resolves the analysis request and creates
   the durable publication intent before the analysis command is placed in the outbox.
   The intent references an immutable publication profile.
2. An idempotent `AnalysisCompleted` consumer resolves matching intents and enqueues
   publication commands.
3. Publication policy selects preview, approval, or internal auto-publication.
4. The configured publication profile selects destination and renderer.
5. Server code renders destination-specific output and appends policy-controlled notices.
6. The publication command acquires its idempotency lease and invokes the destination.

If the analysis request already completed before a new intent is created, the transaction
that creates the intent also emits a publication-ready command/event. A reconciliation
job finds completed analyses with pending intents so event/intent timing cannot strand
automatic publication.

Publication is independently retryable and idempotent. A successful remote write with a
lost local response must not create a duplicate comment on retry. Adapters should use a
remote idempotency mechanism when available; otherwise they must search for a stable
CaseWeaver publication marker before writing.

## State machines

Synchronization: `queued -> running -> completed | failed | cancelled`

Analysis: `queued -> running -> completed | failed | cancelled`

Publication:
`pending -> awaiting_approval | publishing -> published | outcome_unknown | failed | skipped`

Running records have expiring leases. Expired work is recoverable and increments an
attempt counter. Terminal failures preserve a typed error and retry classification.

## Idempotency

The normalized case revision is a deterministic hash over:

- normalization-version identity,
- selected case metadata,
- ordered relevant messages including visibility and normalized body,
- attachment external identities and observed content metadata,
- and connector-provided external revision identity when available.

An analysis identity includes:

- workspace,
- case connector and external ID,
- normalized case revision,
- analysis profile version,
- repository commit when repository analysis is enabled.

Manual force-rerun creates a new attempt but never silently overwrites an earlier result.

Idempotency keys are scoped to workspace and operation. Reusing a key with a different
normalized request hash returns a conflict. Retention of keys must cover the maximum
retry and webhook-redelivery windows.

Publication additionally has a database uniqueness constraint and lease on workspace,
destination connector, and publication marker. `outcome_unknown` is reconciled through
destination lookup before another write is allowed.
