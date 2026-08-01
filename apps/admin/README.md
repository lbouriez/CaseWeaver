# CaseWeaver operator console

`@caseweaver/admin` is a static React-Admin control room. It presents audited,
permission-aware administration workflows; it is not an authorization, connector, AI,
queue, database, secret, or policy boundary. The browser only calls the CaseWeaver API
with cookie credentials.

## Runtime hosting contract

The built files are deployment-neutral. Before serving them, the container, reverse
proxy, or static-host initialization step **must** place this file at the web root:

```json
{
  "apiBaseUrl": "https://caseweaver.example.com",
  "uiTitle": "CaseWeaver Control Room"
}
```

Use [`public/runtime-config.example.json`](public/runtime-config.example.json) as the
template. It becomes `runtime-config.example.json` in `dist`; deployment must write or
mount `runtime-config.json` alongside it. The console fetches that asset before React
boots, with `no-store` caching. `apiBaseUrl` is an absolute credential-free HTTPS URL,
or `/` when the API is served through the exact same origin as the static console. HTTP
is accepted only for `localhost`, `127.0.0.1`, or `::1` development. The same-origin
value is preferred for a reverse-proxied deployment because it avoids hostname-dependent
CORS/preflight behavior. No API URL, OIDC configuration, credential, or secret is
compiled into the bundle.

For local development, copy the example to `public/runtime-config.json`, substitute a
local API URL, and do not commit that file.

### Cloudflare Pages artifact

For a separately hosted Console, the Pages artifact is generated only after the normal
Vite build. It accepts a public API **origin** (not a URL path) and writes exactly two
deployment-owned files: `runtime-config.json` and Cloudflare's `_headers`. The latter
keeps the runtime configuration out of caches and limits browser `connect-src` to that
API origin. It cannot accept HTTP, credentials, paths, query strings, or fragments.

```powershell
$env:CASEWEAVER_ADMIN_API_BASE_URL = 'https://api.caseweaver.example'
$env:CASEWEAVER_ADMIN_UI_TITLE = 'CaseWeaver Control Room'
pnpm --filter @caseweaver/admin build
node apps/admin/scripts/write-pages-runtime-config.mjs apps/admin/dist
```

The generated API origin is public configuration, not a credential. The API must still
list the exact Pages origin in `ADMIN_ALLOWED_ORIGINS`; an externally hosted Console
also requires the API's explicit `ADMIN_SESSION_COOKIE_SAME_SITE=none` production
configuration. The Console continues to use the API-managed `HttpOnly` session cookie,
CSRF token, and `/v1/auth/*` endpoints. It does not receive an OIDC token, provider
credential, database configuration, or connector/runtime value.

## Live API contract

PBI-016 supplies the following typed API boundary. The console always renders server
responses or an explicit unavailable/denied state; it never substitutes sample records:

- Session control: `GET /v1/auth/session`, `GET /v1/auth/login`,
  `POST /v1/auth/login/password`, `POST /v1/auth/logout`, and
  `POST /v1/auth/session/workspace`. Anonymous session responses advertise
  whether deployment enables password, OAuth, or both methods.
- Descriptors: `GET /v1/admin/descriptors/connectors` and
  `GET /v1/admin/descriptors/ai-providers`. Safe descriptor schema metadata
  controls field help and examples, plus reusable `structured_repository` and
  `git_reference` inputs with an advanced JSON fallback. Structured examples
  are shown in operator language (for example, `Branch: main`), while their
  exact safe representation is applied only after an explicit choice; no
  connector or provider name changes the form logic.
- Connector draft-test routes: `GET
  /v1/admin/connector-descriptors/:type/draft-tests`, followed by an audited
  `POST` preview and confirmed execution under that descriptor/type operation.
  A preview is required before an unpersisted configuration test can run. The
  resulting DTO is bounded status only: no connector response, endpoint,
  secret, or runtime detail reaches the browser.
- Resource-specific, cursor-paginated `GET /v1/admin/*` routes listed in
  `src/api/contracts.ts`, including redacted secret-reference metadata,
  integrations, AI, knowledge, publication, operations, access, and platform
  summaries.
