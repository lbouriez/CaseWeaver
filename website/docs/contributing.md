---
sidebar_position: 16
title: Contributing
---

# Contributing to CaseWeaver

Read `AGENTS.md`, the relevant `.features` guide, the target folder README, and the
delivery item before editing. Dependencies point inward: applications/adapters depend on
feature/application code, which depends on the domain. Do not make the domain depend on
HTTP, PostgreSQL, a connector, or an AI provider.

## Documentation site

```powershell
pnpm --dir website install
pnpm --dir website typecheck
pnpm --dir website test
pnpm --dir website build
```

English is canonical. French counterparts are authored documentation, never a browser
translation. Run `pnpm --dir website translations:plan -- --dry-run` after changing
English; it identifies files that need a reviewer. After documented review—human by
default, or an owner-authorized AI validation for a named delivery—run
`pnpm --dir website translations:manifest`. The manifest records the English hash only;
it neither translates text nor calls an AI provider.

## Product changes

Use focused unit tests for invariants, contract tests for adapter families, real
PostgreSQL integration tests for persistence behavior, and a small critical E2E set for
production risks. Use deterministic fakes by default. A live AI test is opt-in,
budget-capped, and must use `@caseweaver/ai-execution`.

Keep documentation changes concise, safe, and matched in French. Never add a secret,
credential-bearing URL, production connection string, or browser workaround for a
missing server capability.
