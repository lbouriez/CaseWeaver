# Connectors and destinations implementation guide

## Purpose

Allow Git, Jitbit, Odoo, or future systems to participate without core changes.

## Connector package shape

A connector package may share one client/configuration while registering independent
capabilities:

- `KnowledgeSource`
- `CaseSource`
- `AttachmentSource`
- `AnalysisDestination`
- `WebhookAdapter`

Capability registration is explicit. Core services discover capabilities from a registry
and never use connector-name conditionals.

## Configuration

- Define a Zod schema with defaults and safe descriptions.
- Store secret references, never secret values.
- Return a redacted representation for diagnostics.
- Version configuration schemas and provide migrations when shape changes.
- Validate connectivity through a non-destructive health operation.

## External communication

- Use a typed client local to the connector.
- Centralize authentication, base URL, timeout, retry, and pagination behavior.
- Honor `AbortSignal`.
- Retry only retryable operations with bounded backoff and jitter.
- Preserve `Retry-After` and provider request IDs.
- Never retry a write unless idempotency/reconciliation makes it safe.
- Map remote failures to connector SDK errors.

## Source rules

- Discovery should be cheaper than full load.
- Expose the strongest stable fingerprint available.
- Normalize vendor data into neutral schemas without fabricating missing capabilities.
- Preserve message order, visibility, actor identity, and external revision evidence.

## Destination rules

Destinations receive a rendered publication payload and stable marker. They do not:

- run analysis,
- choose approval policy,
- generate notices,
- or mutate analysis state.

Before a non-idempotent write, destination logic checks for an existing marker. A timeout
after write becomes `outcome_unknown`; reconciliation occurs before retry.

## Webhook rules

- Verification receives exact raw bytes and headers.
- The server resolves connector context from an opaque endpoint ID.
- Body/header fields cannot select workspace, connector, adapter, or secret.
- Verification failure produces no normalized event or command.

## Connector contract tests

Every connector runs the common suite for the capabilities it declares. Add focused
tests only for vendor-specific mapping and edge cases. Do not copy the whole contract
suite into each connector.

Required test themes:

- pagination/cursor continuation,
- fingerprint stability,
- snapshot/delta behavior,
- message visibility and ordering,
- cancellation/rate limits,
- typed failures,
- attachment streaming,
- webhook verification,
- publication reconciliation and marker lookup.

## Forbidden

- Importing application implementations or database clients.
- Returning vendor SDK objects.
- Logging credentials or full sensitive payloads.
- Jitbit-shaped assumptions in neutral contracts.
