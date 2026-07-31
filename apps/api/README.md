# API application

**PBIs:** 001, 002, 012, 013, 016, 021

Authenticated control-plane HTTP API for configuration, synchronization requests,
analysis jobs, approvals, publications, evidence, budgets, and cost queries.

PBI-013 adds authenticated routes for dead-letter inspection/retry, job
cancellation/recovery, cost attribution, privacy snapshot purge, and retention reaping.
Mutation bodies include request and idempotency digests; principals are resolved by the
trusted execution-context adapter, not request input.

Depends on application use cases and composition modules. It must not execute background
work, implement connector logic, or duplicate domain authorization.

## PBI-016 administration API

`modules/auth` implements deployment-owned password login and provider-neutral OIDC
Authorization Code + PKCE with server-managed encrypted state/nonce/verifier material,
HttpOnly cookie sessions, CSRF, trusted-origin enforcement, workspace selection, and
redacted append-only auth audits. Password login defaults to `admin` / `admin` only in
development and test, and is disabled by default in production. A production deployment
must deliberately set `ADMIN_ENABLE_PASSWORD_AUTHENTICATION=true` plus explicit,
non-default `ADMIN_LOGIN` and `ADMIN_PASSWORD` values; otherwise it must configure
OIDC. `ADMIN_DISABLE_LOGIN_AUTHENTICATION=true` explicitly selects OIDC-only login.
`modules/administration` exposes the typed `/v1/auth/*` and `/v1/admin/*`
surface consumed by `apps/admin`; it validates descriptors server-side, scopes all
records to the session workspace, uses persistent one-use action previews, and composes
existing publication/operations use cases rather than duplicating their policy.
Authentication redirects and session responses are `Cache-Control: no-store, private`;
the session response also varies by cookie. This prevents an anonymous response from
being replayed after the API has established an HttpOnly session.

Descriptor revisions are immutable. The descriptor discovery routes expose only the
newest registered revision of each type for new authoring, while historical revisions
remain available only to trusted configuration-history and runtime resolution. This
prevents an older form/help revision from shadowing current operator guidance.

The API returns credentialed CORS headers only for explicit
`ADMIN_ALLOWED_ORIGINS`; it never reflects or wildcards an origin. `POST
/v1/admin/secret-references` accepts an opaque external-secret locator, persists only
that server-side metadata and a generated ID, and never returns the locator or a secret
value. Descriptor drafts accept those registration IDs for secret slots; composition
resolves active metadata inside the transaction before adapter-owned validation.

`POST /v1/admin/diagnostics/exports` accepts a bounded export request and returns a
safe status DTO only after it has atomically persisted the request, worker outbox
envelope, and audit. `GET /v1/admin/diagnostics/exports/:exportId` and its `/download`
subroute are workspace-scoped sensitive reads. The download audit commits before any
private bytes are streamed; status responses and URLs never include artifact locators.

`POST /v1/admin/knowledge-sources/drafts` and `/v1/admin/schedules/drafts`
compose feature-owned immutable configuration lifecycles. The server issues source
and schedule IDs from the scoped idempotency boundary, validates connector capability,
collection/source/version workspace ownership in the PostgreSQL transaction, and writes
the projection plus its append-only audit event atomically. Drafts are inert and the
resource-specific `POST /v1/admin/knowledge-sources/:id/lifecycle` and
`POST /v1/admin/schedules/:id/lifecycle` routes create successor immutable versions
from server-reloaded projections. They accept only an expected revision and lifecycle,
never connector, collection, filters, or schedule settings. An enabled schedule must
reference an enabled source; disabling a source with enabled schedules is conflict-safe
and requires those schedules to be disabled first.

`POST /v1/admin/collections` creates a workspace-scoped immutable vector-space
identity. It accepts an active embedding-binding aggregate ID plus the
deployment-selected compatibility profile and vector dimension; the API resolves
and pins the binding's active immutable version inside the same PostgreSQL
transaction as idempotency and the authoritative audit record. A collection is
never silently rebound when an AI binding changes.

Connector configuration tests use the typed
`/v1/admin/connector-descriptors/:type/draft-tests` read, preview, and
execution routes. Composition, rather than the UI, registers each bounded,
read-only operation. The API validates a candidate using the owning connector,
replaces all candidate settings and secret locators with a SHA-256 digest before
issuing a short-lived session-bound confirmation, and returns only a terminal
status. Preview/result persistence and its server-owned audit event are atomic;
remote response data, URLs, credentials, locator values, and exceptions do not
enter browser DTOs, audit data, or diagnostics.

