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
its port; an enabled recipe retains immutable code-repository, execution-policy, and
provider-neutral repository-agent binding versions. Before the job identity is created,
trusted composition resolves that versioned repository's permitted ref to a
server-private `RepositoryRunPin` containing one exact commit. A recipe never stores a
moving branch or a commit. The run pin also contains the explicit server-created runtime
projection ID, never an inferred equivalence to a code-repository version. The worker rejects a missing/mismatched run pin and accepts
only server-validated repository path/range/excerpt-hash evidence. Repository-agent
findings are bounded untrusted evidence linked to that verified code evidence; prompt
composition must delimit them as evidence, never instructions.

Enabled attachment stages likewise require a pre-job immutable preparation set. It
contains only attachment/derivative identities, derivative hashes, required state, and
safe warning codes—not bytes, paths, filenames, URLs, or storage locators. Its canonical
hash participates in request identity, so a retry cannot silently change which prepared
case evidence was available. Any required occurrence must be `ready`; optional skipped
or failed occurrences remain typed warnings. `FrozenSnapshotAttachmentEvidencePort` verifies the durable
snapshot references against that selected set before it reads normalized derivative text.

Repository-agent findings are capped at 100 provider-neutral, evidence-linked records at
the analysis contract boundary. The list is rejected before finding text is mapped into
prompt evidence or an immutable result, preventing a tool/runtime from expanding a case
into unbounded retained or prompt-visible material.

Completed records can retain governed `ProtectedAnalysisContent` (the rendered prompt
and final model response) and a connector-neutral `AnalysisPublicationReceipt`. Those
are server-private persistence/read contracts, never list/detail DTOs, audit data,
diagnostics, traces, or logs. A receipt uses `externalPublicationId`; a destination may
map it to a comment ID without making comments a system-wide assumption.
Prompt construction is resolved per execution through a binding-aware builder resolver;
the package never substitutes a default tokenizer for the retained analysis binding.
Terminal failure persistence intentionally uses an un-aborted signal so a cancelled
queue lease cannot leave a durable attempt running.
