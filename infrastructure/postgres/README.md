# PostgreSQL infrastructure

**PBIs:** 002, 003, 004, 009, 013, 016

Migrations, typed repositories, transactions, outbox, pgvector/full-text queries,
workspace filtering, leases, audit records, AI operation ledger, and budget reservations.

Business ranking and state-transition policy remain in vendor-neutral packages.

Owns inbox/outbox persistence and schedule/domain leases. It does not own queue-job
leases or worker heartbeats.

## PBI-012 publication and triggers

The PBI-012 migration adds immutable publication profiles, durable publication intents
and attempts, verified-webhook inbox records, and case-analysis schedules. Publication
identity is unique per workspace, destination connector, and stable marker; execution
uses a fenced resource lease. `PostgresVerifiedWebhookEventStore` persists accepted
case-change commands in the same transaction as its inbox record.

Publication profile activation also selects and stores the exact descriptor-backed
`analysisDestination` connector configuration version. That pin is copied into every
intent and attempt, participates in delivery identity, and is used for private runtime
resolution rather than a connector's mutable current version. Database guards keep the
pin immutable, reject mismatched attempts, and prevent disabling a connector or its
configuration while an active publication profile depends on it. Existing unpinned
history remains readable but fails closed before any destination I/O.

The subsequent versioned-trigger migration creates immutable analysis-trigger revisions
and workspace-scoped trigger requests. Each request pins the trigger revision, analysis
profile version, connector registration, and connector configuration version selected at
acceptance. Database-time capture leases and monotonic fencing tokens prevent stale
captures from committing; normalized immutable snapshots deduplicate against the exact
connector target. The adapter persists no connector settings, secret references, source
URLs, or raw ingress bodies. Legacy trigger commands are unavailable rather than rebound
to a current configuration.

Webhook-triggered analysis follows the same v2 boundary. The verified inbox retains the
server-owned activation principal, then the acceptance transaction locks and verifies the
active trigger's exact current revision, case-source capability, retained connector
configuration version, and workspace actor. It writes the immutable request,
idempotency record, audit event, and `analysis.trigger.v2` outbox envelope together.
Absent actors, legacy rows, and configuration mismatches roll back the inbox rather than
creating unauditable or rebound work.

## PBI-009 retrieval

`createPostgresRetrievalPersistence` implements the retrieval search and immutable
snapshot ports. Search applies workspace, selected-collection, authorized-source,
active-document/revision, and source-lifecycle predicates in both parameterized
full-text and vector queries. The migration provisions finite indexed dimensions `3`
(deterministic tests) and `1536`; callers may configure a subset but unsupported
dimensions are rejected rather than falling back to a corpus scan.

## PBI-011 production analysis evidence

`PostgresSnapshotAttachmentReferenceStore` is the persistence half of frozen analysis
attachment evidence. It reads only an append-only snapshot reference row, checks that
the referenced attachment derivative remains completed and retention-active, and never
selects an attachment from the mutable external-reference relation. It returns neither
an object-storage key nor a storage backend; PBI-008's server-private derivative reader
opens the bounded text separately.

The integration-owned forward migration must add
`case_snapshot_attachment_references` with:

- `workspace_id`, `case_snapshot_id`, and a deterministic `ordinal` primary key;
- immutable `attachment_id`, `attachment_derivative_id`, `processor_version`, and
  `output_content_hash` columns;
- workspace-composite foreign keys to the captured case snapshot, attachment, and
  attachment derivative with `ON DELETE RESTRICT`;
- database guards rejecting update/delete, and a write path that inserts references in
  the same transaction as snapshot capture/analysis request creation.

No storage location, secret reference, external URL, or mutable attachment lookup may
be placed in this table. Retention deletion causes future evidence resolution to fail
closed while the completed analysis retains its already-stored evidence/tombstone.

`PostgresAnalysisRetrievalEvidencePort` bridges an immutable analysis profile to a
`RetrievalService` configured with PostgreSQL search/snapshot adapters. Its runtime
resolver must return the exact persisted retrieval-profile version, collection vector
spaces, authorized-source scope, and policy; a current configuration mismatch fails
closed. It stores an attempt-bound retrieval snapshot and maps results to analysis
evidence while replacing external source URLs with opaque CaseWeaver provenance URLs.
Its retrieval request forwards the server-owned analysis identity and job attribution to
embedding/reranking gateway operations.

