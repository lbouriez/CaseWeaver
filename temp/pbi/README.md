# Temporary implementation backlog

These files divide CaseWeaver into independently reviewable delivery items. They are
temporary source material for GitHub Issues and should be removed after issue migration.

## Delivery order

| PBI | Title | Depends on |
|---|---|---|
| 001 | Repository foundation | None |
| 002 | Domain and persistence foundation | 001 |
| 003 | AI providers, model catalog, and cost | 001, 002 |
| 006 | Helpdesk-neutral connector contracts | 002 |
| 004 | Incremental knowledge ingestion | 002, 003, 006 |
| 005 | Git/Markdown and Docusaurus source | 004 |
| 007 | Jitbit reference adapter | 004, 006 |
| 008 | Secure attachment processing | 002, 003, 006 |
| 009 | Hybrid retrieval | 003, 004, 005, 006 |
| 010 | Repository-agent sandbox and Copilot BYOK adapter | 003 |
| 011 | Case-analysis orchestration | 003, 008, 009 |
| 012 | Destinations, triggers, and publication | 007, 011 |
| 013 | Production operations | 012 |
| 014 | MCP foundation | 013 |
| 015 | Evidence-aware chat service | 003, 009, 014 |
| 016 | React-Admin operator console | 013 |

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
| 016 | `apps/admin`, `apps/api` |

Agents may touch shared contracts only when their PBI owns the contract or after
coordinating the change with the owning PBI.

## Shared integration surfaces

Parallel agents own capability-specific subpaths rather than entire shared folders:

| Shared surface | Ownership rule |
|---|---|
| PostgreSQL migrations | Each PBI adds a uniquely numbered migration and capability repository under `infrastructure/postgres/src/<capability>`; PBI 002 owns transaction/migration frameworks |
| AI contract tests | PBI 003 owns `tests/contract/ai` |
| Connector contract tests | PBI 006 owns `tests/contract/connectors` |
| Worker handlers | Feature PBI owns `apps/worker/src/modules/pbi-<id>`; one designated integration owner updates the module registry per delivery wave |
| API routes | Feature PBI owns `apps/api/src/modules/pbi-<id>`; PBI 001 owns transport/bootstrap conventions |
| Scheduler jobs | PBI 004 owns knowledge schedule modules; PBI 012 owns case-analysis schedule modules |
| Composition roots | PBI 001 establishes registries; PBI 013 owns final distributed/standalone integration and production profiles |

Subagents must not edit the same registry, migration, or bootstrap file concurrently.
