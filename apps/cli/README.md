# CLI application

**PBIs:** 001, 013

Administrative and automation interface for configuration validation, migrations,
connector/provider tests, synchronization, analysis, diagnostics, and operations.

Commands call the same application use cases as HTTP transports.

PBI-013's injected command module exposes dead-letter inspection, retry, cancellation,
lease recovery, exact cost queries, privacy purge, and retention reaping. The local
bootstrap supplies its authenticated workspace/principal context; command arguments
cannot impersonate an actor.
