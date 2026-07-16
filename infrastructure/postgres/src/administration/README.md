# PostgreSQL administration persistence

PBI-016 persistence for server-side administration state. OIDC state, nonce, PKCE,
session, and CSRF values are only accepted and stored as one-way digests. The adapter
does not persist provider tokens or expose credential material. Safe connector/provider
descriptor revisions are append-only, workspace-neutral snapshots. Descriptor-backed
configuration drafts and activated versions retain descriptor identity, canonical
settings, and opaque external-secret reference identities only; each new version atomically appends a durable,
lease-claimed cache-invalidation outbox notice.

Diagnostic exports are durable, workspace-scoped, bounded requests. PostgreSQL stores
only private artifact locators, integrity metadata, fixed failure codes, and leased
generation/deletion state. A separate private, 1 MiB-capped artifact table holds the
already-redacted JSON bytes; no artifact URL, secret, request payload, or unredacted
diagnostic body is persisted or returned by administration status reads.

`workspace-role-assignment-store.ts` implements the provider-neutral role-membership
port. It uses a locked workspace aggregate revision for optimistic concurrency, derives
authorization from stored administrator membership rather than caller role claims, and
commits assignment changes, immutable history, idempotency state, and the authoritative
success audit together. PostgreSQL-level protection rejects removing or demoting the
last administrator even if a caller bypasses the adapter. The adapter never stores or
returns browser credentials, token claims, or secrets.

`PostgresSourceScheduleConfigurationStore` is a transaction-bound adapter for the
administration source/schedule managers. It delegates immutable version, idempotency,
audit, and configuration-change outbox work to `PostgresConfigurationLifecycleStore`;
then, in that same transaction, validates the active `knowledgeSource` connector
capability, locks its active descriptor-backed connector configuration, and records the
resulting immutable source-plus-connector version pair before projecting the feature
read-model rows. Schedules consume that stored pair rather than resolving a mutable
connector current version. It never reads connector settings, credentials, or clients.

`PostgresProviderCapabilityTestConfigurationStore` and
`PostgresProviderCapabilityTestStore` resolve only active, workspace-scoped immutable
provider/binding identities and trusted descriptor-owned test templates. They persist
short-lived session-bound confirmations, idempotency claims, bounded database-time
rate windows, and redacted terminal outcomes. Preview/result audit writes share the
same transaction as their durable state, while request templates, provider responses,
secret locators, and secret values never enter these records.

`PostgresAiConfigurationStore` persists pinned catalog snapshots, immutable model
binding versions, role defaults, price overrides, and replacement budget policies in
the PBI-003 AI tables. It locks the affected aggregate, records the mutation
idempotency result and server-owned audit in the same transaction, and appends a
safe-ID-only `administration_ai_configuration_change_outbox` notice before commit.
Bindings use persisted revision plus active/draft immutable-version pointers; role
defaults may target only the active pointer. It validates provider/version/catalog
ownership without resolving a secret or returning endpoint, provider response, or
secret-reference data.

`PostgresPublicationProfileConfigurationStore` is transaction-bound and delegates
generic versions, idempotency, audit, and cache invalidation to
`PostgresConfigurationLifecycleStore`. On activation it parses the retained
configuration with PBI-012's `publicationProfileSchema`, verifies the selected active
`analysisDestination` plus its current descriptor-backed connector configuration, and
inserts the immutable PBI-012 profile version using the same ID as the administration
configuration version. The selected connector configuration version is retained as a
separate immutable pin, so later connector edits cannot rebind durable publication
work. Drafts are intentionally inert; disablement preserves all historical profile
versions and only changes the profile lifecycle.

Webhook configuration is intentionally not projected through `webhook_inbox`: that
table records verified deliveries and cannot safely act as an endpoint registry.

`PostgresWebhookEndpointConfigurationStore` now projects active endpoints into that
dedicated `webhook_endpoints` table. It delegates configuration versioning,
idempotency, audit, and cache invalidation to `PostgresConfigurationLifecycleStore`;
then verifies the current connector configuration has an active `webhookAdapter`
runtime registration and a trusted descriptor permitting every selected event type.
The projection retains only opaque endpoint/connector identities, bounded limits,
optional server trigger, and the exact immutable configuration version. It never
selects request bodies, headers, secret locators, or adapter clients. Verified inbox
rows retain their accepting version separately and cannot be rewritten.

Activating an endpoint that selects an analysis trigger also persists the authenticated
activation principal as internal routing state. The endpoint/runtime adapters never
expose that field through generic administration reads; trusted webhook composition
uses it only to produce attributable, exact-pinned automated analysis requests.

`PostgresWebhookEndpointRuntimeStore` is the separate public-ingress lookup and
database-time rate-admission boundary. Its active-only lookup returns opaque routing
identity, immutable configuration version, bounded limits, and selected connector
identity—never settings, secret-reference locators, request material, or adapters.
Its fixed-minute admission query locks the active endpoint and fails closed for absent
or disabled endpoints. Trusted application composition must still resolve the adapter
from the immutable server-owned configuration and persist the accepting version with a
verified delivery.

`PostgresRuntimeConnectorConfigurationResolver` is the separate trusted worker
composition lookup. It returns a server-private immutable connector version only when
the workspace connector aggregate and configuration are active, its descriptor snapshot
allows the requested capability, and every retained opaque credential locator remains
active in that workspace. It permits an explicitly pinned historical immutable version
for durable work. It has no cache and never resolves a secret or sends settings/locators
to an API, audit, log, diagnostic, or trace boundary.
