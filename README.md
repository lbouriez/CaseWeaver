# CaseWeaver

CaseWeaver is an open-source, helpdesk-neutral investigation engine for support cases.
It combines helpdesk conversations, historical resolutions, documentation, attachments,
and source code to produce evidence-backed analyses that can be reviewed or published
through the originating support system.

## Product principles

- Helpdesk systems are adapters. Jitbit is the first reference implementation, not a
  product dependency. Odoo or another case system must be addable without changing the
  core.
- Knowledge sources are independently configured adapter instances. Each source chooses
  its synchronization policy, knowledge collection, chunking profile, and embedding
  binding.
- Destinations are adapter instances selected by a publication profile. Jitbit, Odoo, or
  another destination must be replaceable without changing analysis orchestration.
- AI providers and models are configuration. Embedding, vision, generation, reranking,
  and repository-agent roles may use different providers and models.
- GitHub Copilot SDK is an optional repository-agent implementation. Its BYOK support
  allows OpenAI-compatible endpoints without requiring a Copilot subscription.
- Every AI operation is attributable, budgetable, and auditable.
- Untrusted case content never receives unrestricted access to source code, credentials,
  the host filesystem, or the network.
- The initial product is a reliable investigation engine, not another generic chatbot.

## Planned first release

The first usable release will:

1. Ingest Markdown documentation from a Git repository.
2. Ingest resolved cases from a helpdesk through a connector.
3. Process case images, text files, logs, and safe ZIP archives.
4. Retrieve relevant historical and documentation knowledge.
5. inspect a pinned source-code revision through an isolated read-only agent.
6. Produce a structured analysis with evidence and confidence.
7. Preview or publish that analysis through a destination connector.
8. Persist job state, evidence, model usage, and cost.

Jitbit will validate the connector contracts. It must be removable without changing the
domain, ingestion, retrieval, analysis, or persistence packages.

Unchanged source items are no-op synchronizations. A Markdown file with the same Git
blob/content fingerprint or a resolved API case with the same external revision must not
be normalized, chunked, or embedded again. If an external revision changes but normalized
content does not, CaseWeaver records the observation without generating embeddings.

## Documentation

For the task-oriented operator and contributor guide, use the standalone
[CaseWeaver documentation portal](website/README.md). It covers the supported local
evaluation stack, connector/AI setup boundaries, production self-hosting, recovery,
testing, and the current capability status. The portal builds without an application
runtime or secret.

The `.features` directory is the authoritative implementation specification:

- [Product and scope](.features/01-product-and-scope.md)
- [Domain and workflows](.features/02-domain-and-workflows.md)
- [Architecture](.features/03-architecture.md)
- [Connector contracts](.features/04-connectors.md)
- [AI models and pricing](.features/05-ai-models-and-pricing.md)
- [Knowledge and retrieval](.features/06-knowledge-and-retrieval.md)
- [Attachments and security](.features/07-attachments-and-security.md)
- [Analysis and delivery](.features/08-analysis-and-delivery.md)
- [Data, observability, and cost](.features/09-data-observability-and-cost.md)
- [API, MCP, and future UI](.features/10-api-mcp-and-future-ui.md)
- [Engineering standards](.features/11-engineering-standards.md)
- [Roadmap](.features/12-roadmap.md)
- [GitHub Actions and delivery workflows](.github/README.md)

Implementation-ready backlog items are temporarily maintained under
[`temp/pbi`](temp/pbi/README.md). They can later be imported into GitHub Issues and
removed from the repository.

## Repository structure

The repository is scaffolded as a hexagonal TypeScript monorepo:

- `apps/` contains deployable process entry points.
- `packages/` contains vendor-neutral domain and application modules.
- `connectors/` contains source and destination adapters.
- `providers/` contains AI and agent-runtime adapters.
- `infrastructure/` contains database, queue, storage, and sandbox adapters.
- `deploy/` contains deployment composition.
- `tests/` contains cross-package contract, integration, and end-to-end suites.

