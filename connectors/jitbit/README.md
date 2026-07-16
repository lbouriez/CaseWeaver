# Jitbit connector

**PBI:** 007

Reference Jitbit adapter for `KnowledgeSource`, `CaseSource`, and
`AnalysisDestination`. It uses an injected authenticated HTTP client, secret references
resolved at runtime, and connector-owned Zod response schemas. It does not implement
attachment byte access, webhooks, scheduling, database access, analysis, or AI calls.

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

The current descriptor revision is `2`, whose `requestTimeoutMs` field matches the
authoritative settings schema. Revision `1` is retained only so durable historical
configuration versions can be read by trusted runtime composition through
`createJitbitRuntimeContributions`; new API drafts must use revision `2`. Neither
revision exposes a secret value, locator, client, or runtime exception through
descriptor metadata.
