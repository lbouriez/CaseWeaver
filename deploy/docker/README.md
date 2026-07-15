# Docker deployment

**PBIs:** 001, 013, 016

`compose.production.yml` is a production Compose example with two mutually exclusive
runtime profiles:

- `standalone`: API, webhook, scheduler, relay, and worker lifecycle co-located in one
  service.
- `distributed`: separate API, webhook, scheduler, and worker services.

Both use the same PostgreSQL volume, Prisma schema, pg-boss schema, queue name, durable
outbox envelopes, and worker handlers. Never start both profiles against one deployment.
To move modes, stop the old profile, retain `caseweaver_postgres_data`, then start the
other profile after a successful migration. Do not delete the volume; queued envelopes
and leases are durable state.

## Production startup

Set an immutable `CASEWEAVER_IMAGE` and create two local files containing only the
database URL and PostgreSQL password. The Compose process reads them as Docker secrets;
do not put either value in an environment file or command line.

```powershell
$env:CASEWEAVER_IMAGE = "registry.example/caseweaver@sha256:replace-me"
$env:CASEWEAVER_DATABASE_URL_FILE = "C:\secrets\caseweaver-database-url.txt"
$env:CASEWEAVER_POSTGRES_PASSWORD_FILE = "C:\secrets\caseweaver-postgres-password.txt"
docker compose -f deploy\docker\compose.production.yml --profile migrate run --rm migrate
docker compose -f deploy\docker\compose.production.yml --profile standalone up -d
```

For distributed mode, replace the final command with:

```powershell
docker compose -f deploy\docker\compose.production.yml --profile distributed up -d
```

The release image must provide `caseweaver-migrate`, `caseweaver-standalone`,
`caseweaver-api`, `caseweaver-webhook`, `caseweaver-scheduler`, and
`caseweaver-worker` commands. `caseweaver-migrate` runs Prisma migrations followed by
the pinned pg-boss migration before runtime services start; runtime roles must not have
DDL permissions. `entrypoint.sh` reads the database URL secret only inside the
container, exports it for the selected process, and never prints it.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` only when an OTLP collector is available. Applications
then use real OTLP/HTTP trace and metric exporters; leaving it empty produces no SDK or
fake telemetry. The database is isolated on an internal Docker network. Runtime
services have a separate egress network for the collector and configured providers.

## Local administration-console bridge

`compose.admin.yml` is a deliberately small, local static-hosting bridge for the
PBI-016 admin artifact. It does not replace the PBI-017 production image, TLS edge, or
release process. It has no database URL, Docker secret, queue, connector, provider, or
object-storage mount. It binds only to loopback and requires a separately running API.

Build the browser artifact first, then supply its **public** API base URL. The API URL
must use HTTPS except for localhost development. Do not put OIDC credentials, bearer
tokens, connector credentials, or database values in either variable.

```powershell
pnpm --filter @caseweaver/admin build
$env:CASEWEAVER_ADMIN_API_BASE_URL = "http://127.0.0.1:3000"
$env:CASEWEAVER_ADMIN_UI_TITLE = "CaseWeaver Control Room"
docker compose -f deploy\docker\compose.admin.yml up --build -d --wait
```

Open `http://127.0.0.1:8082`. The container generates `/runtime-config.json` in its
read-only runtime filesystem and serves it with `Cache-Control: no-store`; it is the
same credential-free public contract consumed by `apps/admin`. The static artifact is
mounted read-only. Stop the bridge with:

```powershell
docker compose -f deploy\docker\compose.admin.yml down
```

This bridge is intentionally not an authentication or TLS boundary. Run it only for
local development until PBI-017 provides a TLS edge and digest-pinned release images.
The API remains responsible for OIDC sessions, cookies, CSRF, origin validation,
authorization, auditing, and all secret handling.

## Disposable test PostgreSQL

Start PostgreSQL 17 with pgvector:

```powershell
docker compose -f deploy\docker\compose.test.yml up -d --wait
```

Fresh test volumes initialize the `vector` extension automatically. Container health
requires the extension to exist.

Default test connection:

```text
postgresql://caseweaver:caseweaver@localhost:54329/caseweaver_test
```

Reset to a clean database:

```powershell
docker compose -f deploy\docker\compose.test.yml down -v
docker compose -f deploy\docker\compose.test.yml up -d --wait
```

The credentials are intentionally local test defaults and must not be reused in a
production Compose profile.
