# API application

**PBIs:** 001, 002, 012, 013, 016

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