Publication profiles, webhook endpoints, and platform links have their own draft,
lifecycle, and public-link routes. A webhook draft never becomes public until its
successor configuration activates; public ingress resolves the endpoint's opaque ID and
persisted limits before it asks trusted composition for an adapter. AI routes manage
pinned catalog snapshots/models, immutable binding versions, role defaults, pricing
overrides, and budget policies. Provider capability-test preview/execute routes use the
exclusive `@caseweaver/ai-execution` gateway and require server-owned known pricing,
budget policy, confirmation, rate limit, deadline, idempotency, and atomic audit state.

`POST /v1/admin/retrieval-profiles/drafts` and
`POST /v1/admin/prompt-profiles/drafts` create descriptor-free, secret-free immutable
policy documents. Their matching lifecycle routes create successor versions using only
the server-reloaded document and an expected revision. The configuration-surface catalog
advertises those workflows only when this composition is installed; the Admin console
therefore never fabricates a profile editor for an unavailable backend.

Malformed authenticated administration requests, invalid idempotency keys, and rejected
sensitive exports are audited with fixed route-owned metadata after session/CSRF
validation. Request payload, query, credentials, tokens, and secret-like values never
become audit targets or diagnostic data; inability to persist the required audit fails
closed.

All interactive authentication requires `ADMIN_ALLOWED_ORIGINS`. A fresh OIDC installation may set the paired
deployment-only `ADMIN_BOOTSTRAP_OIDC_SUBJECT` and
`ADMIN_BOOTSTRAP_DISPLAY_NAME` values to create the first workspace administrator
mapping atomically. They are never an HTTP API, browser value, or diagnostic output.

For PBI-013 process composition, `createApiRuntimeFromEnvironment` builds the ordinary
API lifecycle without binding its port. `startApi` retains the executable behavior by
starting that runtime. A standalone host passes `startTelemetry: false` so it can own a
single process-wide OpenTelemetry lifecycle; API resources still close with the Fastify
application and no policy or transport behavior is duplicated.

## PBI-021 trusted AI catalog and secret lifecycle

`infrastructure/ai-catalog` is a deployment-owned LiteLLM GitHub source composed here.
The browser can request a refresh but cannot select an upstream URL, commit, raw bytes,
or credential. The adapter resolves a commit, downloads bounded HTTPS bytes from fixed
hosts, hashes them, and passes them to the existing immutable catalog importer. Set the
optional `AI_CATALOG_LITELLM_COMMIT_SHA` to a 40-character trusted commit when a
deployment requires a fixed source revision.

`POST /v1/admin/ai/provider-instances/:id/models/refresh` asks only the active
provider's registered server-side adapter for a bounded model inventory. Its credential,
endpoint, raw response, and account metadata stay in trusted composition. The resulting
workspace-scoped immutable inventory is tied to the exact active provider version and is
the sole availability source for `GET /v1/admin/ai/binding-options`; a LiteLLM catalog
only enriches exact canonical-name pricing matches. Binding creation repeats the same
inventory check, so a global catalog model cannot be submitted as a bypass. Unknown
prices remain unknown and cannot satisfy a hard budget. The binding-options DTO also
retains the safe provider identity needed to author an explicit override for that same
provider-owned model; it never permits a global catalog model to become executable. The
OpenAI-compatible descriptor
carries an immutable protocol mode, so its provider capability test probes embeddings
for an embeddings instance and generation for a chat/responses instance. Tests remain
confirmation-bound, known-price/budget-gated, rate-limited, and execute only through
`@caseweaver/ai-execution`.

External secret lifecycle is owned by the Access & security registry. Registration,
rotation-required marking, explicit external-rotation reconciliation, and guarded
revocation are transactional with server-owned audits. Reconciliation changes only
opaque metadata after an operator rotates their external value. Revocation is checked
again inside the transaction and is denied when an active current configuration still
depends on the reference; neither a locator nor a secret value reaches a DTO, audit,
log, trace, or error.

Disabling an inert descriptor-backed connector/provider draft is a guarded terminal
discard: the API records an immutable `discarded` lifecycle version, audit event, and
cache invalidation, omits it from normal resource lists, and creates no runtime
projection. It is not a physical deletion and cannot be reactivated. Disabling an
active configuration retains the ordinary immutable `disabled` lifecycle behavior.
