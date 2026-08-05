---
title: Deployment reference
---

# Deployment reference

CaseWeaver ships several Compose files because each one has a distinct trust and
operational boundary. They are not interchangeable installation recipes. This page is
the topology reference; [Configuration reference](./configuration-reference.md) is the
authoritative catalog of variables, and [Self-hosting](./self-hosting.md) is the short
production runbook.

## Choose the right topology

| Compose asset | Intended user and command | Long-running services and state | Public boundary | Do not use it for |
| --- | --- | --- | --- | --- |
| `compose.local.yml` | A developer or evaluator who wants the complete product on one machine. `docker compose -f deploy\docker\compose.local.yml up --build --wait` | PostgreSQL/pgvector, one standalone backend, and the Admin UI. Migration jobs exit after completing. The named PostgreSQL volume survives `down`; `down -v` removes it. | Only the Admin frontend binds loopback port `CASEWEAVER_LOCAL_PORT` (default `8080`). Its proxy forwards API, health, and webhook requests internally. | A public, retained, or production installation. |
| `compose.local.documentation.yml` | An optional overlay for one local Git/Docusaurus knowledge-source evaluation. Add it after `compose.local.yml`. | It adds a read-only host-worktree mount to the existing standalone backend. It does not start another service. | The browser never sees the host path or mount. | A generic repository mount, remote repository credential, or production source. |
| `compose.e2e.yml` | Repository automation only: `pnpm test:e2e:compose`. It is layered over the local Compose file by the test runner. | A short-lived private CA, deterministic OpenAI-compatible fixture, and seeded Git repository, plus the local stack. The runner cleans its unique project and volumes. | A temporary loopback UI, defaulting to `CASEWEAVER_E2E_PORT` (`18080`). | Manual provider validation, a user provider key, or deployment. |
| `compose.test.yml` | Host-run PostgreSQL integration tests. `docker compose -f deploy\docker\compose.test.yml up -d --wait` | PostgreSQL/pgvector only; tests run on the host. `down -v` removes the disposable test volume. | Loopback PostgreSQL at `CASEWEAVER_TEST_DB_PORT` (default `54329`). | Running the API, Admin UI, worker, or a shared database. |
| `compose.admin.yml` | A static Admin bridge for an API that is already running elsewhere. | The Admin image only; it has no database, queue, connector, provider, or application secret. | Loopback Admin port `CASEWEAVER_ADMIN_PORT` (default `8082`). | TLS termination, authentication, a backend, or a self-contained stack. |
| `compose.production.yml` | A small self-hosted production deployment using published image digests. Use `production-operations.mjs`, not ad-hoc profile commands. | Durable PostgreSQL, TLS material/edge, Admin, no-network attachment processor, explicit migration jobs, external S3-compatible objects, and exactly one runtime profile. | Only the TLS edge binds HTTP/HTTPS. PostgreSQL and application networks are private. | Mutable image tags, direct runtime database credentials, or running standalone and distributed profiles together. |
| `compose.portainer.yml` | A Docker Standalone/Portainer backend where the Admin artifact is hosted separately, such as Cloudflare Pages. | Durable PostgreSQL, one standalone backend, no-network attachment processor, explicit migration jobs, and an API-only TLS edge. Objects remain in external S3-compatible storage. | The edge exposes only `/v1/`, `/health/`, and `/webhooks/`; `/` returns `404`. | An embedded Admin UI, distributed profile, source checkout build, or the production helper. |

## Source map

Use this map when an automation agent needs to verify a statement before proposing a
configuration change. The Markdown pages explain the contract; these repository paths
are its implementation sources of truth.

| Concern | Primary source | What is authoritative there |
| --- | --- | --- |
| Local, test, Admin bridge, E2E, production, and Portainer services | `deploy/docker/compose.local.yml`, `compose.test.yml`, `compose.admin.yml`, `compose.e2e.yml`, `compose.production.yml`, `compose.portainer.yml` | Service graph, profiles, mounts, network exposure, and Compose interpolation names. |
| Supported public production/Portainer values | `deploy/docker/.env.production.example`, `deploy/docker/.env.portainer.example` | Operator-facing public keys and required secret-file path shape. |
| Production operations | `deploy/docker/production-operations.mjs` | Validation, migration chain, start, backup, restore, and failure-safe conditions. |
| API cookies, OIDC, origins, and trusted proxy | `apps/api/src/config.ts` | Parsed values, defaults, and cross-field validation. |
| Static Admin runtime artifact | `deploy/docker/admin-runtime-config.sh`, `apps/admin/scripts/write-pages-runtime-config.mjs` | Allowed API origin forms and browser runtime-config output. |
| Worker, attachment, storage, scheduler, and telemetry runtime values | `apps/worker/src/production-bootstrap.ts`, `infrastructure/attachment-runtime/src/attachment-processor-main.ts`, `infrastructure/object-storage/src/config.ts`, `apps/scheduler/src/production-bootstrap.ts`, `packages/observability/src/otel.ts` | Accepted shapes, bounds, and runtime-only inputs. |

