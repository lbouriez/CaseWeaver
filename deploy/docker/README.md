# Docker deployment

**PBIs:** 001, 013

Development and production Compose definitions for PostgreSQL, API, webhook, scheduler,
worker, MCP when enabled, and optional object storage/repository runtime.

Health checks, migrations, least-privilege networks, volumes, and example configuration
belong here.

Provide mutually exclusive profiles for distributed services and one standalone service.
Both profiles use PostgreSQL-backed queueing and the same persistent schema; switching
profiles must not change behavior or lose queued work.
