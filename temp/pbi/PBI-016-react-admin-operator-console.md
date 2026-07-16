# PBI-016: OAuth React-Admin operator console

## Outcome

Deliver a production-ready React-Admin console and the missing administration API so an
authorized operator can configure and operate CaseWeaver without editing environment
files, calling internal services, or using the CLI.

The console must cover every currently implemented configurable capability, discover
new connector and AI-provider types from the backend, and create a server-side audit
record for every authenticated UI action. The backend remains the authorization,
validation, policy, secret, idempotency, and audit boundary.

PBI-014 MCP and PBI-015 chat remain deferred and are not prerequisites.

## Current delivery state

**Completed.** The frontend slice delivered in commit `3f52bc6` is wired to the
completed administration control plane and production runtime host:

- `apps/admin` provides a Vite/React-Admin console with deployment-time
  `runtime-config.json`, no browser secrets, and a self-hosting-safe static artifact.
- Cookie-session API transport uses typed, allowlisted endpoints, UI action/correlation
  IDs, CSRF/idempotency headers, cancellation, typed errors, and no local mock data.
- The UI includes permission-aware navigation, generic descriptor-driven connector and
  AI-provider draft forms, secret-reference redaction, operational resource views, and
  server-preview-required confirmation for costly/destructive commands.
- `packages/administration`, PostgreSQL descriptor/configuration/version/outbox/session
  persistence, provider-neutral OIDC/PKCE, API-managed cookies/CSRF, dynamic descriptor
  registration, workspace-scoped redacted reads, mandatory server audit paths, and the
  typed `/v1/auth/*` plus `/v1/admin/*` surface are implemented.
- Connector/provider drafts validate through their registered adapter schema. Operators
  register opaque external secret references, select redacted registrations in generic
  descriptor forms, create successor immutable versions, and run server-managed source
  synchronization or metered provider capability checks. Existing PBI-011 through
  PBI-013 retry/cancel/recover/retention/privacy/publication policies are composed rather
  than copied.
- Resource-specific source, schedule, publication profile, webhook endpoint, platform
  link, AI binding/catalog/role/default/pricing/budget, secret-reference, role, diagnostic,
  and immutable-history workflows are available through typed, authorized API routes.
  The static UI exposes each managed capability or a server-provided read-only reason.
- The public webhook ingress now resolves only an active persisted opaque endpoint,
  applies its exact immutable body/rate policy before verification, and gives a trusted
  adapter resolver only server-selected identities.
- Focused unit, contract, API, PostgreSQL integration, component, and Chromium E2E tests
  cover the authorization, audit, redaction, idempotency, concurrency, versioning, and
  no-browser-token boundaries. The E2E journey ran through the Docker static bridge with
  deployment-injected runtime configuration.

## Acceptance evidence

- `packages/administration` provides provider-neutral contracts/use cases; PostgreSQL
  persistence supplies immutable configuration/version history, descriptor reads,
  optimistic concurrency, cache invalidation, and transactional audit/outbox behavior.
- The API exposes typed, authorized, workspace-scoped `/v1/auth/*` and `/v1/admin/*`
  routes. OIDC Authorization Code + PKCE uses API-managed HttpOnly sessions, validated
  state/nonce/issuer/audience/signature/time claims, CSRF, trusted origin/proxy policy,
  identity mapping, workspace selection, and login/logout/session audit records.
- Connector and AI-provider configuration is descriptor-driven. Secret values are
  write-only; only opaque secret-reference metadata is returned, persisted in audit
  events, or made available to the browser.
- Administration commands delegate to the PBI-011, PBI-012, and PBI-013 use cases.
  They preserve server-side authorization, workspace isolation, idempotency, immutable
  references, guarded server previews, and fail-closed audit behavior for sensitive
  reads and downloads.
- Focused administration, API, PostgreSQL, Admin component, contract, and Chromium
  browser tests pass. The Compose browser journey logs in using the API cookie session,
  proves browser storage has no token/session data, creates a descriptor-neutral
  retrieval-profile draft, reads its server audit event, and logs out through the
  built static Admin artifact.

## Remaining work

None for PBI-016. PBI-017 continues separately with production TLS, backup/restore,
vulnerability scanning, and provenance/attestation verification.

## Existing implementation references

Review these sources before implementation:

