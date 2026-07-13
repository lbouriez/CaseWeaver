# Docker deployment

**PBIs:** 001, 013

Development and production Compose definitions for PostgreSQL, API, webhook, scheduler,
worker, MCP when enabled, and optional object storage/repository runtime.

Health checks, migrations, least-privilege networks, volumes, and example configuration
belong here.

Provide mutually exclusive profiles for distributed services and one standalone service.
Both profiles use PostgreSQL-backed queueing and the same persistent schema; switching
profiles must not change behavior or lose queued work.

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
