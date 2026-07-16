# Docker delivery

There is one supported **minimum-interaction evaluation stack**:

```powershell
docker compose -f deploy\docker\compose.local.yml up --build --wait
```

It starts a disposable PostgreSQL/pgvector database, applies Prisma and pg-boss
migrations, then runs the API, Admin UI, edge proxy, webhook ingress, scheduler, and
durable worker. Open `http://localhost:8080` or `http://127.0.0.1:8080`; sign in as
`admin` / `admin`. The local runtime config uses the edge's exact same origin, so both
loopback forms work without a CORS preflight; the disposable API allow-list contains
only those two exact loopback origins. Those credentials exist only because this Compose
file is a loopback-only development/test stack (`NODE_ENV=development`). Stop and remove
its data with:

```powershell
docker compose -f deploy\docker\compose.local.yml down -v
```

The edge is the only published local port. It routes `/v1/` and `/health/` to the API,
`/webhooks/` to webhook ingress, and all other requests to the static Admin UI. Verify
the running stack without exposing database or worker ports:

```powershell
curl.exe --fail http://localhost:8080/health/live
curl.exe --fail http://localhost:8080/health/ready
curl.exe --fail http://localhost:8080/runtime-config.json
```

Use local environment overrides only when you need to test a different development
administrator. Never expose this stack or retain its database/derived key material:

```powershell
$env:ADMIN_LOGIN = "operator"
$env:ADMIN_PASSWORD = "change-this-before-sharing-the-ui"
docker compose -f deploy\docker\compose.local.yml up --build --wait
```

## Why there are several Compose files

| File | One job | What it starts |
| --- | --- | --- |
| `compose.local.yml` | The complete disposable local evaluation stack. | Database, migrations, queue migration, API, Admin, edge, webhook, scheduler, worker. |
| `compose.test.yml` | Dependency-only integration-test database. | PostgreSQL/pgvector at port `54329`; applications run on the host test runner. |
| `compose.admin.yml` | Static UI bridge for an API already hosted elsewhere. | Admin image only; it has no access to a database, queue, secrets, connectors, or providers. |
| `compose.production.yml` | Operator topology using already-published, digest-pinned images. | Database plus either standalone or distributed runtime roles. It intentionally does not provide TLS, backup/restore, or production secret provisioning. |

Only `compose.local.yml` is the simple “start the whole project” command. The other
files are not alternatives to it.

## Images and local topology

`Dockerfile` produces seven non-root final targets:

- `migration`: versioned Prisma migration runner, separate from the API image.
- `api`: cookie-session administration/control-plane API.
- `admin`: static React-Admin console and public runtime-config generator only.
- `worker`: durable queue worker and outbox relay.
- `scheduler`: durable knowledge and analysis schedule producer.
- `webhook`: verified public webhook ingress.
- `standalone`: the same API, worker, scheduler, and webhook semantics in one process.

All runtime images use digest-pinned base images and OCI source/version/revision labels.
The Admin image contains neither Node, database libraries, connector/provider code,
OIDC credentials, nor application secrets.

The local Compose file builds these targets from the checked-out source. It runs real
Prisma migrations followed by the pg-boss queue migration before application roles are
allowed to start. It is therefore suitable for exercising the actual UI/API/worker
boundary, but is not a production deployment.

The API image includes the Git CLI because the Git/Markdown connector's optional
server-side `connector.test` and runtime repository adapter need it. The browser never
executes Git or receives repository credentials; the container check is bounded and
returns only a safe status through the API.

## Published-image production topology

The `v*` release workflow publishes all seven targets to:

```text
${CASEWEAVER_CONTAINER_REGISTRY:-ghcr.io}/${owner}/caseweaver-{target}
```

It builds every final target on pull requests and `main`; a version tag publishes only
after the local Compose smoke completes, then a clean job pulls each release image.
Operators must use an immutable `image@sha256:...` reference in production, never a
mutable release tag.

Pull-request and `main` image checks load a single local Docker image so they can
verify the final process identity. They intentionally do not attach SBOM/provenance
there because Docker's local image exporter cannot load an attested manifest list. The
tag-gated publishing job pushes the release image with both attestations enabled.

`compose.production.yml` expects explicit pinned values for
`CASEWEAVER_MIGRATION_IMAGE`, `CASEWEAVER_API_IMAGE`,
`CASEWEAVER_WORKER_IMAGE`, `CASEWEAVER_SCHEDULER_IMAGE`,
`CASEWEAVER_WEBHOOK_IMAGE`, and `CASEWEAVER_STANDALONE_IMAGE`. It also requires Docker
secret files for the database URL and PostgreSQL password, and production API
configuration such as `API_WORKSPACE_ID`, `API_PRINCIPAL_ID`, and the HTTPS
`ADMIN_ALLOWED_ORIGINS` value.

Run the migration profile once, wait for it to exit successfully, then choose exactly
one runtime profile:

```powershell
docker compose -f deploy\docker\compose.production.yml --profile migrate run --rm migrate
docker compose -f deploy\docker\compose.production.yml --profile distributed up -d
# or: docker compose -f deploy\docker\compose.production.yml --profile standalone up -d
```

Production password login is off by default. Configure OIDC, or explicitly set
`ADMIN_ENABLE_PASSWORD_AUTHENTICATION=true` with non-default deployment credentials.
No browser receives those credentials, database URLs, connector/provider secrets, or
repository checkout material.

This is deliberately still PBI-017 work in progress: an external TLS edge, managed
secret integration, backup/restore drill, image vulnerability policy, and provenance/
attestation verification are not claimed by this reference Compose file.

## OIDC in the local stack

Password login is enough for local evaluation. To exercise OIDC, set all required
values before starting Compose. The callback and origin must be real HTTPS URLs; the
loopback edge is not a public OIDC deployment.

```powershell
$env:OIDC_ISSUER = "https://issuer.example.com"
$env:OIDC_CLIENT_ID = "caseweaver-local"
$env:OIDC_CALLBACK_URL = "https://caseweaver-local.example.com/v1/auth/callback"
$env:OIDC_EPHEMERAL_ENCRYPTION_KEY = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
$env:OIDC_EPHEMERAL_KEY_ID = "local-key-1"
$env:ADMIN_BOOTSTRAP_OIDC_SUBJECT = "issuer-stable-subject"
$env:ADMIN_BOOTSTRAP_DISPLAY_NAME = "Local administrator"
$env:ADMIN_DISABLE_LOGIN_AUTHENTICATION = "true"
docker compose -f deploy\docker\compose.local.yml up --build --wait
```

## Test database and Admin bridge

For host-run PostgreSQL/pgvector integration tests:

```powershell
docker compose -f deploy\docker\compose.test.yml up -d --wait
$env:DATABASE_URL = "postgresql://caseweaver:caseweaver@localhost:54329/caseweaver_test"
pnpm test:integration
docker compose -f deploy\docker\compose.test.yml down -v
```

`compose.admin.yml` is only for an API that is already running elsewhere:

```powershell
$env:CASEWEAVER_ADMIN_API_BASE_URL = "https://api.example.com"
docker compose -f deploy\docker\compose.admin.yml up --build --wait
```

It exposes the UI on `http://127.0.0.1:8082` and is not a TLS or authentication
boundary; the API owns authentication, authorization, CSRF, auditing, and secrets.