- Draft configuration routes:
  `POST /v1/admin/connector-instances/drafts` and
  `POST /v1/admin/ai/provider-instances/drafts`,
  `POST /v1/admin/knowledge-sources/drafts`, and
  `POST /v1/admin/schedules/drafts`. Source and schedule forms discover
  workspace-scoped selection records from the API; schedule drafts pin a
  specific immutable source-version ID rather than silently following source
  edits. Dedicated source/schedule lifecycle routes accept only a server-read
  optimistic revision and `active`/`disabled` state, so the console never sends
  projection settings back to activate or disable a draft.
- Managed policy-profile draft routes: `POST /v1/admin/retrieval-profiles/drafts`
  and `POST /v1/admin/prompt-profiles/drafts`. The reusable form appears only
  when the configuration-surface registry advertises the corresponding managed
  `create_draft` workflow. It submits a bounded JSON object after rejecting
  credential-shaped keys; it has no secret, connector, provider, model, or
  runtime input.
- Publication and webhook authoring routes:
  `POST /v1/admin/publication-profiles/drafts` and
  `POST /v1/admin/webhook-endpoints/drafts`, with their resource-specific
  lifecycle routes. Publication policy and webhook settings are bounded JSON
  objects; webhook authoring selects only active connector IDs and opaque
  secret-reference *registration IDs*. The console has no secret-value,
  locator, header, body, adapter, or endpoint/client field. It can configure
  only server-validated event types and limits, then reads the server-owned
  optimistic revision for lifecycle transitions.
- Public-link configuration: `GET`/`PUT /v1/admin/platform/links`. The form
  reads and submits only workspace public API/webhook bases and an optional
  server-read revision. URL normalization, permitted localhost development
  mode, OIDC/trusted-proxy posture, and derivation of opaque endpoint URLs
  remain server-owned.
- AI configuration routes create immutable binding drafts/successors, set role defaults,
  replace pricing/budget policies, and issue/run provider capability-test confirmations.
  Every provider, catalog, model, role, and operation is discovered from bounded API
  read models; the browser never supplies an endpoint, wire API, secret, or price/budget
  decision for a test.
- After a provider is activated, `POST /v1/admin/ai/provider-instances/:id/models/refresh`
  obtains its model inventory server-side. The console displays only that safe,
  workspace-scoped projection in binding selectors; it does not call a provider or
  receive an endpoint, credential, raw response, or account model metadata.
- External-secret metadata registration: `POST /v1/admin/secret-references`.
  The console submits an opaque secret-backend locator once, receives only its
  generated registration ID, and uses that ID in generic descriptor selectors.
  It never renders, stores, or requests a secret value.
- Guarded action routes: `POST /v1/admin/action-previews` and
  `POST /v1/admin/actions/execute`, including immutable connector/provider
  activation and disablement, secret-reference lifecycle changes, and existing
  operational recovery use cases.
- Workspace membership: `GET /v1/admin/role-assignments/:principalId/assignment`
  and `PUT /v1/admin/role-assignments/:principalId`. The UI reads the
  workspace-wide optimistic revision before replacing a code-owned role set;
  actor, workspace, authorization, final-administrator protection, immutable
  history, and success audit all remain server-owned.
- Diagnostics export: `POST /v1/admin/diagnostics/exports`, status, and the dedicated
  audited download route. The UI never polls automatically, retains export bytes, or
  constructs storage links; it shows a download control only for a worker-ready export.

Responses must match the Zod-validated local boundary DTOs. Authenticated responses
provide effective permissions and a CSRF token; all mutations require that token and
the API remains responsible for authorization, idempotency, impact/cost calculation,
audit writes, and outcome reconciliation.

## Security and UX boundaries

- OAuth/OIDC and deployment-owned password login are API-managed. Tokens and
  passwords are never persisted or inspected by this app beyond one sign-in request.
- Requests include cookies, UI action/correlation IDs, idempotency headers for
  mutations, and an explicit passive-polling marker when used.
- Descriptor forms are schema-driven without connector/provider name conditionals.
  Secret slots are generic selectors of redacted, active server registrations;
  they are never credential inputs or returned values.
- Collections are authored in the Knowledge & Analysis collections workflow;
  integration-source drafts can only select an existing workspace-scoped
  collection. Collection creation selects an active embedding-role binding, then
  asks the operator for that deployment's documented immutable compatibility
  profile and vector dimensions; the console intentionally does not assume a
  provider, model, or dimension.
