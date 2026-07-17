# Attachment PostgreSQL persistence

`PostgresAttachmentRepository` persists workspace-scoped attachment references, blobs,
derivative cache claims, failure history, and AI operation attribution. Every new blob
or derivative output records its opaque deployment `storage_backend_id` with its key;
legacy key-only metadata is never rebound to a current backend.

It does not claim or delete expired storage itself. PBI-013 owns one canonical durable
retention-work lifecycle in `PostgresOperationsStore`: reference expiry is metadata-only,
then independently fenced object work carries the exact `{ workspaceId,
storageBackendId, key }` tuple to the configured object-storage bridge. This avoids a
second unaudited cleanup path in attachment persistence.

AI operation IDs stay opaque because the PBI-003 ledger has no guaranteed
foreign-key composition here; derivative-source queries expose that attribution with
the source job instead.

Completed derivatives retain the verifier-derived SHA-256 and exact byte length of
canonical UTF-8 output. `findDerivativeEvidenceRecord` is a server-private, typed
lookup for the exact workspace/attachment/derivative association; it returns no
external reference, URL, or secret and fails closed for deleted, legacy, malformed, or
unlinked records. Object bytes are still re-verified by `attachment-runtime` before
they become analysis evidence.

`PostgresAttachmentOccurrencePreparationStore` adds the durable occurrence and
preparation ledger used before knowledge embedding and case analysis. Occurrences keep
only safe metadata in their normal read model; the encrypted reopen locator is stored
separately and is available only through the deliberately server-private lookup. A
fenced lease serializes preparation attempts, and a terminal attempt writes immutable
per-occurrence evidence atomically with its final state. A `ready` record is accepted
only when it matches an active completed `text/plain` derivative linked to the exact
attachment reference, connector registration/configuration-version provenance, input
content hash, processor version, and output content hash. Required unavailable items
fail an attempt; optional unavailable items remain an explicit safe warning. The store
uses database time for lease ownership at both claim and finalization, so a stale worker
cannot finalize after a reclaim or expiry.

Terminal preparation attempts are intentionally not reopened because their evidence is
append-only. A retry uses a new preparation identity (and can still reuse the immutable
derivative cache). These persistence types do not fetch connector data, decrypt
locators, invoke processors or AI, expose generic API projections, or compose workers.

## Stable preparation attempts

`PostgresAttachmentPreparationAttemptStore` implements the newer
`AttachmentPreparationAttemptStore` for an earlier, stable subject
(`sourceDocument` or `caseCapture`). It uses
`20260717120000_stable_attachment_preparation_attempts` and deliberately does not reuse
the older owner/run ledger above.

The migration must retain these exact durable boundaries:

- `attachment_preparation_attempts` stores workspace, stable subject, plan hash, pinned
  policy mode/version/access hash, positive `attempt_sequence`, optional
  `retry_of_attempt_id`, `claimed|completed` state, fence/lease, safe result JSON and
  retry flag. It has a workspace-composite self foreign key for retries, uniqueness for
  `(workspace, subject, plan, sequence)`, and a state coherence check: a claim has a
  fence/lease only; a completion has a result identity/result/completion time only.
- `attachment_preparation_attempt_occurrences` is populated with the safe occurrence
  identity, ordinal, relation and required flag in the same transaction as its claim.
  `(workspace, attempt, occurrence identity)` and `(workspace, attempt, ordinal)` are
  unique.
- `attachment_preparation_attempt_evidence` is append-only. An enabled preparation
  completion has exactly one row for each registered occurrence; a disabled policy has
  no evidence rows. A `ready` row pins only derivative ID, cache identity and output
  content hash; an `unavailable` row retains only warning code/retryability. The ready
  row foreign key and adapter query both require the derivative to be completed and to
  match those two immutable identities.
- database triggers reject mutation or deletion of completed attempts, occurrence
  registrations, and evidence. Downstream case/knowledge records pin terminal attempt
  IDs rather than a mutable current record.

Claim/reclaim and finalization compare leases with `statement_timestamp()` inside
PostgreSQL. A retryable completed outcome creates a new, linked immutable attempt;
an expired nonterminal claim is reclaimed by replacing its fence. A currently live
claim returns the adapter's retryable `PostgresAttachmentPreparationAttemptInProgressError`
instead of allowing two workers to share a fence.

The completion JSON and cache return value contain only `AttachmentPreparationOutcome`.
They never contain derivative text, an object-storage handle/key/backend, locator, URL,
path, source content, operation ID, or secret. A worker that needs derivative bytes/text
after a cache hit must use the separately authorized, server-private derivative evidence
reader for the pinned record; it must not infer or reconstruct a current attachment.

The schema is intentionally one terminal evidence state per occurrence for an enabled
policy. The adapter therefore rejects a result that has multiple selected
derivatives/warnings for one occurrence, a warning without an occurrence identity, or
leaves any registered occurrence uncovered. The current occurrence coordinator naturally
emits that shape; if a future processor needs multiple diagnostics per occurrence, it
needs a separate append-only diagnostic table rather than weakening this evidence
identity.

PBI-008 exports composition only. It deliberately does not register a worker command:
PBI-011/PBI-012 must define the durable analysis/source-job command contract that
provides attachment and source-job attribution.
