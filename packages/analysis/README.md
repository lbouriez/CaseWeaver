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
publication package. Deterministic attachment, retrieval, repository, and AI
implementations are test fixtures only; production composition must provide real
server-private ports.

Snapshot tombstones preserve captured content and its hash while recording the acting
principal, UTC time, and reason outside that immutable payload. A forced rerun is a new
analysis job and attempt; it never replaces the completed result from an earlier run.

`FrozenSnapshotAttachmentEvidencePort` resolves only append-only
`SnapshotAttachmentReference` records captured with the exact case snapshot. The port
receives normalized derivative text through a server-private reader, validates its
captured output hash, rejects oversize content rather than truncating it, and never
receives an object-storage location. PBI-008 supplies that reader and PostgreSQL owns
the snapshot-reference store.

The orchestrator has no repository fallback. A disabled repository stage does not call
its port; an enabled stage requires an exact immutable repository runtime version,
binding, repository, and commit through a composition-supplied pinned sandbox adapter.
Prompt construction is resolved per execution through a binding-aware builder resolver;
the package never substitutes a default tokenizer for the retained analysis binding.
Terminal failure persistence intentionally uses an un-aborted signal so a cancelled
queue lease cannot leave a durable attempt running.
