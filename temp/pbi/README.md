# Temporary implementation backlog

These files divide CaseWeaver into independently reviewable delivery items. They are
temporary source material for GitHub Issues and should be removed after issue migration.

## Delivery order and state

| State | Meaning |
|---|---|
| Completed | All acceptance criteria in the PBI were delivered and validated. |
| In progress | A delivery slice is complete, but the PBI's remaining acceptance criteria are documented in its file. |
| Deferred | Intentionally postponed; do not start unless explicitly reprioritized. |
| Pending | Not started. Dependencies or priority may still prevent implementation. |

| PBI | Title | State | Depends on | Remaining work |
|---|---|---|---|---|
| 001 | Repository foundation | Completed | None | None |
| 002 | Domain and persistence foundation | Completed | 001 | None |
| 003 | AI providers, model catalog, and cost | Completed | 001, 002 | None |
| 006 | Helpdesk-neutral connector contracts | Completed | 002 | None |
| 004 | Incremental knowledge ingestion | Completed | 002, 003, 006 | None |
| 005 | Git/Markdown and Docusaurus source | Completed | 004 | None |
| 007 | Jitbit reference adapter | Completed | 004, 006 | None |
| 008 | Secure attachment processing | Completed | 002, 003, 006 | None |
| 009 | Hybrid retrieval | Completed | 003, 004, 005, 006 | None |
| 010 | Repository-agent sandbox and Copilot BYOK adapter | Completed | 003 | None |
| 011 | Case-analysis orchestration | Completed | 003, 008, 009 | None |
| 012 | Destinations, triggers, and publication | Completed | 007, 011 | None |
| 013 | Production operations | Completed | 012 | None |
| 014 | MCP foundation | Deferred | 013 | Start only when MCP is reprioritized. |
| 015 | Evidence-aware chat service | Deferred | 003, 009, 014 | Start only after PBI-014 is completed and chat is reprioritized. |
| 016 | React-Admin operator console | Completed | 013 | None. Secure cookie-session administration APIs, immutable configuration, audits, and validated static-console integration are delivered. See PBI-016. |
| 017 | Docker-first self-hosting and delivery | Pending | 013, 016 | Release images, TLS edge, and CI delivery remain planned; PBI-016 is accepted. |
| 018 | Documentation portal and operator guide | Pending | 013, 016, 017 | Docusaurus portal, task-oriented operator/developer guides, Rekindle-derived presentation and translation workflow, and clearly separated current/future capability documentation. |

PBIs should be implemented in order unless their declared dependencies are complete.
Each PBI must satisfy `.features/11-engineering-standards.md`.

## Primary folder ownership

| PBI | Primary folders |
|---|---|
| 001 | `apps/api`, `apps/worker`, `apps/cli`, `deploy/docker` |
| 002 | `packages/domain`, `packages/application`, `packages/security`, `infrastructure/postgres`, `infrastructure/queue-postgres` |
| 003 | `packages/ai-sdk`, `packages/ai-config`, `packages/ai-execution`, `providers/openai-compatible` |
| 004 | `packages/knowledge`, `packages/scheduling`, `apps/scheduler` |
| 005 | `connectors/git-markdown` |
| 006 | `packages/connector-sdk`, `connectors/_template`, `tests/contract` |
| 007 | `connectors/jitbit` |
| 008 | `packages/attachments`, `infrastructure/object-storage`, `infrastructure/attachment-runtime` |
| 009 | `packages/retrieval`, `infrastructure/postgres` |
| 010 | `providers/copilot-sdk-agent`, `infrastructure/repository-runtime` |
| 011 | `packages/analysis`, `packages/prompts`, `apps/worker` |
| 012 | `packages/webhooks`, `packages/publication`, `apps/webhook`, `apps/api`, `apps/scheduler` |
| 013 | `packages/observability`, `apps/standalone`, `deploy/docker`, `tests/integration`, `tests/e2e` |
| 014 | `apps/mcp` |
| 015 | `packages/chat` |
| 016 | `apps/admin`, `apps/api/src/modules/auth`, `apps/api/src/modules/administration`, `packages/administration`, `infrastructure/postgres/src/administration`, `tests/contract/administration`, `tests/integration`, `tests/e2e` |
| 017 | `deploy/docker`, `.github/workflows`, `tests/e2e/deployment`, deployment/operator documentation; coordinated integration with `apps/admin`, `apps/api`, and `apps/standalone` |
| 018 | `website`, repository/operator documentation, and documentation links; coordinated review with PBI 003, 016, and 017 owners |

Agents may touch shared contracts only when their PBI owns the contract or after
coordinating the change with the owning PBI.

## Shared integration surfaces

Parallel agents own capability-specific subpaths rather than entire shared folders:

| Shared surface | Ownership rule |
|---|---|
| PostgreSQL migrations | Each PBI adds a uniquely numbered migration and capability repository under `infrastructure/postgres/src/<capability>`; PBI 002 owns transaction/migration frameworks |
| AI contract tests | PBI 003 owns `tests/contract/ai` |
| Connector contract tests | PBI 006 owns `tests/contract/connectors` |
| Worker handlers | Feature PBI owns a domain-named module under `apps/worker/src/modules` (for example `analysis`, `publication`, or `operations`); one designated integration owner updates the module registry per delivery wave |
| API routes | Feature PBI owns a domain-named module under `apps/api/src/modules`; PBI 001 owns transport/bootstrap conventions |
| Scheduler jobs | PBI 004 owns knowledge schedule modules; PBI 012 owns case-analysis schedule modules |
| Composition roots | PBI 001 establishes registries; PBI 013 owns final distributed/standalone integration and production profiles |
| Administration contracts | PBI 016 owns `packages/administration`; feature packages retain their domain policy and immutable configuration contracts |
| Docker image and Compose contracts | PBI 017 owns `deploy/docker` release assets, Compose topology, operator configuration, and image verification; application owners retain process behavior and health semantics |
| Admin artifact packaging | PBI 016 owns `apps/admin` and its typed runtime public-config contract; after PBI 016 acceptance, PBI 017 packages that artifact without adding browser secrets or authorization behavior |
| CI and release delivery | PBI 017 owns delivery workflows and their supply-chain policy; PBI 001 retains root manifest/toolchain conventions and existing package checks |

Subagents must not edit the same registry, migration, or bootstrap file concurrently.
