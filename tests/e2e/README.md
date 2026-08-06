# End-to-end tests

**PBIs:** 013, 016, 017, 021, 022

Docker-based workflows from source synchronization through analysis and destination
publication, plus webhook, scheduler, failure recovery, and security-boundary scenarios.

`admin-auth-browser.spec.ts` builds and serves the static admin console and composes it
with a live Fastify `/v1/auth/*` route surface in deterministic Chromium. Its test-only
OIDC/persistence/audit fixture composes the real API route tree and session service; it
neither enables a production fake-auth mode nor calls a real identity provider. It
verifies browser cookie handling, callback return to the trusted console origin,
CSRF-protected workspace rotation, logout, and server-owned audit actions.

## Portainer backend and separately hosted Admin acceptance

`portainer-pages.spec.ts` and `run-portainer-pages-e2e.mjs` validate the external
hosting contract without reaching Cloudflare or a real identity provider:

```powershell
pnpm test:e2e:portainer-pages
```

The runner builds the release `migration`, `attachment-processor`, `standalone`, and
static `admin` images, layers a private HTTPS OIDC fixture and Pages-like static host
over `compose.portainer.yml`, and creates a unique named PostgreSQL volume plus secret
files. Chromium proves an API-only backend root returns `404`, completes Authorization
Code + PKCE through the API, receives an HttpOnly `Secure; SameSite=None` host-only
cookie, performs an audited Admin mutation, rejects an attacker Pages origin, and signs
out without storing a token or secret in browser-visible state. Every fixture key,
certificate, database, and volume is generated for the run and removed afterwards.

Set `CASEWEAVER_E2E_KEEP_STACK=true` only to diagnose a failure. While iterating on
Compose wiring after images were just built, `CASEWEAVER_E2E_SKIP_IMAGE_BUILD=true`
avoids rebuilding them; full acceptance must run without that override.

`admin-compose.spec.ts` is the complementary real-deployment journey. After
`compose.local.yml` is healthy, set `CASEWEAVER_E2E_COMPOSE_ORIGIN` to its loopback
edge (normally `http://localhost:8080`). Use the `127.0.0.1` form below to verify that
the same-origin runtime configuration does not depend on a particular loopback hostname:

```powershell
$env:CASEWEAVER_E2E_COMPOSE_ORIGIN = "http://127.0.0.1:8080"
pnpm exec playwright test tests/e2e/admin-compose.spec.ts
```

It signs in with the disposable development account, creates an immutable retrieval
profile through the real cookie/CSRF API, refreshes the deployment-trusted LiteLLM
pricing catalog through the real cookie/CSRF API without placing upstream bytes or a
source URL in browser storage, verifies the current Git descriptor's human-language reference
guidance in the built console, observes its server-side audit record, and signs out
while asserting that session credentials/tokens never enter browser storage.
The container workflow runs this path after its real Compose smoke. It never runs
against a production environment or sends a secret value.

Set `CASEWEAVER_E2E_ADMIN_ORIGIN` to a running static host to run the same journey
through it. PBI-016 validates `http://127.0.0.1:8082` after building the admin artifact
and starting `deploy/docker/compose.admin.yml`; the test fixture remains the API/OIDC
boundary and the container receives only public runtime configuration.

## Deterministic provider onboarding and knowledge ingestion

`provider-onboarding-compose.spec.ts` is the key fully automatic operator journey for
provider setup and real knowledge synchronization. Run it through its isolated Docker
runner:

```powershell
pnpm test:e2e:compose
```

The runner layers `deploy/docker/compose.e2e.yml` over the normal local topology under
a unique Docker project. It supplies a private HTTPS OpenAI-compatible embedding
fixture, creates its CA at runtime inside a disposable volume, seeds a small Git
repository volume, and starts the real standalone backend, Admin UI, migrations, and
PostgreSQL. Chromium configures the provider and source entirely through the Admin UI.
After the UI queues synchronization, the runner makes a read-only assertion against the
isolated database that an active knowledge document and embedding allocation exist.

The fixture credential is deterministic test data, never a provider credential, and is
not exposed to the browser. No live AI call is permitted in this test. Keep the stack
only for diagnosis with `CASEWEAVER_E2E_KEEP_STACK=true`; the default runner tears down
containers and volumes even after a failing test.

## Opt-in live OpenRouter acceptance