Temporary folder READMEs define ownership and PBI mappings for parallel coding agents.
See [`AGENTS.md`](AGENTS.md) before implementing a package.

Implementation agents should also read the detailed guides in `.features/13` through
`.features/23`. [`START_CODING_PROMPT.md`](START_CODING_PROMPT.md) contains the
orchestrator prompt for beginning implementation with independent subagents.

## Status

PBI-013 production operations, PBI-016’s operator console, PBI-017 Docker-first
self-hosting/delivery, and PBI-020’s repository-assisted analysis and attachment-
intelligence workflow are accepted. The supported local Docker topology has three
persistent services: PostgreSQL, the standalone backend, and the Admin frontend. API,
webhook ingress, scheduler, durable worker, and outbox relay remain reusable modules,
but run inside that one backend process. Production uses digest-pinned linux/amd64
images, a single public TLS edge, explicit forward-only migrations, separate migration/
runtime database roles, S3-compatible backup/restore, and release-digest scanning plus
provenance/SBOM attestation verification. Detailed contracts in `.features` remain
authoritative.

## Quick Docker evaluation

The fastest way to start the complete disposable solution is:

```powershell
docker compose -f deploy\docker\compose.local.yml up --build --wait
```

Open `http://localhost:8080` and sign in as `admin` / `admin`. These credentials exist
only in the loopback-only development Compose stack; they are not a production default.
The frontend publishes the only loopback port and proxies same-origin traffic to the
backend. PostgreSQL and the backend's internal API/webhook ports stay private. Two short
migration jobs run before the persistent services start. The command is deliberately
disposable:

```powershell
docker compose -f deploy\docker\compose.local.yml down -v
```

It exercises real image builds, PostgreSQL/queue migrations, API readiness, same-origin
cookie sessions, the browser artifact, and all durable backend modules. See [the Docker
guide](deploy/docker/README.md) for the difference between the local, test, Admin bridge,
and production Compose files, plus OIDC and digest-pinned image setup.

### Five-minute manual smoke test

After the stack reports healthy, validate the normal operator path without an external
provider or a credential:

1. Open `http://localhost:8080`, sign in with `admin` / `admin`, and confirm the
   **Overview** screen appears.
2. Visit **Knowledge & Analysis**, create a retrieval profile named `manual-smoke` with
   `{"policy":"hybrid","maximumResults":8}`, and confirm the success notice. Refresh
   the page: the server-owned draft remains listed.
3. Visit **Access & security**, register the harmless opaque reference
   `env:CASEWEAVER_MANUAL_SMOKE`. Confirm it receives an ID but the locator is not shown
   again after refresh.
4. Click **Sign out**, then reload. The sign-in page must return; browser storage must
   not contain an OAuth token, API key, or secret reference value.
5. In another PowerShell window, verify the backend through the same public edge:

   ```powershell
   curl.exe --fail http://localhost:8080/health/live
   curl.exe --fail http://localhost:8080/health/ready
   ```

Finish the disposable evaluation with `docker compose -f deploy\docker\compose.local.yml down -v`.
Do not use the local `admin` / `admin` credentials outside this loopback-only stack.

## Portainer backend with Cloudflare Pages Admin

For a persistent self-hosted deployment, CaseWeaver can keep the backend in a
source-free Portainer Docker Standalone stack and publish the unchanged static Admin
artifact independently to Cloudflare Pages. The backend stack has a durable PostgreSQL
named volume, uses immutable release-image digests and host-owned secret files, and
exposes only API, health, and webhook routes—never the Admin files. The API remains the
OIDC callback/session owner; the Pages browser holds only its secure HttpOnly session
cookie.