- `C:\GIT\ReKindle\App\admin`
  - React-Admin shell, resources, custom routes, API client, and Auth0/OAuth integration.
- `C:\GIT\ReKindle\App\backend`
  - OAuth token validation, administrator resolution, AI configuration APIs, and audit
    list behavior.

Reuse concepts, not credentials, branding, DTOs, or provider assumptions.

Useful Rekindle patterns:

- Central React-Admin `authProvider`, `dataProvider`, and authenticated API client.
- OAuth redirect followed by a server-side current-user/authorization lookup.
- Separate standard resources from operational custom pages.
- Normalized provider, model, binding, pricing, and audit resources.

Do not copy these Rekindle weaknesses:

- OAuth tokens in `localStorage`.
- Auth0-specific contracts in application code.
- Never-resolving login promises or fragile callback handling.
- Generic URL concatenation and pervasive `any` response types.
- AI configuration mutations that do not create durable audit records.
- Unannounced multi-minute configuration caches.
- Unbounded or unaudited live provider tests.
- Unvalidated trust of forwarding headers.

## Product principles

1. The UI is a client of explicit, typed CaseWeaver administration APIs.
2. Connector, destination, provider, model, and runtime names never become branches in
   shared UI or application orchestration.
3. New registered connector/provider types appear through backend descriptors without a
   frontend release.
4. The backend validates every submitted value with its authoritative runtime schema.
5. Secret values are write-only and handled separately from ordinary configuration.
6. All AI test calls are metered, priced, budgeted, rate-limited, and attributed.
7. Configuration updates are versioned, conflict-safe, auditable, and invalidate any
   affected runtime cache.
8. Reads, commands, exports, denials, authentication events, and configuration changes
   initiated from the console are server-audited.
9. Browser visibility never grants permission. The API enforces workspace scope and
   permissions on every request.
10. The browser never calls PostgreSQL, queues, object storage, connectors, AI
    providers, repository runtimes, or public webhook handlers directly.

## User roles

Use the existing workspace roles and permissions in `packages/security`:

- `administrator`: workspace access, configuration, credentials, roles, and all
  operations.
- `operator`: operational actions and permitted connector/credential management.
- `analyst`: request/read analysis and evidence.
- `viewer`: read-only analysis and evidence.

Add only permissions required to make administration boundaries explicit. Likely
additions include:

- `workspace.manage`
- `identity.manage`
- `configuration.read`
- `credential.readMetadata`
- `webhook.manage`
- `diagnostics.export`

Keep role-to-permission policy in the backend. The UI consumes effective permissions to
hide or disable controls but never implements authorization policy.

## Scope

### 1. OAuth/OIDC authentication and browser sessions

Implement provider-neutral OAuth 2.0/OIDC Authorization Code with PKCE. Auth0, Entra ID,
Keycloak, or another standards-compliant issuer must work through configuration rather
than provider-specific application code.

For private self-hosted and test deployments, also provide deployment-owned password
authentication. It defaults to login `admin` and password `admin`, with both values
overridable in Compose/deployment configuration. Password authentication remains enabled
alongside configured OAuth/OIDC by default; only a deployment-only
`ADMIN_DISABLE_LOGIN_AUTHENTICATION=true` setting paired with complete OIDC configuration
may force OAuth-only access. Password sign-in creates the same bounded server-side,
HttpOnly cookie session and CSRF boundary as OIDC, is audited without credential values,
and is never stored in browser state after a terminal response. Anonymous session status
must advertise enabled sign-in methods without exposing credentials.

Preferred topology:

1. The browser starts login through the CaseWeaver API.
2. The API generates and stores state, nonce, and PKCE verifier.
3. The identity provider redirects to an API callback.
4. The API validates the response and creates a bounded server-side session.
5. The browser receives only a `Secure`, `HttpOnly`, `SameSite` session cookie.
6. The API resolves issuer plus stable subject to a CaseWeaver principal and authorized
   workspace memberships.
7. Logout revokes the local session and uses provider logout when configured.

Do not accept browser-submitted principal IDs, roles, permissions, or workspace IDs as
trusted identity. Workspace selection is allowed only among server-resolved memberships.

Required endpoints:

- `GET /v1/auth/login`
- `POST /v1/auth/login/password`
- `GET /v1/auth/callback`
- `GET /v1/auth/session`
- `POST /v1/auth/logout`
- `POST /v1/auth/session/workspace`

