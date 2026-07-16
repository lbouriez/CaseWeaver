# Publication

**PBI:** 012

Destination-neutral publication use cases and policies: versioned publication profiles,
approval decisions, destination selection, rendering, notices/disclaimers, visibility,
destination limits, stable markers, idempotency leases, reconciliation, and receipts.

Consumes immutable analysis results and invokes `AnalysisDestination` through application
ports. Analysis creation never depends on this package.

Each active profile version retains the exact immutable connector-configuration
version selected at activation. Execution resolves a destination asynchronously from
that workspace-scoped pin; it never follows a connector's mutable current version and
never receives settings, credential locators, or secrets. Legacy unpinned records stay
readable for operations history but fail closed with a stable, non-retryable
configuration-unavailable result before connector I/O.
