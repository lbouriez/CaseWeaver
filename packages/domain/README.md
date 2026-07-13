# Domain

**PBI:** 002

Pure TypeScript domain contracts: opaque identifiers, SHA-256 and UTC validation,
typed operational errors, immutable typed envelopes, and analysis/publication state
transitions. Envelopes permit only `analysis.execute.v1`,
`publication.execute.v1`, and `analysis.completed.v1`, with identifier-only payloads.

This package has no I/O, framework, environment, database, HTTP, queue, or vendor
dependencies.
