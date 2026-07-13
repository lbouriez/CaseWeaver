# PBI-011: Case-analysis orchestration

## Outcome

Combine snapshots, attachments, retrieval, and optional repository evidence into a
durable structured analysis.

## Scope

- Versioned analysis profiles and immutable model-binding references.
- Configured knowledge-collection selection and destination references.
- Idempotent analysis requests, canonical request hashes, and force-rerun behavior.
- Immutable case snapshot capture.
- Bounded prompt/context assembly.
- Optional repository-agent port using the deterministic fake by default.
- Required/optional stage policy.
- Structured generation with Zod validation and bounded repair policy.
- Evidence linkage, confidence, unanswered questions, and hypotheses.
- Server-side rendering and notice insertion.
- Analysis budget reservations and complete operation correlation.

## Acceptance criteria

- Equivalent requests deduplicate; a reused key with different content conflicts.
- Profile, binding, repository commit, or case revision changes create a new identity.
- Analysis succeeds when repository investigation is disabled.
- Analysis remains unchanged when provider, model, agent runtime, source, or destination
  implementations are replaced behind the same contracts.
- Every probable cause and recommendation references evidence or is marked hypothesis.
- Required-stage failure cannot become a successful analysis.
- Retained analyses are auditably reconstructable from versions, hashes, snapshots, and
  transcripts; deleted data is represented by tombstones.

## Excluded

Automatic publication and a required dependency on the Copilot adapter.
