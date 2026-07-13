# PBI-006: Helpdesk-neutral connector contracts

## Outcome

Define portable case and destination contracts before implementing a vendor adapter.

## Scope

- Normative case lifecycle, actor, message, visibility, body, timestamp, attachment,
  access, revision, and resolution schemas.
- `CaseSource`, `AttachmentSource`, `AnalysisDestination`, and `WebhookAdapter` ports.
- Canonical normalized case-revision hashing.
- Connector configuration, capability, cursor, cancellation, pagination, rate-limit,
  and typed-error primitives.
- Opaque discovery fingerprint/revision contract and source synchronization-policy schema.
- Snapshot/delta discovery mode, scan epoch/completion, and explicit tombstone contracts.
- Connector conformance test kit and fixture builders.
- Jitbit-shaped, Odoo-shaped, and capability-limited fixtures.

## Acceptance criteria

- Contracts represent Jitbit and Odoo fixtures without vendor fields in the core.
- Ordered public, internal, and system messages remain distinguishable.
- Missing optional capabilities do not require invented values.
- Case revision is deterministic across equivalent normalized snapshots.
- Git blob, ETag/API revision, and no-fingerprint discovery fixtures demonstrate the
  expected cheap-change-check behavior.
- Idempotency-key request-hash conflicts are tested.
- A new adapter can execute the contract suite without importing application internals.

## Excluded

Real vendor API calls and attachment binary processing.
