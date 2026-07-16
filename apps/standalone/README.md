# Standalone application

**PBI:** 013

Convenience lifecycle composition for small installations. It hosts API, webhook,
scheduler, and worker processes in one Node.js process while preserving their internal
boundaries.

`createStandaloneRuntime` receives the ordinary API, webhook, scheduler, and worker
lifecycles plus one `DurableQueueRuntime`. The runtime constructs the application
`OutboxRelay` with that exact queue and registers the normal worker consumer through
`queue.work()`. It never dispatches a command in process. Consequently standalone and
distributed mode share PostgreSQL queue records, envelope IDs, handler behavior,
retries, and leases.

`caseweaver-standalone start` now creates the regular API, webhook, scheduler,
and worker production hosts. The worker remains the only pg-boss consumer and
outbox relay, so standalone does not add a second in-memory dispatch path. It
starts one process-wide OpenTelemetry lifecycle, starts the runtime services in
durable-worker/scheduler/API/webhook order, and stops ingress before scheduler
and worker shutdown. The controlled installation job must apply Prisma and
pg-boss migrations before the standalone service starts.