Follow the [Portainer and Cloudflare Pages runbook](deploy/docker/README.md#portainer-backend-with-cloudflare-pages-admin).
It documents the required exact Pages origin, `SameSite=None` session mode, migration
sequence, TLS/secrets, and the dedicated artifact-only GitHub workflow. The local,
same-origin Compose command above remains the quickest evaluation path.

## Automated provider and knowledge E2E test

Run the isolated acceptance journey without an OpenRouter key or a local repository:

```powershell
pnpm test:e2e:compose
```

It layers `compose.e2e.yml` over the local topology under a unique Docker project,
creates disposable PostgreSQL and fixture volumes, starts a private HTTPS
OpenAI-compatible provider with an ephemeral test certificate, and seeds a tiny Git
repository. Chromium then signs in through the Admin UI and performs the whole
operator path: secret-reference registration, provider activation, provider-owned model
discovery, immutable binding/default, explicit price and hard budget, metered provider
test, collection, Git connector test, source activation, and source synchronization.
The runner confirms the resulting active knowledge document and embedding allocation in
the isolated database, then removes the stack and volumes. The fixture credential is
deterministic test data, never an OpenRouter key, and is never sent to the browser.

Set `CASEWEAVER_E2E_KEEP_STACK=true` only while diagnosing a failed run. The separate
OpenRouter instructions below remain the optional live-provider acceptance check.

## OpenRouter and local documentation knowledge test

To run a real, bounded knowledge synchronization against a local Git/Docusaurus
repository, keep the provider key in the host environment and mount the repository
read-only into the standalone backend. `env:CASEWEAVER_OPENROUTER_KEY` is the opaque
CaseWeaver reference entered in Admin; PowerShell's `$env:CASEWEAVER_OPENROUTER_KEY`
is only how the host supplies its value to Compose.

```powershell
$env:CASEWEAVER_DOCUMENTATION_REPOSITORY = "C:/GIT/Documentation"
$env:CASEWEAVER_OPENROUTER_KEY = "<OpenRouter key>"
docker compose -f deploy\docker\compose.local.yml -f deploy\docker\compose.local.documentation.yml up --build --wait
```

Sign in at `http://localhost:8080` and complete this order in the Admin console:

1. **Access & security**: register `env:CASEWEAVER_OPENROUTER_KEY`. This saves only
   an opaque reference ID; refreshing the browser will never display it again.
2. **AI configuration**: create an inactive **OpenAI-compatible** provider with endpoint
   `https://openrouter.ai/api/v1`, select that reference, choose **embeddings**, and
   use **Review and activate provider** after the server shows its impact. Then use
   **Refresh models available from provider**. This server-side request discovers the
   endpoint's actual model inventory; no browser calls OpenRouter. **Refresh trusted
   model catalog** is optional pricing enrichment, not the list of models this endpoint
   is allowed to use.
3. Still in **AI configuration**, create and activate an **embedding** binding from
   the server-filtered provider inventory choices. Use **Filter provider models** to
   narrow the server-provided list (for example, `text-embedding`); it is a filter, not
   a manually entered model identity. An exact LiteLLM match contributes trusted
   pricing; otherwise configure an explicit non-zero price override before setting a
   small hard budget. A capability test is deliberately denied until those guards are
   in place.
4. **Knowledge & Analysis**: create an immutable collection using that binding. The
   bundled PostgreSQL retrieval store supports 1536-dimensional production vectors;
   select an embedding model configured to return 1536 values and use a stable profile
   label such as `embedding-v1`.
5. **Integrations**: create and activate the Git/Markdown connector with local path
   `/mnt/caseweaver/repositories/documentation`, allowed root
   `/mnt/caseweaver/repositories`, and the branch/tag to read. The mounted host
   directory must be the Git worktree root, not the `Cloud` application subfolder. For
   this Docusaurus site, use one exact repository-relative document for the first
   metered smoke test, for example
   `Cloud/docs/AllAnswered/development/pages/automation/automation-test-knowledge-base/autoit.md`.
   The broader `Cloud/docs/**/*.md` and `Cloud/docs/**/*.mdx` patterns select roughly
   1,600 documents in the current worktree and are a deliberate full import, not a
   small test. Create and enable a source that selects the collection and hard
   embedding budget, then use **Synchronize**. Inspect its job, cost, and audit
   records in **Operations**.

The complete Docker instructions, including how to keep the PostgreSQL volume or remove
it, are in [the Docker guide](deploy/docker/README.md). Neither the source mount nor
the OpenRouter key is exposed to the Admin browser.

## Run from source

Prerequisites: Node.js 22.13 or later, Corepack, pnpm 11.12, and Docker Desktop (or a
compatible Docker Engine with Compose). The disposable database is intentionally
separate from production deployment assets.

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm db:test:up
$env:DATABASE_URL = "postgresql://caseweaver:caseweaver@localhost:54329/caseweaver_test"
pnpm --filter @caseweaver/postgres prisma:migrate:deploy
pnpm build
pnpm typecheck
pnpm test
```

Run the API in another PowerShell window. The browser never receives a provider token.
For a development password session, set `ADMIN_ALLOWED_ORIGINS` and use the explicit
development-only `ADMIN_LOGIN` / `ADMIN_PASSWORD` values below. For OIDC, configure a
standards-compliant client and its registered HTTPS callback URL
`https://.../v1/auth/callback`; place a TLS terminator in front of the API for that
flow. The API itself does not terminate TLS; use the PBI-017 production TLS edge rather
than exposing this source-run development process. For a fresh OIDC database, set the
initial administrator's stable `sub` claim once; the API creates the workspace,
principal, administrator role, and OIDC mapping atomically. Remove bootstrap variables
after the mapping exists.

```powershell
$env:NODE_ENV = "development"
$env:HOST = "127.0.0.1"
$env:PORT = "3000"
$env:DATABASE_URL = "postgresql://caseweaver:caseweaver@localhost:54329/caseweaver_test"
$env:API_WORKSPACE_ID = "local-workspace"
$env:API_PRINCIPAL_ID = "local-administrator"
$env:DATABASE_READINESS_TIMEOUT_MS = "5000"
$env:ADMIN_ALLOWED_ORIGINS = "http://127.0.0.1:8082"
$env:ADMIN_LOGIN = "admin"
$env:ADMIN_PASSWORD = "admin"
pnpm --filter @caseweaver/api start
```

To use OIDC instead, set `ADMIN_DISABLE_LOGIN_AUTHENTICATION=true` plus
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CALLBACK_URL`,
`OIDC_EPHEMERAL_ENCRYPTION_KEY`, `OIDC_EPHEMERAL_KEY_ID`,
`ADMIN_BOOTSTRAP_OIDC_SUBJECT`, and `ADMIN_BOOTSTRAP_DISPLAY_NAME` before starting the
API.

Serve the administration SPA in a third window when the API is already running outside
the local Docker stack. Its Docker image contains only static files and a public runtime
API URL; it has no database, queue, provider, connector, object-storage, OIDC secret,
or browser token access:

```powershell
$env:CASEWEAVER_ADMIN_API_BASE_URL = "https://api.example"
$env:CASEWEAVER_ADMIN_UI_TITLE = "CaseWeaver Control Room"
docker compose -f deploy\docker\compose.admin.yml up --build -d --wait
```

Open `http://127.0.0.1:8082`, select the configured identity provider, and use the
server-issued cookie session. HTTPS deployments use the `__Host-caseweaver-session`
cookie with `Secure`, `HttpOnly`, and `SameSite=Lax` attributes. The API uses the
non-prefixed `caseweaver-session` name only in explicit development mode, solely for
non-OIDC local API tests. Stop the local bridge with
`docker compose -f deploy\docker\compose.admin.yml down`.

Stop and remove the disposable test database when finished:

```powershell
pnpm db:test:down
```

Do not use the test database credentials or bootstrap environment variables in a
production deployment. For the supported digest-pinned TLS installation, migration,
backup/restore, OIDC, and release-attestation procedure, see the
[production Docker guide](deploy/docker/README.md) and its
[threat model](deploy/docker/THREAT_MODEL.md).

## License

Apache-2.0 is the planned license because it is permissive and includes an explicit
patent grant. The license file will be added with the repository foundation.
