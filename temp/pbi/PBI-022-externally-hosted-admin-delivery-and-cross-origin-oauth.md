# PBI-022: Externally hosted Admin delivery and cross-origin OAuth

## Outcome

Make the existing CaseWeaver control plane deployable in the topology used by a
self-hosted operator: a prebuilt backend image and supporting services in one Portainer
stack, with the static Admin console independently deployed to Cloudflare Pages. The
browser must retain the existing API-managed, HttpOnly cookie session and must never
receive an OAuth access token, refresh token, secret value, or credential locator.

This PBI does not replace the embedded Admin image from PBI-017. It adds a documented,
tested external-hosting alternative. Operators may continue to deploy the Admin and API
on one origin with `SameSite=Lax`, or select the narrowly scoped cross-origin mode for a
trusted Cloudflare Pages origin.

## State and dependencies

**Completed.** Depends on the completed PBI-016 server-managed Admin session and PBI-017
immutable image/Compose delivery. PBI-019 remains an independent, pending documentation
portal publishing governance task; this PBI owns a separate Admin Pages artifact workflow.

## Architecture decisions

- The API remains the OAuth redirect endpoint and session issuer. The browser begins and
  ends authentication through `/v1/auth/*`; it never calls an identity provider directly.
- `ADMIN_ALLOWED_ORIGINS` is an exact, deployment-owned allow-list. CORS remains exact
  origin matching with credentials, no reflection and no wildcard.
- `ADMIN_SESSION_COOKIE_SAME_SITE=lax` remains the default for embedded/same-site Admin
  hosting. `none` is an explicit production-only external-hosting mode and requires a
  secure HTTPS cookie. The cookie remains host-only (`__Host-`), HttpOnly, Path `/`, and
  carries no token payload. CSRF remains required for every state-changing API request.
- The Cloudflare Pages artifact contains only public `runtime-config.json`, with the
  HTTPS API origin and UI title. Build/deploy validation rejects credentials, paths,
  query strings, and non-HTTPS production origins. No backend/DB/AI environment value is
  exposed to Pages.
- The Portainer stack consumes digest-pinned release images, deployment-provided secret
  files, named persistent volumes, and an API-only TLS edge. It has no source checkout or
  Docker build requirement. The static console is deliberately absent from this stack.
- OAuth callback return targets are restricted to `ADMIN_ALLOWED_ORIGINS`; this permits
  the Pages origin only after it has been explicitly trusted. State, nonce, PKCE, issuer,
  audience, signature, and time validation stay server-side.

## Scope

1. Add explicit same-site cookie deployment configuration, validation, documentation,
   unit/API coverage, and an external-origin browser authentication journey.
2. Add deterministic Cloudflare Pages Admin artifact packaging/workflow. It must be
   separate from the PBI-019 documentation workflow, use only public configuration, and
   safely support preview/prod API origin variables.
3. Add a backend-only Portainer Compose stack and API-only edge configuration using the
   existing OCI release targets, databases, migrations, object storage contract, TLS,
   trusted proxy settings, and durable volumes.
4. Extend Playwright/Compose acceptance to prove a console served from a different
   HTTPS origin can complete OIDC, issue/use an HttpOnly `SameSite=None` cookie, perform
   a CSRF-protected Admin mutation, reject untrusted origins, and retain no browser
   token/secret material.
5. Update the operator runbook, deployment README, Admin README, API README, E2E README,
   and root README with a concise Portainer + Cloudflare Pages deployment sequence.

## Explicit non-goals

- No client-side OAuth SDK, local/session-storage authentication state, token forwarding,
  cookie domain widening, CORS wildcard, browser secret injection, or direct provider/DB
  access.
- No change to PBI-019 documentation portal publishing or its repository-governance
  prerequisite.
- No default use of an external Pages domain; embedded same-site Compose remains
  supported and secure by default.
- No live identity-provider, AI-provider, or Cloudflare deployment call in CI/E2E.

## Acceptance criteria

1. A validated production configuration can use `https://<project>.pages.dev` as an
   allowed Admin origin with `SameSite=None; Secure`; invalid/insecure combinations fail
   before startup.
