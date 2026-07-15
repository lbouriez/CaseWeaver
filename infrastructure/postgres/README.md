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

## PBI-009 retrieval

`createPostgresRetrievalPersistence` implements the retrieval search and immutable
snapshot ports. Search applies workspace, selected-collection, authorized-source,
active-document/revision, and source-lifecycle predicates in both parameterized
full-text and vector queries. The migration provisions finite indexed dimensions `3`
(deterministic tests) and `1536`; callers may configure a subset but unsupported
dimensions are rejected rather than falling back to a corpus scan.

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
fencing token before metadata is marked deleted.

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
are active, the binding's `active_version_id` selects the requested immutable
version, and its opaque credential registration is active. It collects
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

The webhook endpoint migration provides a separate opaque endpoint projection, pinned
inbox configuration version, fixed rate windows, and replay-request state. Endpoint
activation is transaction-bound with its immutable administration version, audit,
idempotency result, and cache notice. PostgreSQL validates the active connector's
`webhookAdapter` capability; composition still resolves the runtime adapter and any
secret locator privately, never through endpoint read models.
