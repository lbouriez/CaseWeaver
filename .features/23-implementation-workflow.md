# LLM implementation workflow

## Required reading

Before coding:

1. Read `AGENTS.md`.
2. Read feature files `01` through `12` for context.
3. Read the implementation guide for the target module.
4. Read the target folder README.
5. Read the assigned PBI and dependencies.
6. Inspect existing code and tests before adding contracts.

## Interface-first sequence

For each PBI:

1. Confirm required inward contracts exist.
2. Define or refine the smallest stable interfaces.
3. Add deterministic fakes/fixtures.
4. Implement vendor-neutral policy.
5. Implement outer adapter.
6. Register through the PBI-owned application module.
7. Add targeted tests from `22-testing-strategy.md`.
8. Validate the measurable PBI acceptance criteria.
9. Update feature/package documentation when behavior differs.

Do not scaffold every future adapter before the first vertical slice works.

## Subagent dispatch

Only dispatch work that has exclusive file ownership and no unresolved dependency:

- Give each subagent the complete PBI, relevant feature guides, and allowed paths.
- One subagent owns one cohesive module or adapter.
- The parent/integration agent owns shared registries, root configuration, and final
  validation.
- Do not let two agents edit the same migration, package manifest, bootstrap, or registry.
- Agents return changed files, contracts used, tests, and unresolved integration needs.
- Integrate dependency layers before dependents.

## Delivery waves

- Foundation and shared contracts are completed before parallel adapters.
- After contracts stabilize, independent connectors/providers/infrastructure adapters may
  proceed in parallel.
- Application integration is a separate controlled step.
- Do not parallelize tightly coupled files merely to increase agent count.

## Cost discipline while coding

- Use fakes for tests and local development.
- Never run live AI calls unless explicitly required and budgeted.
- Verify cache/no-op paths before adding optimization.
- Every new AI call must document role, cache, budget, ledger, and failure behavior.

## Completion report

The coding agent reports:

- PBI and acceptance criteria completed,
- public contracts added/changed,
- files and modules implemented,
- tests run,
- migrations/configuration added,
- remaining risks or blocked dependencies,
- and whether documentation changed.
