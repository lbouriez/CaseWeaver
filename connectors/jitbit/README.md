# Jitbit connector

**PBI:** 007

Reference Jitbit adapter for `KnowledgeSource`, `CaseSource`, `AttachmentSource`, and
`AnalysisDestination`. It uses an injected authenticated HTTP client, secret references
resolved at runtime, and connector-owned Zod response schemas. It does not implement
webhooks, scheduling, database access, attachment persistence/processing, analysis, or
AI calls.

## Attachment capability

`JitbitAttachmentSource` opens `GET /api/attachment?id=<fileId>` with the configured
server-side credential and returns an abort-aware `AsyncIterable<Uint8Array>`. It never
buffers response bytes, persists content, calls AI, or trusts a declared content type;
the attachment pipeline owns byte limits, hashing, MIME detection, storage, cache use,
and derivative processing. Remote failures are generic typed connector errors and never
include a response body, URL, credential, external-secret locator, or attachment path.

Normalized cases and historical resolved-case documents emit attachment occurrences at
their real owner. Declared Jitbit attachments use `declaredAttachment`; `<img
src="/File/Get/<id>">` references in the ticket body and eligible comments use
`inlineImage`. System comments and CaseWeaver publication-marker comments are excluded
before attachment extraction. Each occurrence keeps its owner and ordinal even when it
references the same Jitbit binary; legacy aggregate metadata deduplicates that binary
reference only.

The occurrence reopen locator is an internal URL-safe opaque token containing no URL,
local path, or credential. It is supplied only to trusted runtime attachment reopening,
never to public DTOs, browser state, audit payloads, logs, traces, or diagnostics.

## Resolved-case source filter

`JitbitResolvedKnowledgeFilter` is the connector-owned source-filter shape. Its
`resolvedOrClosedOnly` setting defaults to `true` and accepts every Jitbit terminal
status recognized by this adapter (`closed`, `resolved`, `done`, `completed`, `solved`,
or `cancelled`), rather than only literal `Closed`. It is intentionally not a
connector-instance setting: separate immutable knowledge sources can require different
eligibility policies.

`JitbitKnowledgeSource` accepts this filter as an optional injected source-version
projection. Parent administration/persistence/runtime composition must persist and pass
that immutable source filter; this connector does not own its Admin form or database
projection. Until that projection is composed, the safe terminal-only default applies.

Resolved knowledge discovery emits **delta** pages only. Jitbit has no scan epoch, so
absence never emits a tombstone. Summary `LastUpdated` is the preferred opaque
fingerprint; otherwise a deterministic summary hash is used. Discovery only requests
`/api/Tickets` and never loads ticket bodies or invokes AI.

`initialUpdatedFrom` is an optional bootstrap lower bound. The host persists the opaque
cursor returned after a completed scan. On the next scan the connector subtracts
`updatedFromOverlapDays` (default one day) from that date before sending Jitbit's
date-granular `updatedFrom`; this conservative overlap protects same-day changes.
Intermediate cursors retain their offset and do not change the date. The connector never
persists a cursor itself.

Loads use `/api/ticket` and `/api/comments`, sort non-system messages ascending, and
exclude only exact CaseWeaver publication marker comments. Attachment data is metadata
only for PBI-008. Jitbit does not provide a stable immutable revision pin, so loads do
not claim one.

Publishing scopes marker lookup to the target case before a form-encoded
`forTechsOnly=true` write. A network or timeout failure after the write begins returns
`outcome_unknown`; callers must reconcile rather than blindly retry.

The exported administration descriptor supplies safe discovery/form metadata only. API
composition registers it dynamically, while this adapter remains authoritative for
Jitbit settings and secret-reference validation.

The composition-registered `connector.test` operation parses the same authoritative
settings, resolves its opaque API-token reference only inside the server runtime, and
performs one `count=1` ticket-summary read. It deliberately discards the ticket and
remote error details, leaving the administration API with only a bounded terminal
status to audit and return.

## Production runtime contribution

`createJitbitRuntimeContribution` is the connector-owned construction boundary for a
trusted worker/runtime registry. It accepts only an exact
`ServerPrivateConnectorConfiguration` version plus the registry-injected server-side
secret resolver, validates the descriptor/settings/opaque credential locator
relationship, and returns the declared knowledge-source, case-source, and
analysis-destination ports sharing one `JitbitClient`. It resolves no secret while it
is constructed; the client resolves the opaque reference only for a cancellable outbound
request.

The current descriptor revision is `4`, whose `requestTimeoutMs` field matches the
authoritative settings schema and declares `attachmentSource`. Revisions `1`, `2`, and
`3` remain executable through `createJitbitRuntimeContributions` for durable historical
work; only revision `4` is used for new drafts. Neither revision exposes a secret value,
attachment locator, client, or runtime exception through descriptor metadata.
