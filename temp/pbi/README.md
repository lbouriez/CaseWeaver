# Temporary implementation backlog

These files divide CaseWeaver into independently reviewable delivery items. They are
temporary source material for GitHub Issues and should be removed after issue migration.

## Delivery order

| PBI | Title | Depends on |
|---|---|---|
| 001 | Repository foundation | None |
| 002 | Domain and persistence foundation | 001 |
| 003 | AI providers, model catalog, and cost | 001, 002 |
| 004 | Incremental knowledge ingestion | 002, 003 |
| 005 | Git/Markdown and Docusaurus source | 004 |
| 006 | Helpdesk-neutral connector contracts | 002 |
| 007 | Jitbit reference adapter | 006 |
| 008 | Secure attachment processing | 002, 003, 006 |
| 009 | Hybrid retrieval | 003, 004, 005, 006 |
| 010 | Repository-agent sandbox and Copilot BYOK adapter | 003 |
| 011 | Case-analysis orchestration | 003, 008, 009 |
| 012 | Destinations, triggers, and publication | 007, 011 |
| 013 | Production operations | 012 |
| 014 | MCP foundation | 013 |

PBIs should be implemented in order unless their declared dependencies are complete.
Each PBI must satisfy `.features/11-engineering-standards.md`.