`live-openrouter-knowledge.spec.ts` is deliberately excluded from CI and refuses any
non-loopback origin. It is an operator-authorized acceptance journey for a local Compose
stack that already receives `CASEWEAVER_OPENROUTER_KEY` through its ignored Compose env
file. The test process never receives or reads that key. It first validates a bounded
chat-capability path using the provider's own inventory, explicit input and output price
override, and a small hard budget. Its second journey creates an embeddings provider and queues a local
Git/Markdown knowledge synchronization with OpenRouter's provider-owned embeddings
inventory. Enable that metered journey separately with
`CASEWEAVER_E2E_OPENROUTER_EMBEDDINGS_AVAILABLE=true`; the default test model is an
OpenRouter embedding model, and the test proves it is returned by the filtered provider
inventory. Both journeys register only the opaque
`env:CASEWEAVER_OPENROUTER_KEY` reference and check that browser storage has no key or
session tokens.

Run it only after deliberately authorizing a real provider call and starting the
documented local stack:

```powershell
$env:CASEWEAVER_E2E_COMPOSE_ORIGIN = "http://127.0.0.1:8080"
$env:CASEWEAVER_E2E_LIVE_OPENROUTER = "true"
pnpm exec playwright test tests/e2e/live-openrouter-knowledge.spec.ts
```

To include the metered knowledge-sync path, first configure an embedding-capable model
that the account actually exposes, then opt in explicitly:

```powershell
$env:CASEWEAVER_E2E_OPENROUTER_EMBEDDINGS_AVAILABLE = "true"
$env:CASEWEAVER_E2E_OPENROUTER_EMBEDDING_MODEL = "provider-model-id"
pnpm exec playwright test tests/e2e/live-openrouter-knowledge.spec.ts
```

The default expected embedding model is `openai/text-embedding-3-small`. Override it
with `CASEWEAVER_E2E_OPENROUTER_EMBEDDING_MODEL` only when an operator deliberately
chooses a different embeddings model compatible with the local collection's configured
dimensions.

For the complete metered local acceptance check—including a read-only PostgreSQL
assertion that the selected real Git document completed ingestion and has an embedding
allocation—start the documented local Compose stack with the documentation overlay,
then remove the key from the calling shell (the already-running backend retains it):

```powershell
Remove-Item Env:CASEWEAVER_OPENROUTER_KEY
pnpm test:e2e:openrouter:local
```

The runner only permits a loopback Admin origin, uses a random run identifier, indexes
one real document from the mounted `C:/GIT/Documentation` worktree, and never passes the
provider key to its Playwright child process. A full `Cloud/docs/**/*.md` import is a
separate, intentionally metered operator action.

The default chat capability model is `openai/gpt-4o-mini`; override it with
`CASEWEAVER_E2E_OPENROUTER_CHAT_MODEL` when the configured account does not expose that
model. The test never guesses an identifier from a global price catalog.

## Production Compose delivery acceptance

`production-compose.spec.ts` and `run-production-compose-e2e.mjs` are PBI-017's
deployment-risk test. They are independent of the normal local stack and use
`deploy/docker/compose.production.yml` with the test-only
`compose.production.e2e.yml` overlay:

```powershell
pnpm test:e2e:production
```

The runner builds all eight release targets from the current checkout, verifies every
final image's non-root identity and OCI source metadata, then rebuilds the API and
Admin artifact stages without their build-stage cache and compares the final payload
fingerprints. It creates a unique Compose project, temporary operator environment,
private CA/certificate, signed OIDC issuer, Docker secret files, application-secret
directory, and S3-compatible fixture. It validates only the TLS edge has a public
application port, proves HTTP redirects to HTTPS/HSTS, completes password and OIDC
browser sessions without browser token storage, and checks the runtime database role
cannot create a table. It then writes an object, backs up PostgreSQL plus the object
prefix through the explicit operations profile, deletes the source object, restores into
an isolated project, and verifies the restored object, audit data, and readiness.
Finally it starts a clean distributed profile to exercise API, webhook, scheduler,
worker, attachment processor, and edge health.

Fixtures contain generated test values only. The runner strips test material on cleanup;
set `CASEWEAVER_E2E_KEEP_STACK=true` only to inspect a failing unique project, and
remove it with the project's exact Docker labels afterwards. Set
`CASEWEAVER_E2E_SKIP_IMAGE_BUILD=true` only while iterating on Compose/test wiring when
the eight local `caseweaver-*:production-e2e` images were just built. Full acceptance
and CI always build them first.