`PostgresAnalysisRetrievalRuntimeResolver` now supplies that version projection from
the generic administration configuration store without following its mutable
`current_version_id`. It accepts only an active `retrieval-profiles` aggregate, its
exact workspace/configuration/version pin, empty secret-reference metadata, and a
strict retrieval runtime settings shape (collections/vector identity, bounded policy,
authorized source scope, metadata filters, and the analysis-context tokenizer binding).
Version rotation therefore cannot rebind queued analysis work. The integration host
must still provide model-compatible bound token counters and construct the retrieval
service from the PostgreSQL search/snapshot adapters and exclusive AI gateway.

`createPostgresAnalysisEvidenceRuntime` owns a deliberately narrow Prisma client
for immutable snapshot-attachment references and retained retrieval-profile
versions. It exposes only those feature ports and closes with its worker host;
it never exposes a Prisma client or follows a mutable configuration pointer.

`PostgresRepositoryRuntimeConfigurationResolver` applies the same exact-pin
rule to an active `repository-runtimes` administration configuration version.
It validates the repository/commit and repository-agent binding retained in
strict settings, an explicit read-only tool allowlist, bounded OCI limits,
hard known-price budget policy, and exactly one active opaque checkout
credential registration. It never follows `current_version_id`; its private
checkout locator is returned only to trusted checkout-broker composition and
is absent from API/audit read models. `createPostgresRepositoryRuntime` owns
that narrow resolver client for the worker lifecycle.

## PBI-004 pinned knowledge execution

`20260715126000_pbi_004_knowledge_execution_runtime` adds immutable collection
runtime versions, source-runtime links to those exact collection/profile/policy/batch
values, and database-time source execution fencing. Older runtime rows remain readable
but have null execution fields and are deliberately unavailable to the resolver; they
are never backfilled from mutable source or collection rows. The collection runtime
record retains an immutable embedding binding, profile, dimensions, token limit, and
hard-budget metadata only.

`PostgresPinnedKnowledgeSourceConfigurationResolver` returns the safe source-neutral
runtime projection after verifying workspace scope, source/connector lifecycle,
capability, exact source/connector pins, collection runtime, and policy shape. It does
not select connector settings, secret locators, or clients. `PostgresKnowledgeSourceExecutionStore`
claims the cursor and increments a database-time fence in one update; ingestion commit
locks and verifies that fence before it activates revisions or advances a cursor.

Implements `OutboxStore` with multi-replica-safe claiming, retry metadata, and envelopes
for both commands and domain events. It does not publish them directly.

## Implementation decision

- Prisma schema/client/migrations for conventional relational data and transactions.
- Checked-in custom migration SQL for extensions and specialized indexes.
- Parameterized Prisma raw/TypedSQL or narrowly scoped `pg` queries for pgvector,
  full-text, bulk operations, leases, and outbox claiming.
- No Prisma-generated type leaves this package.

Planned internal layout:

```text
prisma/
  schema.prisma
  migrations/
src/
  client/
  repositories/<capability>/
  queries/
  unit-of-work/
```

See `.features/20-persistence-and-database-guide.md`.

## PBI-002 foundation

`prisma/migrations/20260713190000_pbi_002_foundation` is the first forward-only
migration. It enables `vector` but deliberately creates no vector columns, retrieval
indexes, normalized content, or connector configuration fields. Apply it with:

```powershell
$env:DATABASE_URL = "postgresql://..."
pnpm --filter @caseweaver/postgres run prisma:migrate:deploy
```

The adapter exposes application ports only. Its outbox claim/ack and resource-lease
operations use parameterized PostgreSQL SQL with database time, `SKIP LOCKED`, and
fencing tokens. `test:integration` requires a disposable `DATABASE_URL` whose database
name includes `test`.

## PBI-013 operations

`20260714140000_pbi_013_operations` adds queryable immutable AI-operation attribution,
fenced expired-attempt recovery, privacy tombstones, and durable retention work items.
Privacy purge replaces governed snapshot/result/evidence content with tombstones and
queues object deletion; retention workers complete the object deletion through a
fencing token before metadata is marked deleted. The subsequent canonical-retention
migrations add immutable storage backend identity to new attachment blobs, derivative
outputs, and retention work. Reaping first creates reference-only work, then creates
object work only after all live references are gone. Object work carries the complete
workspace/backend/key tuple; pre-existing key-only work remains readable but is
deliberately rejected by the application before storage I/O, never mapped to the
current deployment backend.

