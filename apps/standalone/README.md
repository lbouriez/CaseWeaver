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

The composition root does not choose connector, provider, persistence, or transport
implementations. A release bootstrap supplies those existing production components and
may enable OpenTelemetry by passing the optional configuration resolved from
`@caseweaver/observability`.
