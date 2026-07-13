# Standalone application

**PBI:** 013

Convenience composition for small installations that hosts API, webhook, scheduler, and
worker modules in one process while preserving their internal boundaries.

Contains no business logic unavailable to separately deployed applications.

Uses the same PostgreSQL queue, outbox relay, migrations, command handlers, leases, and
configuration as distributed mode. In-process direct command dispatch is forbidden.