## PBI-016 administration foundation

The PBI-016 forward migration adds workspace-scoped administration configuration
aggregates and immutable version rows, plus server-side session, external OIDC identity,
and one-use login-transaction tables. Session and CSRF values are stored only as digests
plus a purpose-bound authenticated-encryption ciphertext for the server to recover the
CSRF synchronizer token; nonce and PKCE verifier use short-lived encrypted ciphertexts
for callback validation. No credential or browser token column exists.
The migration also expands audit-event metadata and prevents audit/configuration-version
updates or deletes at the database boundary.

PBI-016 descriptor revisions are immutable safe catalog snapshots registered by trusted
backend composition. Descriptor-backed configuration drafts create an immutable version
immediately and atomically append a configuration-change outbox record. The relay claims
these records with a lease and publishes cache invalidation only after commit; neither
descriptor snapshots nor notification payloads contain settings or secret references.

The administration repositories also expose redacted workspace read models, durable
session-bound action previews, and opaque secret-reference lifecycle metadata. External
secret reference values are never selected by the administrative API. Authentication
audits are persisted with only server-owned actor/workspace/action/outcome metadata.

Diagnostic-export requests use the same durable boundary: the request row, idempotency
record, `diagnostics.export.generate.v1` outbox envelope, and success audit are one
PostgreSQL transaction. Private bounded bytes are stored separately and can only be
opened after the API persists its sensitive-read audit; no artifact locator is selected
by administration list/status projections.

Workspace role-assignment management persists a workspace-level membership revision,
append-only role-change history, and immutable idempotency results. The PostgreSQL
adapter locks that revision before changing a target principal's role set, verifies the
actor has a persisted administrator assignment, and atomically records the successful
server-owned audit event. A database trigger also rejects direct removal or demotion of
the final administrator, so the invariant is not dependent on an HTTP route. Role audit
records retain only target identity and canonical before/after hashes.

Knowledge-source and knowledge-schedule administration projections use immutable
administration configuration version IDs. New source rows must reference their own
`knowledge-sources` version; schedules retain both the immutable selected source version
and their own `schedules` version. The forward migration uses `NOT VALID` foreign keys
so legacy PBI-004 rows remain readable during upgrade while all new writes are enforced.
`PostgresSourceScheduleConfigurationStore`, constructed inside a `UnitOfWork`
transaction, verifies active connector capability, workspace-owned collection/source,
and version/resource identity before it writes either projection.

Provider capability-test persistence resolves only an active provider's latest immutable
version and a matching active workspace-default binding. Trusted composition supplies
the safe descriptor template; PostgreSQL stores only its digest, safe cost metadata,
one-use session-bound confirmation identity, durable idempotency claims/results, and
database-time rate buckets. Preview/terminal audit records share their corresponding
confirmation/result transaction, and database triggers keep confirmations, claims, and
results append-only.

`PostgresAiBindingResolver` is the runtime-facing read adapter for those
immutable AI records. It fails closed unless the workspace binding and provider
are active and its opaque credential registration is active. New work resolves
only the aggregate's `active_version_id`; an explicitly supplied immutable
binding-version pin resolves that retained version after rotation rather than
substituting the current version. It collects
catalog, installation, workspace, and binding price components without reading
or logging a secret value.

Publication-profile administration bridges the generic immutable administration
configuration aggregate to the existing PBI-012 `publication_profiles` and
`publication_profile_versions` records. A draft creates no PBI-012 profile; an
activated configuration is parsed by the PBI-012 publication schema, must select an
active `analysisDestination`, and reuses its administration version ID as the
immutable profile-version ID. Disabling a profile only changes the aggregate
lifecycle, preserving version rows referenced by publication intents.

Webhook endpoint projections use a dedicated forward schema rather than repurposing
the existing `webhook_inbox`, which remains delivery history only. Platform public
links use the immutable administration configuration tables under `platform-links`;
public-link API projection is composed above this adapter.

The webhook endpoint migration provides a separate opaque endpoint projection, distinct
immutable endpoint-routing and connector-adapter configuration pins for the endpoint and
each accepted inbox record, fixed rate windows, and replay-request state. Endpoint
activation is transaction-bound with its immutable administration version, audit,
idempotency result, and cache notice. PostgreSQL validates the active connector's
`webhookAdapter` capability; composition still resolves the runtime adapter and any
secret locator privately, never through endpoint read models.
