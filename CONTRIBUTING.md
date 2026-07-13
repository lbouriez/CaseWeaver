# Contributing to CaseWeaver

## Prerequisites

- Node.js 22 or later
- Corepack
- Docker Desktop for PostgreSQL integration checks

## Setup

```powershell
corepack enable
corepack install
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env` only for local development. Never commit real credentials.

## Quality checks

```powershell
pnpm format:check
pnpm lint
pnpm deps:check
pnpm typecheck
pnpm build
pnpm test
```

Start a disposable PostgreSQL/pgvector instance when needed:

```powershell
pnpm db:test:up
pnpm db:test:down
```

Read `AGENTS.md`, `.features/README.md`, and the relevant PBI before changing code.