Required controls:

- State, nonce, PKCE, issuer, audience, signature, time, and redirect validation.
- Session expiry, idle timeout, rotation, logout invalidation, and bounded storage.
- CSRF protection for cookie-authenticated mutations.
- Explicit allowed UI origins and trusted-proxy configuration.
- Generic login error responses that do not reveal membership or issuer details.
- Audit events for login start, success, failure, logout, expiry, and workspace change.

OIDC issuer, client ID, client secret reference, audiences, callback URL, scopes, and
trusted origins are deployment bootstrap configuration. The UI may display a redacted
status page but must not live-edit settings that could lock every administrator out.

### 2. Administration API foundation

Create `packages/administration` for provider-neutral administration contracts and use
cases. Add semantic authentication and administration API routes under
`apps/api/src/modules/auth` and `apps/api/src/modules/administration`. Persist
administration resources under `infrastructure/postgres/src/administration`.

Administration APIs must:

- Return resource-specific DTOs; never expose Prisma, domain persistence, Zod internals,
  connector clients, or provider SDK objects.
- Use stable IDs, workspace scoping, cursor pagination, explicit filters, and stable
  sorting.
- Return effective permissions with the authenticated session.
- Use idempotency keys for commands and mutations.
- Use optimistic concurrency through an immutable version or ETag.
- Support create-draft, validate, test where safe, activate, supersede, disable, and
  inspect-history workflows where configuration affects running work.
- Preserve immutable references used by existing jobs and analyses.
- Publish a configuration-change event or explicitly invalidate affected runtime caches
  after commit.
- Return typed errors suitable for React-Admin without leaking sensitive metadata.

React-Admin's `dataProvider` maps these typed APIs to its list/get/create/update/action
contract. The backend API must not be designed around React-Admin-specific query syntax
or `Content-Range` headers.

### 3. Dynamic connector and provider discovery

Add a backend descriptor registry independent from configured instances.

Each connector package registers a descriptor containing:

- Stable connector type and descriptor version.
- Display name, description, documentation URL, and optional icon key.
- Declared capabilities:
  `knowledgeSource`, `caseSource`, `attachmentSource`,
  `analysisDestination`, and `webhookAdapter`.
- Supported webhook event types.
- JSON Schema 2020-12 for instance settings.
- Optional JSON schemas for source filters and capability-specific settings.
- UI schema with grouping, order, widgets, help text, advanced fields, and conditional
  visibility.
- Named secret slots with purpose, required state, accepted reference kinds, and
  rotation support.
- Connectivity-test capability and expected cost/network behavior.
- Configuration schema version and supported migrations.

Each AI provider package registers a descriptor containing:

- Stable provider type and descriptor version.
- Display metadata and supported wire APIs.
- Supported roles/capabilities such as embedding, vision, analysis, repository agent,
  reranking, and chat.
- Provider-instance settings JSON Schema and UI schema.
- Secret slots and endpoint/deployment rules.
- Supported connectivity/capability tests.

Required descriptor endpoints:

- `GET /v1/admin/descriptors/connectors`
- `GET /v1/admin/descriptors/connectors/:connectorType`
- `GET /v1/admin/descriptors/ai-providers`
- `GET /v1/admin/descriptors/ai-providers/:providerType`

Descriptors are safe metadata. They never contain configured secret values, resolved
credentials, runtime clients, or internal stack traces.

The backend remains authoritative: descriptor JSON Schema drives form rendering, while
the registered connector/provider Zod schema validates persisted configuration. A new
package appears in the console when its backend composition registers its descriptor;
the shared frontend must not require a connector/provider-name conditional.

### 4. Secret-reference administration

Support:

- Listing redacted secret-reference metadata and health/rotation state.
- Creating references to an external secret backend without reading the value.
- Optional one-time secret registration into the configured secret backend.
- Rotating, testing resolution, disabling, and revoking a reference.
- Showing which resources depend on a reference before rotation/revocation.

Plaintext credential values:

- May exist only in the one-time HTTPS request used to register/rotate them.
- Must not be stored in application tables, browser storage, URL/query strings,
  diagnostics, audit details, traces, analytics, or error messages.
- Must never be returned by the API.
- Must be cleared from form state immediately after a terminal response.