## Normal local evaluation: `compose.local.yml`

This is the supported minimum-interaction way to try the product. The standalone
process hosts the API, verified webhook ingress, scheduler, durable worker, and outbox
relay as separate modules in one process. It does **not** replace the PostgreSQL queue
with in-memory dispatch.

```powershell
docker compose -f deploy\docker\compose.local.yml up --build --wait
curl.exe --fail http://localhost:8080/health/live
curl.exe --fail http://localhost:8080/health/ready
```

Open `http://localhost:8080`. The local development credentials and the precise cleanup
command are in [Quick start](./quick-start.md). Use this additional command only when
you intentionally want to erase the local trial database:

```powershell
docker compose -f deploy\docker\compose.local.yml down -v
```

The base file supplies a private trust-authenticated development database and
disposable local object storage. Do not copy those values or its password-login posture
into another environment. The browser connects only to the frontend; it never connects
directly to PostgreSQL, a queue, object storage, a connector, or a provider.

### Optional local documentation worktree overlay

Use the overlay only with the base local file. The directory named by
`CASEWEAVER_DOCUMENTATION_REPOSITORY` must be the root of a local Git worktree (it has
a `.git` entry). Docker mounts it read-only at the fixed backend-only path
`/mnt/caseweaver/repositories/documentation`.

```powershell
$env:CASEWEAVER_DOCUMENTATION_REPOSITORY = '<absolute local Git worktree path>'
docker compose -f deploy\docker\compose.local.yml -f deploy\docker\compose.local.documentation.yml up --build --wait
```

The overlay fixes `CASEWEAVER_GIT_TRUSTED_LOCAL_ROOTS_JSON` to that mounted worktree.
It is deliberately not an Admin setting: an operator cannot widen a server filesystem
trust boundary from the browser. For the actual connector/source workflow, see
[Git and Markdown](./git-markdown.md).

If an optional provider value is needed for this local exercise, make it available only
to the backend through the host environment. In Admin, register and select its opaque
external reference (for example, an `env:` reference); never paste a provider value
into a form or URL. The local documentation overlay is not a credential-management
mechanism.

## Test topologies

### Compose browser acceptance: `compose.e2e.yml`

`pnpm test:e2e:compose` is a deterministic product acceptance journey, not a user setup
path. It combines `compose.local.yml` with this fixture overlay, starts a private TLS
OpenAI-compatible endpoint and one seeded Git repository, and completes provider
onboarding and knowledge ingestion with Playwright. It does not call a live provider,
read an operator credential, or retain containers after success.

For failure diagnosis only, set `CASEWEAVER_E2E_KEEP_STACK=true`. The runner prints the
unique project name so it can be inspected and removed deliberately. Do not layer this
file onto production or a manually running local instance.

### Host integration database: `compose.test.yml`

This file starts only PostgreSQL/pgvector for tests that execute application code on the
host. Its default loopback endpoint is selected by `CASEWEAVER_TEST_DB_PORT`; it is a
test database, not a general local runtime database.

```powershell
docker compose -f deploy\docker\compose.test.yml up -d --wait
pnpm test:integration
docker compose -f deploy\docker\compose.test.yml down -v
```

Never direct ordinary development or production commands to this endpoint without first
proving the database is disposable.

## Admin-only bridge: `compose.admin.yml`

Use this file when an API already exists at a public origin and a local static Admin
container is useful for troubleshooting or a simple external deployment. Set the
public, credential-free API origin before starting it:

```powershell
$env:CASEWEAVER_ADMIN_API_BASE_URL = 'https://api.example.invalid'
docker compose -f deploy\docker\compose.admin.yml up --build --wait
```

The runtime configuration permits `/` for a same-origin proxy, or HTTPS (HTTP is only
allowed for loopback development). It does not add CORS, OIDC, authorization, auditing,
database access, or secrets. The target API must independently allow this UI origin in
`ADMIN_ALLOWED_ORIGINS` and own the server-managed cookie session.

## Self-hosted production: `compose.production.yml`

This topology is designed for published linux/amd64 OCI **digests**, not a repository
checkout. It has two mutually exclusive runtime profiles:

| Profile | Runs | Edge upstreams |
| --- | --- | --- |
| `standalone` | One backend process with API, webhook, scheduler, worker, and relay; plus the attachment sidecar. | `standalone:3000` and `standalone:8081` |
| `distributed` | API, webhook, scheduler, and worker as separate processes; plus the attachment sidecar. | `api:3000` and `webhook:8081` |

The application behavior, queue, leases, and immutable configuration are the same in
both modes. Select exactly one. Changing mode is a controlled backup, stop, migrate,
configure, start procedure; it is not zero-downtime migration.

