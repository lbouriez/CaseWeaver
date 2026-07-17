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

PBI-013 production operations, PBI-016’s operator console, and PBI-020’s repository-
assisted analysis and attachment-intelligence workflow are accepted. The current local
Docker topology runs the real control plane, Admin UI, webhook ingress, scheduler,
durable worker, isolated attachment processor, migrations, and PostgreSQL; it is the
supported way to evaluate the integrated system. PBI-017 release hardening is still in
progress: production TLS, release-profile runtime exercise, backup/restore,
image-vulnerability policy, and provenance/attestation verification are not yet claimed
complete. Detailed contracts in `.features` remain authoritative.

## Quick Docker evaluation

The fastest way to start the complete disposable solution—database, migrations, queue
migration, API, Admin UI, edge, webhook, scheduler, and worker—is:

```powershell
docker compose -f deploy\docker\compose.local.yml up --build --wait
```

Open `http://localhost:8080` and sign in as `admin` / `admin`. These credentials exist
only in the loopback-only development Compose stack; they are not a production default.
The only published port is the edge; PostgreSQL, scheduler, worker, and webhook remain
private inside the Compose network. The command is deliberately disposable:

```powershell
docker compose -f deploy\docker\compose.local.yml down -v
```

It exercises real image builds, PostgreSQL/queue migrations, API readiness, same-origin
cookie sessions, the browser artifact, and all durable process roles. See [the Docker
guide](deploy/docker/README.md) for the difference between the local, test, Admin bridge,
and production Compose files, plus OIDC and digest-pinned image setup.

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
flow. The API itself does not terminate TLS and production TLS remains PBI-017 work.
For a fresh OIDC database, set the initial administrator's stable `sub` claim once; the
API creates the workspace, principal, administrator role, and OIDC mapping atomically.
Remove bootstrap variables after the mapping exists.

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

Do not use the test database credentials or the bootstrap environment variables in a
production deployment. Production Compose and release packaging are owned by PBI-017;
see [deploy/docker/README.md](deploy/docker/README.md) for its current operator
contract.

## License

Apache-2.0 is the planned license because it is permissive and includes an explicit
patent grant. The license file will be added with the repository foundation.
