# PBI-011: Case-analysis orchestration

## Delivery status

**Completed.** Immutable snapshot-to-attachment/derivative evidence, retrieval/profile
resolution, tokenization, repository sandbox selection, AI-execution gateway use, and
binding-version retention are composed through server-private production adapters.
Unavailable required dependencies fail closed. Repository investigation is optional and
uses a pinned sandbox only when the immutable profile enables it; there is no production
repository fake/default.

Durable cancellation/failure attempt recording, retry/restart, retention, isolation,
and immutable evidence behavior are validated through unit and PostgreSQL integration
coverage.

## Outcome

Combine snapshots, attachments, retrieval, and optional repository evidence into a
durable structured analysis.

## Scope

- Versioned analysis profiles and immutable model-binding references.
- Configured knowledge-collection selection.
- Idempotent analysis requests, canonical request hashes, and force-rerun behavior.
- Immutable case snapshot capture.
- Bounded prompt/context assembly.
- Optional repository-agent port using a production pinned sandbox runtime when
  enabled; deterministic fakes are test-only.
- Required/optional stage policy.
- Structured generation with Zod validation and bounded repair policy.
- Evidence linkage, confidence, unanswered questions, and hypotheses.
- Analysis budget reservations and complete operation correlation.
- Atomic `AnalysisCompleted` domain event emission with the stored result.

## Acceptance criteria

- Equivalent requests deduplicate; a reused key with different content conflicts.
- Profile, binding, repository commit, or case revision changes create a new identity.
- Analysis succeeds when repository investigation is disabled.
- Analysis remains unchanged when provider, model, agent runtime, or source
  implementations are replaced behind the same contracts.
- Every probable cause and recommendation references evidence or is marked hypothesis.
- Required-stage failure cannot become a successful analysis.
- Retained analyses are auditably reconstructable from versions, hashes, snapshots, and
  transcripts; deleted data is represented by tombstones.
- The completed analysis has no destination side effect; publication remains a separate
  PBI 012 command.

## Excluded

Destination selection, rendering, notices, publication policy, automatic publication,
and a required dependency on the Copilot adapter.
