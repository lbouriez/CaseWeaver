---
sidebar_position: 2
title: Quick start
---

# Quick start: a disposable local evaluation

**Availability:** available for a private workstation. This is not a production setup.

## Prerequisites

Install Docker Desktop with Compose, Node.js 22.13 or newer, and Corepack. Clone the
repository; no cloud account, provider key, or external connector is required for this
first run.

```powershell
corepack enable
pnpm install
docker compose -f deploy\docker\compose.local.yml up --build --wait
```

This starts three persistent services: PostgreSQL/pgvector, one standalone backend, and
the static Admin frontend. Short-lived Prisma and queue migration jobs finish before the
backend starts. The frontend is the only exposed port.

Open `http://localhost:8080` or `http://127.0.0.1:8080`, then sign in as `admin` /
`admin`. These defaults exist only for the loopback development stack. Change them
through host environment variables before sharing even a private UI; do not place the
replacement value in a browser, URL, or documentation file.

```powershell
$env:ADMIN_LOGIN = "local-operator"
$env:ADMIN_PASSWORD = "<non-default private local value>"
docker compose -f deploy\docker\compose.local.yml up --build --wait
```

## Verify and clean up

```powershell
curl.exe --fail http://localhost:8080/health/live
curl.exe --fail http://localhost:8080/health/ready
docker compose -f deploy\docker\compose.local.yml down -v
```

`down -v` is appropriate **only** here: it removes the named disposable local database
volume. It is never a production recovery command.

## Host-run tests and development

`compose.test.yml` starts only the disposable PostgreSQL/pgvector dependency for host
processes; it listens on port `54329`. Use `pnpm db:test:up`, supply a clearly test-only
`DATABASE_URL` where a test asks for it, and run `pnpm db:test:down` afterwards.
`compose.admin.yml` serves only the static Admin bridge for an API already running
elsewhere; it has no database, queue, connector, or provider access.

For a real local Git knowledge experiment, continue with [Git / Markdown](./git-markdown.md).
