# Domain

**PBI:** 002

Pure TypeScript domain contracts: opaque identifiers, SHA-256 and UTC validation,
typed operational errors, immutable typed envelopes, and analysis/publication state
transitions. New knowledge synchronization envelopes pin distinct immutable source and
connector configuration versions and identify whether they came from a manual request
or a schedule; they never carry connector settings, credentials, or secret locators.
Legacy v1 knowledge envelopes deserialize only with an in-memory `legacy: true` marker
so a worker can fail them as unavailable; they cannot be emitted for new work and their
historical source pin is never reinterpreted as a connector version.

Versioned analysis-trigger envelopes follow the same boundary. New
`analysis.trigger.v2` commands contain a durable request ID plus immutable trigger,
profile, and connector-configuration identities and a normalized target. They never
contain settings, secret locators, source URLs, or captured case content. Historical
`analysis.trigger.v1` envelopes deserialize solely so a consumer can return the stable
legacy-unavailable outcome; runtime validation rejects attempts to emit them.

Retention reaping commands carry only a reason and an optional bounded batch hint;
the optional hint preserves compatibility with already-persisted v1 commands. Purge
commands identify durable retention work only, never object locators or storage
credentials.

This package has no I/O, framework, environment, database, HTTP, queue, or vendor
dependencies.