Every secret action requires `credential.manage`, step-up confirmation, rate limiting,
and an audit record. Audit only reference identity, action, actor, target, and outcome.

### 5. Complete settings inventory

The UI and administration API must manage or explicitly expose as read-only every
implemented surface below.

#### Integrations: connector instances

- Connector type selected from the dynamic descriptor catalog.
- Instance display name, enabled state, workspace, settings, secret references, schema
  version, current configuration version, health status, and last test.
- Validation, non-destructive connectivity test, activation, disablement, history, and
  dependency inspection.

Initial Git/Markdown fields include:

- Local or remote repository mode.
- Allowed local roots for local mode.
- Remote URL, branch/tag/ref, browser URL, and optional token secret reference.
- Included paths and content limits.
- Docusaurus enabled state, site/base/route URLs, and documentation paths.

Initial Jitbit fields include:

- HTTPS base URL and API-token secret reference.
- Timeout, discovery page size, ticket limit.
- Initial update boundary and conservative overlap duration.

#### Integrations: knowledge sources and schedules

- Enabled state, connector instance, collection, normalization profile, chunking
  profile, and connector-owned filters.
- Manual, cron, interval, and webhook trigger configuration.
- Timezone, jitter, overlap policy, next run, and last occurrence.
- Cursor state and full-rescan controls.
- Deletion, tombstone, and retention policy.
- Last discovery/load/embedding result and smart no-op reason.
- Manual synchronize and bounded full-rescan commands.

#### Integrations: destinations and publication

- Destination connector instances filtered by `analysisDestination` capability.
- Publication profile versions, renderer, AI disclosure, disclaimer, preview,
  approval, auto-internal policy, and output-size limit.
- Activation/history and safe test/preview.
- Publication intents, attempts, receipts, reconciliation status, approval/rejection,
  and retry when eligible.

#### Integrations: webhooks

- Opaque endpoint ID, enabled state, connector instance filtered by `webhookAdapter`,
  verified event types, rate/body limits, secret reference, and last delivery status.
- Generated public URL using the configured webhook public base URL.
- Verification-secret rotation, disablement, delivery history, and replay of verified
  inbox entries.
- Never allow request body or headers to choose workspace, connector, adapter, or
  secret.

#### AI configuration

- Dynamic provider types and configured provider instances.
- Endpoint/deployment, wire API, parameters, capability metadata, and secret reference.
- Imported LiteLLM catalog snapshots, source revision/hash, import status, and models.
- Immutable model binding versions for embedding, vision, analysis, repository agent,
  optional reranker, keyword extraction, and future chat.
- Workspace role defaults and explicit fallback policy.
- Installation, workspace, and binding-level pricing overrides with effective dates.
- Hard/soft budget policies, amount, currency, period, scope, warnings, and bypass
  policy.
- Estimated/provider-reported cost and unknown-price state.
- Metered capability tests with confirmation, conservative cost estimate, hard budget
  reservation, rate limit, timeout, and audit attribution.

Changing any effective binding field creates a new version. Existing operations retain
their original binding reference. Unknown price is never displayed or treated as zero.

#### Analysis, prompts, and retrieval

- Analysis profile versions and active analysis binding.
- Retrieval profile, prompt profile, evidence limits, prompt/token budgets, required and
  optional stages, and repository-agent policy.
- Prompt template versions, variables, rendered-size limits, and activation history.
- Knowledge collections and indexed embedding spaces.
- Retrieval profile collection, embedding binding/profile/dimension, lexical/vector
  fusion, quotas, query budget, optional reranker binding, and reranker budget.
- Read-only retrieval snapshots and evidence references used by completed analyses.

Profiles used by immutable jobs may be superseded but not rewritten or deleted.

#### Attachments and repository runtime

- Attachment processing policy versions, MIME/size/archive limits, derivative retention,
  vision binding, prompt/version identity, and cache state.
- Read-only derivative/failure inspection without exposing protected content by default.
- Repository-agent runtime profile, pinned repository source, allowed operations,
  turns/tool/token/duration limits, networkless state, and binding.
- Explicit warning and permission checks before protected evidence or attachment
  content is displayed.

If a setting is currently a composition constant rather than persisted configuration,
PBI-016 must either make it a versioned administration resource or expose it as clearly
read-only runtime capability. It must not silently omit it.