- **Access & security** is the canonical home for external secret-reference
  registration and lifecycle. The registry shows only a generated ID, lifecycle,
  timestamps, and active-configuration dependency count. **Mark rotation required**
  does not change a secret; after rotating it in the external backend the operator uses
  **Confirm rotation**. **Revoke** is previewed and blocked when active configuration
  still depends on the reference. Descriptor forms only select a redacted registration
  and link to this registry.
- The AI configuration screen treats provider inventory and pricing as separate facts.
  After activation, **Refresh models available from provider** performs the server-owned
  inventory lookup. Binding selectors then filter only that immutable inventory; a
  manual model identity is never accepted. **Refresh trusted model catalog** is optional
  pricing/capability enrichment and never makes a model available. Exact canonical-name
  price matches are copied into the provider inventory; unknown pricing remains unknown.
  An explicit pricing override likewise selects from that provider inventory rather than
  from a paginated global catalog, so it can price an otherwise unknown provider model
  without making any unrelated catalog model executable. The form requires all usage
  components for the selected CaseWeaver role: input tokens for embeddings/reranking,
  input plus output tokens for generated responses, and image units for vision. This
  prevents an apparently configured hard-budget test from failing later due to a missing
  price component.
  The budget editor exposes only the current active version as a replacement candidate;
  superseded versions remain visible in the general resource history but cannot
  accidentally be used as an optimistic-concurrency base.
  The OpenAI-compatible form requires an explicit embeddings/chat/responses mode, and
  its metered capability test uses the matching probe after an active compatible binding,
  known price, and hard budget are configured.
- Saving an AI provider creates an inert, server-validated configuration. The same
  panel immediately offers a separate server-reviewed **Review and activate provider**
  action; only then does its safe identity appear in binding selectors. This makes the
  lifecycle explicit without allowing the browser to call a provider or infer
  readiness from a draft.
- An inactive connector/provider draft can be removed from normal operator lists through
  the guarded **Remove draft** action. This is a terminal discard, not physical deletion:
  its immutable version and append-only audit history remain preserved, it is excluded
  from selectors and normal lists, and it cannot be reactivated.
- Small circular information controls expose descriptor-owned help and safe
  examples without hiding input meaning. The same reusable control explains
  non-routine authoring decisions—policy JSON, AI token/cost/budget limits,
  source and schedule behavior, webhook ingress limits, public bases, and
  workspace roles—without adding another client-side policy boundary. The
  external-secret reference form explains the bundled `env:UPPERCASE_NAME`
  resolver and examples such as `env:GITHUB_TOKEN`; it never offers a
  secret-value input.
- Repository-assisted case analysis: `GET /v1/admin/repository-analysis/options`,
  draft/revision/lifecycle commands under `/v1/admin/repository-analysis/*`, and
  the guarded repository draft-test preview/execution routes. The **Repository
  analysis** navigation area creates code-repository and execution-policy
  versions; **Knowledge & Analysis** creates attachment policies and analysis
  recipes; **Integrations** creates pinned case triggers and intake schedules.
  All selects come from safe, workspace-scoped option DTOs. A remote HTTPS URL
  is transient authoring input and is cleared after submission; paths, remote
  URLs, refs, locators, credentials, prompt content, evidence, and provider
  responses are never rendered by this console. Attachment policy authoring
  receives only active `vision` bindings, never an analysis binding.
- Workspace selection is derived from the API session's memberships and sent through
  the CSRF-protected session-switch endpoint. The browser cannot submit a role,
  permission, or arbitrary workspace grant.
- Costly or destructive actions cannot be enabled until the server provides an
  expiring impact/cost preview. `outcome_unknown` is displayed as unresolved.
- The console intentionally provides read-only lists/shows for operational resources;
  it does not invent generic CRUD for workflows whose API contract is absent.

## Commands

```powershell
pnpm --filter @caseweaver/admin dev
pnpm --filter @caseweaver/admin typecheck
pnpm --filter @caseweaver/admin test
pnpm --filter @caseweaver/admin build
```

The API owns OIDC validation, password verification, cookie sessions, CSRF, effective
permissions, workspace scope, idempotency, server-side audit records, and all secret
handling. Configure one trusted UI origin before starting the API. Password login is
enabled by default for local self-hosting; OAuth is added when OIDC configuration is
present and `ADMIN_DISABLE_LOGIN_AUTHENTICATION=true` makes OAuth the sole sign-in
method.
