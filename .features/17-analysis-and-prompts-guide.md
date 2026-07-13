# Analysis and prompts implementation guide

## Purpose

Produce a destination-neutral, evidence-backed structured analysis from an immutable case
snapshot.

## Analysis input

The analysis command references immutable versions of:

- case snapshot,
- analysis profile,
- model bindings,
- retrieval profile and selected collections,
- attachment derivatives,
- repository binding and commit,
- prompt template/schema,
- and cost budgets.

Do not read mutable connector state after the snapshot is captured.

## Stage pipeline

1. Authorize and deduplicate request.
2. Load immutable snapshot/profile versions.
3. Resolve required attachments.
4. Build bounded retrieval query.
5. Retrieve and freeze selected evidence.
6. Optionally invoke repository agent.
7. Build prompt through `packages/prompts`.
8. Invoke analysis through metered AI execution.
9. Validate structured result.
10. Persist immutable analysis and evidence links.

Each stage records status and typed failure. Optional-stage failure is visible in the
result; required-stage failure prevents completion.

## Prompt contract

- Templates are immutable versions.
- Context sections have explicit token/character budgets.
- Untrusted source content is delimited and labeled as evidence, never instructions.
- Prompt hashes include template version, schema version, and selected evidence hashes.
- Output uses structured schema; model-authored HTML is rejected.
- Repair attempts are bounded and separately metered.
- Notices, destination rendering, and approval policy are not part of analysis prompts.

## Evidence rules

- Claims reference evidence IDs or are marked hypotheses.
- Code evidence includes repository, commit, path, line range, and excerpt hash.
- Knowledge evidence includes item/revision/chunk and source URL.
- Attachment evidence references derivative and processor/model versions.
- Invalid evidence references are rejected or reduce confidence before completion.

## Idempotency

Identity includes case revision, analysis profile version, selected repository commit, and
relevant immutable bindings. Force rerun creates a new attempt/result without replacing
history.

## Publication boundary

Analysis ends with structured data. `packages/publication` owns destination profile,
rendering, notices, approval, visibility, marker, and delivery.

## Minimum tests

- Stable idempotency identity.
- Context budget enforcement.
- Required versus optional stage failures.
- Structured validation and bounded repair.
- Evidence reference validation.
- Repository-disabled analysis.
- No destination invocation from analysis.

Avoid brittle tests that assert complete natural-language wording. Test structure,
evidence, budgets, and policy.
