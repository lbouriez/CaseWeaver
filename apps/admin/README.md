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
