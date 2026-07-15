# CaseWeaver coding-agent guide

Read `.features/README.md`, the relevant feature specifications, the target PBI, and each
folder README before changing code.

Implementation details are defined in `.features/13` through `.features/23`. Database
work must read `.features/20-persistence-and-database-guide.md`; every change must follow
`.features/22-testing-strategy.md`.

## Architecture rules

1. Dependencies point inward: apps/adapters -> application/features -> domain.
2. `packages/domain` has no runtime, database, HTTP, connector, or AI dependencies.
3. Vendor behavior belongs in `connectors`, `providers`, or `infrastructure`.
4. Apps contain transport, lifecycle, and dependency composition only.
5. Scheduler and webhook apps enqueue commands; workers execute them.
6. Core code never branches on vendor, provider, model, or agent-runtime names.
7. Every AI call goes through `packages/ai-execution`; direct provider invocation from
   feature packages is forbidden.
8. Every external input is validated at its boundary.
9. Do not create generic dumping grounds such as `common`, `shared`, or `utils`.
10. A cross-package contract change requires contract tests and updates to affected
    folder READMEs/specifications.
11. PBIs are delivery tracking only. Production paths, exported symbols, configuration
    keys, and test names must use the domain capability they represent, never a PBI
    number.

## Parallel-agent ownership

- Work within the folders assigned to the PBI in `temp/pbi/README.md`.
- For shared folders, use the PBI-owned subpaths and integration rules in that document.
- Do not implement another PBI's adapter as a shortcut.
- Prefer adding or implementing a port over importing an outer package inward.
- If a required contract is missing, update the owning contract package first and keep
  the change minimal.
- Only the designated integration owner edits composition registries during a parallel
  delivery wave; feature agents contribute independently registered modules.

Folder READMEs are temporary architectural contracts. Replace them only when the package
has permanent documentation covering the same responsibilities and dependency rules.