#### Operations and governance

- Dashboard: health, queue depth, active/failed work, due/failed synchronizations,
  publication state, budget warnings, and recent audit/security signals.
- Analyses: requests, state, immutable snapshots/results, force rerun, and cancellation.
- Jobs/attempts/dead letters: inspect, retry, cancel, fenced recovery, and failure detail.
- Costs: filter by time, analysis, connector, source, provider, model role, and operation;
  display priced, unknown-price, reserved, estimated, and provider-reported values.
- Retention: policy/status, queue bounded reap, history, and failures.
- Privacy: case-snapshot purge request, reason, progress, tombstone, and history.
- Diagnostics: redacted export generation, expiry, and download.
- Audit: actor, workspace, action, target, outcome, reason code, before/after hash,
  request/action/correlation/trace IDs, source IP after trusted-proxy resolution, user
  agent, and timestamp.

#### Access and workspace

- Current principal and effective permissions.
- Authorized workspace selection.
- Workspace details.
- Principals and external OIDC identity mappings.
- Workspace role assignments and role/permission matrix.
- Invite/link/disable workflows if supported by the selected identity policy.

Role changes require administrator permission, optimistic concurrency, protection
against accidental removal of the final administrator, and complete auditing.

#### Platform

- API public base URL used by external clients and generated links.
- Webhook public base URL used to display endpoint URLs.
- Allowed UI origins and trusted-proxy status.
- Runtime profile, service versions, database/queue/object-storage readiness, and
  telemetry status as redacted read-only information.
- Redacted OIDC issuer/client/audience/callback status.

Persist public URLs as versioned workspace/installation platform configuration. Require
absolute HTTPS URLs except explicit localhost development mode. Changing a public URL
must not change existing opaque webhook endpoint IDs.

The admin SPA API base URL is deployment-injected and runtime-validated. It is not
silently inferred from untrusted request headers.

## Navigation and pages

Use this primary navigation:

1. **Overview**
   - Operational dashboard, alerts, recent failures, budget state, and quick actions.
2. **Integrations**
   - Connector catalog, connector instances, knowledge sources, schedules,
     destinations/publication profiles, and webhooks.
3. **AI**
   - Provider catalog, provider instances, model catalog, model bindings, role defaults,
     pricing overrides, budgets, and metered tests.
4. **Knowledge & Analysis**
   - Collections, synchronization history, retrieval profiles, prompt profiles,
     analysis profiles, analyses, and evidence snapshots.
5. **Publication**
   - Profiles, intents, approvals, attempts, receipts, and reconciliation.
6. **Operations**
   - Jobs, dead letters, costs, retention, privacy, diagnostics, and audit.
7. **Access**
   - Workspaces, principals, identity mappings, roles, and permissions.
8. **Platform**
   - Public URLs, authentication status, runtime capabilities, health, and telemetry.

Pages must provide accessible loading, empty, validation, conflict, denied, unavailable,
and terminal failure states. Destructive or costly actions require explicit confirmation
with a server-provided impact/cost preview when applicable.

## Audit contract

Extend the audit model to represent:

- Workspace and optional actor principal/OIDC subject.
- Origin (`admin_ui`, `api`, `cli`, `scheduler`, `webhook`, or worker).
- Stable action code defined by the server route/use case.
- Target type and ID.
- Outcome (`attempted`, `succeeded`, `failed`, `denied`, or `cancelled`).
- Reason/error code without sensitive payload.
- Before/after canonical hashes for configuration mutations.
- UI action ID, API request ID, idempotency key digest, correlation ID, and trace ID.
- Trusted client address and user agent where policy allows.
- Timestamp and optional parent audit event.

Rules:

- Every authenticated admin endpoint declares its server-owned action code.
- Every UI-initiated read, search, navigation data load, command, configuration change,
  test, export, download, workspace switch, login, and logout produces an audit event.
- The UI may send a random UI action ID to correlate requests, but it cannot choose the
  authoritative action code, actor, workspace, target, permission, or outcome.
- Mutations and their successful audit event commit atomically. If the audit write
  fails, the mutation fails.
- Denials and validation failures are audited without persisting submitted secrets or
  sensitive payloads.
- Sensitive reads and downloads fail closed if their audit event cannot be persisted.
- Automatic polling is marked distinctly from a user gesture and must be bounded to
  prevent audit-volume and cost abuse.