Prepare an operator-owned public environment file from
`deploy/docker/.env.production.example` and keep every secret in a separate restrictive
file outside the checkout. Then use the helper, which fails before Docker renders when
an image is mutable, a required secret path is missing, the storage/proxy boundary is
invalid, or selected profile upstreams do not match:

```powershell
node deploy\docker\production-operations.mjs validate --env-file <operator-env-file>
node deploy\docker\production-operations.mjs migrate --env-file <operator-env-file> --mode standalone
node deploy\docker\production-operations.mjs start --env-file <operator-env-file> --mode standalone
```

Migration is deliberate and forward-only: the helper starts private PostgreSQL, then
runs Prisma migration, queue migration, and the runtime-role grant in order. Runtime
services use the separate DML-only database role. The following operations have the
same validation gate and leave the runtime stopped while data is changed:

```powershell
node deploy\docker\production-operations.mjs backup --env-file <operator-env-file> --mode standalone --output <backup-file>
node deploy\docker\production-operations.mjs restore --env-file <operator-env-file> --mode standalone --input <backup-file>
```

PostgreSQL is the durable Docker volume. TLS and attachment-processing state use
private tmpfs volumes; durable objects live in the configured external S3-compatible
store and are included in the documented backup/restore boundary. Read
[Self-hosting](./self-hosting.md), [Persistence and recovery](./persistence-recovery.md),
and the [production threat model](https://github.com/lbouriez/CaseWeaver/blob/main/deploy/docker/THREAT_MODEL.md) before exposing
the edge.

## Portainer backend with an externally hosted Admin: `compose.portainer.yml`

The Portainer file is intentionally a different product boundary from
`compose.production.yml`:

| Question | Production Compose | Portainer Compose |
| --- | --- | --- |
| Where is Admin served? | Inside the same-origin TLS edge. | Separately hosted; this file has no Admin service and its root route is `404`. |
| Which runtime profiles exist? | `standalone` or `distributed`. | `standalone` only. |
| How are operations run? | `production-operations.mjs` validates, migrates, starts, backs up, and restores. | Explicit Docker Standalone migration commands; it does not use the helper. |
| How are images built? | Already-published digest-pinned images. | The same: no source checkout build. |

Copy `.env.portainer.example` to an operator-owned absolute location on the Docker
Standalone node. The file contains public configuration and absolute paths to secret
files; it contains no secret contents. Start the one-time migration chain before the
long-running profile:

```powershell
docker compose --env-file <portainer-env-file> -f deploy\docker\compose.portainer.yml --profile migrate up --abort-on-container-exit grant-runtime
docker compose --env-file <portainer-env-file> -f deploy\docker\compose.portainer.yml --profile standalone up -d --wait
```

The externally hosted Admin must have one exact HTTPS origin in
`ADMIN_ALLOWED_ORIGINS`. Set `ADMIN_SESSION_COOKIE_SAME_SITE=none` only for this
cross-origin production model, set the OIDC callback to the public **API** origin ending
in `/v1/auth/callback`, and set `TRUSTED_PROXY_CIDRS` to the fixed application subnet.
The browser still receives only a host-only `HttpOnly` API session cookie, never an
OAuth token. The Pages artifact contract and its repository variables are documented in
[GitHub automation](https://github.com/lbouriez/CaseWeaver/blob/main/.github/README.md#admin-console--verified-cloudflare-pages-artifact).

Portainer preserves the database/S3 recovery boundary but does not implement a second
backup helper. Follow the normal database and object-store recovery procedure; do not
invent profile, UI, or helper commands that this file does not contain.

## Image targets and exposure boundary

The repository Dockerfile publishes eight purpose-specific final targets:
`migration`, `api`, `admin`, `worker`, `scheduler`, `webhook`, `standalone`, and
`attachment-processor`. The attachment processor is a separate no-network Unix-socket
sidecar in every production mode. It is not a general worker and cannot reach the
database, provider, connector, or Docker socket.

Production exposes only its TLS edge. Local evaluation exposes only a loopback
frontend; the Admin-only bridge exposes only a loopback frontend; the test stack exposes
only a loopback database. Treat a direct API or PostgreSQL port as a configuration
defect, not as a troubleshooting shortcut.

## Safe deployment decision sequence

1. Choose a topology from the table; do not combine topologies casually.
2. Use [Configuration reference](./configuration-reference.md) to set only the keys
   consumed by that topology.
3. Keep secret content in the documented secret files or server-only application-secret
   directory. A file *path* is public configuration; its content is not.
4. In production, verify release identity/attestations, run `validate`, then run the
   explicit migration command before `start`.
5. Confirm `/health/live` and `/health/ready` through the intended edge, then use the
   Admin console to configure provider and connector references. A healthy container
   does not validate an integration.

For connector, AI, knowledge, and repository-analysis setup after deployment, start at
the [Operator knowledge map](./operator-knowledge-map.md). It links each operational
task to the server-authoritative Console workflow without duplicating deployment secrets
or policy.
