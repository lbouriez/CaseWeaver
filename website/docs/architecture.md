---
sidebar_position: 14
title: Architecture
---

# Architecture and workflow

CaseWeaver keeps vendor behavior at the boundary. Connectors translate external systems,
AI providers sit behind metered execution, and the domain does not branch on a vendor or
model name.

```text
Admin / API / webhook / scheduler
              |
 application and feature use cases
              |
            domain
              |
 PostgreSQL + pgvector / queue / object storage / adapters
```

## Durable work, in order

1. A synchronization, verified webhook, schedule, or manual command is validated at an
   ingress boundary.
2. The command and its outbox record commit with the affected state in PostgreSQL.
3. A relay delivers the envelope to the durable PostgreSQL queue.
4. A worker holds a lease, resolves the exact immutable configuration version, and does
   the bounded connector, storage, retrieval, or AI work.
5. Results, evidence, cost attribution, audit events, and publication state are
   retained. Retry/recovery uses the durable record instead of replaying a browser call.

The small **standalone** mode hosts API, webhook ingress, scheduler, worker, and relay
in one process. **Distributed** mode hosts them separately. Both use the same queue,
leases, handlers, PostgreSQL state, and immutable version pins; standalone is not an
in-memory shortcut.

## Evidence, storage, and AI

PostgreSQL is the system of record for configuration history, work, audit, queue state,
full-text search, and pgvector data. Object storage holds bounded attachment bytes and
derivatives. An analysis retains the selected source/version and evidence snapshot; a
later configuration change cannot silently rebind already queued work.

Every model invocation goes through `@caseweaver/ai-execution`. That gateway records
usage and cost attribution, applies the selected immutable binding and budget, and
fails safely when price is unknown rather than treating it as zero.

See [Testing](./testing.md) for the checks that exercise these boundaries and
[Contributing](./contributing.md) before adding an adapter.
