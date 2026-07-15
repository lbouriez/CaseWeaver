# Domain

**PBI:** 002

Pure TypeScript domain contracts: opaque identifiers, SHA-256 and UTC validation,
typed operational errors, immutable typed envelopes, and analysis/publication state
transitions. Knowledge synchronization envelopes pin the source's immutable
configuration version and identify whether they came from a manual request or
a schedule; they never carry connector configuration or credentials.

This package has no I/O, framework, environment, database, HTTP, queue, or vendor
dependencies.
