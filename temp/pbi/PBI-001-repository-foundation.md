# PBI-001: Repository foundation

## Outcome

Create a buildable TypeScript monorepo and local runtime skeleton.

## Scope

- pnpm workspace with `apps`, `packages`, `connectors`, and `providers`.
- Strict shared TypeScript configuration and ESM.
- API, worker, and CLI entry points with health commands only.
- PostgreSQL and pgvector Docker Compose services.
- Environment parsing through Zod.
- Structured logger with secret redaction.
- Vitest, formatting, linting, build, and type-check commands.
- Apache-2.0 license, contribution guide, and CI workflow.

## Acceptance criteria

- A clean checkout installs and builds with documented commands.
- Docker Compose starts PostgreSQL with pgvector enabled.
- `deploy/docker/compose.test.yml` can be started and reset with documented commands.
- API readiness verifies database access.
- Invalid configuration fails before serving traffic.
- No package has circular dependencies.
- CI runs build, type-check, lint, and tests.

## Excluded

Domain tables, connectors, AI calls, and analysis behavior.
