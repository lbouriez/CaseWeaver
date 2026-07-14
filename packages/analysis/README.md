# Analysis

**PBI:** 011

Case snapshot analysis orchestration, evidence assembly, optional repository
investigation, structured result validation, confidence/hypothesis rules, rendering
input, and analysis idempotency.

Uses ports for retrieval, prompts, metered AI execution, and repositories. It produces an
immutable result and rendering input only.

Approval, destination selection, idempotency, and connector publication belong to the
PBI 012 publication application use case.

The package owns vendor-neutral execution ports and deterministic fakes. Its completion
port atomically persists the immutable result and an `analysis.completed.v1` outbox
event; adapters implement that transaction. It never imports a provider, database, or
publication package.

Snapshot tombstones preserve captured content and its hash while recording the acting
principal, UTC time, and reason outside that immutable payload. A forced rerun is a new
analysis job and attempt; it never replaces the completed result from an earlier run.