- Audit records are append-only, queryable only with `audit.read`, retained by policy,
  and included in privacy rules without erasing security-significant facts.

## API resource outline

The final route design may group subresources, but must provide typed equivalents for:

- `/v1/admin/descriptors/*`
- `/v1/admin/secret-references`
- `/v1/admin/connector-instances`
- `/v1/admin/knowledge-sources`
- `/v1/admin/schedules`
- `/v1/admin/publication-profiles`
- `/v1/admin/webhook-endpoints`
- `/v1/admin/ai/provider-instances`
- `/v1/admin/ai/catalog-snapshots`
- `/v1/admin/ai/models`
- `/v1/admin/ai/bindings`
- `/v1/admin/ai/role-defaults`
- `/v1/admin/ai/pricing-overrides`
- `/v1/admin/ai/budgets`
- `/v1/admin/collections`
- `/v1/admin/retrieval-profiles`
- `/v1/admin/prompt-profiles`
- `/v1/admin/analysis-profiles`
- `/v1/admin/analyses`
- `/v1/admin/publications`
- `/v1/admin/operations/jobs`
- `/v1/admin/operations/dead-letters`
- `/v1/admin/costs`
- `/v1/admin/retention`
- `/v1/admin/privacy`
- `/v1/admin/diagnostics`
- `/v1/admin/audit-events`
- `/v1/admin/workspaces`
- `/v1/admin/principals`
- `/v1/admin/role-assignments`
- `/v1/admin/platform`

Existing PBI-012/PBI-013 command use cases should be composed behind these resources
rather than reimplemented.

## Frontend architecture

Create `apps/admin` using Vite, strict TypeScript, React, React-Admin, and the repository's
existing quality/test conventions.

Required modules:

- Runtime environment validation and one shared API client.
- OIDC/session-aware React-Admin `authProvider`.
- Typed resource/action clients and a narrow React-Admin `dataProvider` adapter.
- Permission-aware navigation and route guards.
- Generic descriptor-driven configuration form renderer.
- Resource-specific pages for workflows that cannot be represented safely as CRUD.
- Error mapping with correlation IDs and no sensitive details.
- Accessible confirmation, conflict resolution, and immutable-version history UI.
- No business policy, price calculation, authorization decision, or destination
  rendering in the browser.

Do not use `any` for API DTOs. Generate or share transport types from
`packages/administration` without importing backend implementations.

## Delivery modules and workflow

Follow `START_CODING_PROMPT.md` for each module.

### Module A: administration contracts and persistence

Architect:

- Finalize resource boundaries, immutable/versioned entities, descriptors, pagination,
  optimistic concurrency, and transaction/audit behavior.

Senior Developer:

- Implement `packages/administration`, PostgreSQL migrations/repositories, descriptor
  contracts, configuration version stores, audit extension, and focused unit tests.

Automation Developer:

- Validate workspace isolation, concurrent updates, immutable history, descriptor safety,
  audit atomicity, and migration behavior.

### Module B: OAuth, sessions, and authorization

Architect:

- Define generic OIDC configuration, PKCE/session lifecycle, identity mapping, CSRF,
  trusted origins/proxies, workspace selection, and failure behavior.

Senior Developer:

- Implement auth/session ports, API routes/middleware, PostgreSQL session/identity
  adapters, and permission resolution.

Automation Developer:

- Validate state/nonce/PKCE, session fixation/expiry/logout, CSRF, cross-workspace access,
  denied-action auditing, and final-administrator protection.

### Module C: dynamic catalogs and configuration APIs

Architect:

- Define descriptor registration and schema/UI-schema boundaries. Map every current
  connector/provider/configuration resource to typed commands and DTOs.

Senior Developer:

- Register Git, Jitbit, OpenAI-compatible, and Copilot-agent descriptors. Implement
  connector, source, schedule, destination, webhook, AI, profile, secret-reference, and
  platform administration APIs.

Automation Developer:

- Add contract tests proving a synthetic connector/provider appears without shared UI/API
  conditionals, secret values never appear, and effective changes invalidate caches.

### Module D: operations and governance read models

Architect:

- Define bounded read models and commands for analyses, publication, jobs, cost,
  retention, privacy, diagnostics, audit, and dashboard summaries.

Senior Developer:

- Compose existing PBI-011 through PBI-013 use cases, add missing inspection/query APIs,
  and implement redacted exports.

Automation Developer:

- Validate command idempotency, permission boundaries, audit completeness, redaction,
  pagination, cost attribution, and outcome-unknown workflows.

### Module E: React-Admin shell and configuration UI

Architect:

- Define routing, resources, typed client boundaries, permission UX, descriptor form
  rendering, accessibility, and state/error conventions.

Senior Developer:

- Implement the OAuth shell, providers, navigation, dashboard, integrations, AI,
  knowledge/analysis, publication, access, platform, and configuration-history pages.

Automation Developer:

- Add focused component/client tests for descriptor rendering, permission states,
  authentication lifecycle, secret handling, validation/conflict errors, and costly
  action confirmation.

### Module F: operational UI and end-to-end integration

Architect:

- Define critical operator journeys and production serving/deployment behavior.

Senior Developer:

- Implement operations/governance pages, production static serving or reverse-proxy
  configuration, runtime API URL injection, and final composition.

Automation Developer:

- Add minimal E2E tests for login, workspace isolation, dynamic connector setup, source
  scheduling, AI binding/budget setup, analysis trigger, publication approval, job
  recovery, audit inspection, and logout.

Modules A and B may proceed in parallel after the parent approves their shared identity
and audit contracts. Modules C and D may proceed in parallel after A/B integration.
Module E may start against approved generated contracts and fixtures. Module F integrates
only after the relevant backend and frontend modules are complete.

The parent owns shared registries, API/bootstrap composition, migration ordering,
permissions, generated contracts, root manifests, and final validation.

## Acceptance criteria

1. A standards-compliant OIDC provider authenticates the console without Auth0-specific
   application code or browser-persisted access/refresh tokens.
2. The API derives principal, memberships, role, permissions, and active workspace from
   validated server-side identity/session state.
3. An administrator can manage every configuration surface listed in this PBI or see an
   explicit read-only reason when a value is deployment-owned.
4. Git/Markdown and Jitbit configuration forms are rendered from backend descriptors.
5. A synthetic connector and AI provider registered only in backend composition appear
   in the catalog and can render valid forms without editing shared frontend code.
6. Source and destination selectors show only configured instances with the required
   declared capability.
7. The public API URL and webhook public URL can be configured safely, and displayed
   webhook URLs preserve opaque endpoint IDs.
8. Model providers, immutable bindings, roles, LiteLLM catalog, pricing overrides, and
   budgets are manageable without hard-coded provider/model assumptions.
9. A provider capability test cannot bypass metering, known-price policy, budget
   reservation, timeout, rate limit, or auditing.
10. Changed source/profile/binding configuration creates a new version and never changes
    the meaning of an existing analysis, retrieval snapshot, or publication.
11. Secret values never appear in API responses, browser storage, URLs, logs, traces,
    diagnostics, audit records, or returned errors.
12. Every authenticated UI action creates a durable server-side audit record with
    authoritative actor, workspace, action, target, outcome, and correlation metadata.
13. Successful mutations and their audit records are atomic; sensitive reads fail closed
    when auditing is unavailable.
14. Unauthorized cross-workspace/resource access is rejected and audited without leaking
    protected metadata.
15. Existing trigger, approval, retry, cancellation, recovery, retention, privacy, cost,
    and diagnostics behavior is reused rather than duplicated in the frontend.
16. The dashboard and list pages use bounded, paginated APIs and do not execute expensive
    scans or model calls during rendering.
17. The console provides accessible loading, empty, denied, validation, conflict,
    unavailable, and failure states.
18. The frontend build contains no credentials and receives runtime API/OIDC public
    configuration through a validated deployment mechanism.
19. Focused unit, contract, PostgreSQL integration, API integration, frontend component,
    and critical E2E tests pass.
20. Production deployment serves the console with HTTPS, secure cookies, explicit CORS/
    CSRF/trusted-proxy policy, content security policy, and no development fallback.

## Excluded

- End-user support chat.
- MCP server configuration or clients.
- Visual workflow editing.
- Editing the OIDC bootstrap configuration from the same authenticated console.
- Direct database, queue, object-store, connector, provider, or repository-runtime
  access from the browser.
- Replacing CaseWeaver application policies with React-Admin client logic.