2. A real browser journey through a separate HTTPS Admin origin completes the existing
   Authorization Code + PKCE callback, returns to the configured console, reads session,
   performs one CSRF-protected authorized action, and contains no OAuth or secret data in
   URL, localStorage, sessionStorage, IndexedDB, or cookie values visible to JavaScript.
3. Requests from an unlisted Origin fail, and trusted CORS responses use the exact origin
   plus credentials. Logout clears the matching cookie attributes.
4. A Cloudflare Pages workflow builds the existing Admin unchanged except for a generated
   public runtime config, publishes only a verified artifact, and never receives backend,
   database, secret, connector, or AI credentials.
5. `deploy/docker/compose.portainer.yml` is a source-free, prebuilt-image backend stack
   with PostgreSQL named storage and documented external object storage/secrets/TLS setup.
   Its API-only edge serves API health/auth/admin/webhook routes but never pretends to host
   the Pages console.
6. The stack and Pages artifact configuration pass `docker compose config`, workflow
   static validation, focused unit/API tests, and a deterministic Docker + Chromium
   cross-origin acceptance test.

## Delivery modules and mandatory workflow

1. **External session contract:** Architect defines API config/cookie invariants and
   return/CORS test matrix. Senior Developer implements auth/config only. Automation
   Developer independently verifies config, API, and browser negative paths.
2. **External delivery contract:** Architect defines Pages artifact and Portainer stack
   boundaries. Senior Developer implements only packaging/deployment assets and docs.
   Automation Developer validates compose/workflow/static artifact behaviour.
3. **Integration acceptance:** Parent owns shared API bootstrap, root scripts, image
   wiring, production Compose compatibility, and the final cross-origin Compose/Playwright
   validation.

## Definition of done

PBI-022 is complete only when an operator can follow the documented configuration to
deploy the backend through Portainer and the Admin artifact through Cloudflare Pages,
then complete a tokenless OIDC login and perform an authorized Admin action. All
automated validation must use deterministic local fixtures and the PBI must not weaken
the embedded single-origin path.

## Delivery and remaining work

Delivered:

- Production-only external-origin cookie configuration with exact-origin validation,
  host-only `__Host-` cookie attributes, strict trusted-proxy CIDR validation, and
  hardened OIDC discovery/JWK transport checks.
- A separate, artifact-only Cloudflare Pages Admin workflow and public runtime-config
  generator; protected `main` is the only publication path and no preview trust origin
  is created.
- `compose.portainer.yml`, its public non-secret environment example, and an API-only
  TLS edge for source-free Docker Standalone deployment. Its bootstrap establishes
  `pgvector` without a checkout-relative PostgreSQL init mount.
- Deterministic Docker/Chromium acceptance that validates real Authorization Code +
  PKCE, `SameSite=None` API session use, CSRF-protected mutation/audit behaviour,
  attacker-origin rejection, token/secret non-disclosure, API-only root routing, and
  logout.
- A persistent operator app bar, so workspace and sign-out controls remain available
  while authoring a long form.

Validation completed:

- `pnpm --filter @caseweaver/admin test` — 82 tests.
- Focused API auth/config suite — 46 tests.
- Pages artifact/workflow and Portainer Compose contracts — 8 tests.
- API, Admin, and Standalone type checks; Biome checks and `git diff --check`.
- Clean `pnpm test:e2e:portainer-pages` run: rebuilt all four release targets and
  passed the isolated Playwright browser journey.

Remaining work: **None.** A repository administrator must still configure the documented
Cloudflare Pages variables, protected environment, API DNS/TLS, OIDC client, and
Portainer secret files before this deployment mode is live; those are deployment inputs,
not incomplete product work.

## References

- `AGENTS.md`
- `.features/10-api-mcp-and-future-ui.md`
- `.features/07-attachments-and-security.md`
- `.features/17-analysis-and-prompts-guide.md`
- `.features/22-testing-strategy.md`
- `.features/23-implementation-workflow.md`
- `.features/25-admin-console-guide.md`
- `temp/pbi/PBI-016-react-admin-operator-console.md`
- `temp/pbi/PBI-017-docker-first-self-hosting-and-delivery.md`
