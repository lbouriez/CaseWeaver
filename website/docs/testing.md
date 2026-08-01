---
sidebar_position: 13
title: Testing
---

# Testing safely

Use deterministic fakes by default. Integration and E2E tests must use a disposable
database whose name is clearly test-scoped; do not point `DATABASE_URL` at production.

| Layer | Command / prerequisite | What it protects |
| --- | --- | --- |
| Formatting and lint | `pnpm format:check`, `pnpm lint` | Consistent source and static rules. |
| Dependency boundaries | `pnpm deps:check` | Inward architecture. |
| Type/build | `pnpm typecheck`, `pnpm build` | Type and package/build contracts. |
| Unit + contract | `pnpm test` | Invariants and adapter-family contracts. |
| PostgreSQL integration | `pnpm db:test:up`; test-scoped `DATABASE_URL`; `pnpm test:integration`; `pnpm db:test:down` | Migrations, transactions, isolation, queue behavior. |
| Browser E2E | `pnpm test:e2e` | Critical Admin/browser behavior. |
| Local Compose E2E | `pnpm test:e2e:compose` | Deterministic provider onboarding and knowledge ingestion through the real local stack. |
| Production Compose E2E | `pnpm test:e2e:production` | TLS, auth, role isolation, backup/restore, and both runtime modes with private fixtures. |

`PG_BOSS_INTEGRATION=1` is only a test prerequisite where the integration suite names
it. Live AI testing is opt-in and budget-capped; normal tests and docs commands never
call a provider or require a production credential. Clean test state explicitly even
after a failure.
