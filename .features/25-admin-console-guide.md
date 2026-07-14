# Administration API and console implementation guide

## Purpose

Provide a secure, provider-neutral operator experience without turning the browser into
an authorization, configuration, secret, policy, or audit boundary.

## Boundaries

- `apps/admin` contains presentation, navigation, typed API adapters, and accessible user
  interactions.
- `apps/api` owns HTTP transport, authenticated session resolution, request validation,
  and response mapping.
- `packages/administration` owns administration use cases and transport-neutral DTOs.
- Feature packages continue to own their domain rules and immutable configuration
  contracts.
- PostgreSQL adapters own administration persistence, sessions, audit records, and
  configuration history.

The administration package composes existing feature use cases. It must not duplicate
analysis, pricing, budget, publication, scheduling, connector, or retention policy.

## OAuth and identity

Use provider-neutral OAuth 2.0/OIDC Authorization Code with PKCE.

- Validate issuer, audience, signature, state, nonce, PKCE, redirect, and token times.
- Prefer an API-managed bounded session with a secure HttpOnly cookie.
- Resolve stable issuer/subject identities to CaseWeaver principals and workspace roles.
- Never trust a browser-submitted principal, role, permission, or workspace membership.
- Protect cookie-authenticated mutations against CSRF.
- Validate allowed origins and trusted proxies explicitly.
- Audit authentication outcomes and workspace changes without exposing token claims.

OIDC bootstrap settings are deployment-owned. The console may inspect redacted status but
cannot edit settings that could lock every administrator out.

## Dynamic capability descriptors

Registered connector and AI-provider packages expose safe descriptors independently from
configured instances.

A descriptor includes:

- stable type and version,
- display metadata,
- declared capabilities,
- JSON Schema 2020-12 settings schema,
- optional UI schema,
- secret-reference slots,
- configuration migration support,
- supported test operations,
- and safe documentation metadata.

The descriptor never includes secret values, runtime clients, or internal exceptions.
The backend validates saved data with its authoritative runtime schema; JSON Schema is
for discovery and form generation.

Shared UI code must not branch on connector/provider names. Optional specialized widgets
are selected by generic descriptor hints, not vendor checks.

## Configuration lifecycle

Configuration that can affect durable work is versioned:

1. Create or edit a draft.
2. Validate with the authoritative backend schema.
3. Optionally run an explicitly safe, bounded test.
4. Activate a new immutable version.
5. Publish cache invalidation/configuration-change notification after commit.
6. Preserve prior versions for existing jobs and audit history.

Use optimistic concurrency for mutable draft/status records. Never rewrite a profile or
binding referenced by an existing operation.

## Secrets

- Persist secret references, never resolved secret values.
- List only metadata, reference identity, health, and rotation status.
- If one-time secret registration is enabled, plaintext exists only in that HTTPS request
  and the configured secret backend.
- Never return plaintext or include it in browser storage, URLs, logs, traces,
  diagnostics, audit details, or errors.
- Clear credential form state after the request terminates.
- Audit create, rotate, test, disable, and revoke operations by reference identity only.

## Auditing

The server owns action codes, actor resolution, target resolution, permission checks, and
outcomes.

- Audit every authenticated UI read, query, navigation load, command, mutation, test,
  export, download, login/logout, and workspace change.
- A client UI action ID is correlation metadata only.
- Successful state mutation and its audit event commit atomically.
- Sensitive reads and downloads fail closed if their audit event cannot be persisted.
- Audit denials and validation failures without submitted secrets or sensitive payloads.
- Mark bounded background polling separately from user gestures.
- Keep audit records append-only and workspace-scoped.

## API design

- Use resource-specific DTOs and commands.
- Use stable IDs, workspace scope, cursor pagination, stable sorting, and explicit
  filtering.
- Use idempotency keys for commands and optimistic concurrency for updates.
- Return typed public error codes plus request/correlation IDs.
- Do not expose Prisma, provider SDK, connector client, or raw Zod objects.
- Keep the HTTP API independent from React-Admin query conventions; adapt in the
  frontend `dataProvider`.

## React-Admin client

- Use one validated runtime environment module and authenticated API client.
- Keep `authProvider`, typed API clients, and `dataProvider` separate.
- Use effective server permissions for navigation and action visibility.
- Render descriptor-driven forms with accessible validation and help text.
- Use resource-specific pages for costly, destructive, immutable-version, approval, or
  recovery workflows.
- Never calculate authoritative price, authorization, publication output, idempotency,
  or policy in the browser.
- Do not store OAuth tokens or secrets in local storage.

Required UX states include loading, empty, denied, invalid, optimistic-concurrency
conflict, unavailable dependency, outcome unknown, and terminal failure.

## Cost and operational safety

- Display unknown pricing distinctly; never convert it to zero.
- Provider/model tests use the exclusive AI execution gateway.
- Costly tests require a server estimate, confirmation, budget reservation, timeout,
  rate limit, and audit attribution.
- Dashboard and list rendering cannot trigger connector, model, embedding, or repository
  calls.
- Commands return durable operation identities so the UI observes rather than assumes
  completion.

## Minimum tests

- OIDC state/nonce/PKCE/session/CSRF and workspace isolation.
- Audit atomicity, denied-action audit, sensitive-read fail-closed behavior.
- Descriptor redaction and synthetic connector/provider discovery.
- Version history, optimistic concurrency, and cache invalidation.
- Secret request/response/log/diagnostic redaction.
- Permission-aware navigation and actions.
- Generic descriptor form validation.
- Metered provider test confirmation and budget enforcement.
- Critical operator E2E journey from login through audited configuration and operation.
