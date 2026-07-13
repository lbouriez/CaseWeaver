# Attachments implementation guide

## Purpose

Safely transform untrusted binary content into reusable, attributable text derivatives.

## Pipeline

1. Stream download with maximum byte limit.
2. Compute SHA-256 while streaming.
3. Detect MIME from content.
4. Persist workspace-scoped attachment reference/blob.
5. Select processor from detected MIME and policy.
6. Check derivative cache.
7. Execute parser in isolated attachment runtime.
8. For vision, call metered AI execution.
9. Validate/truncate derivative and persist provenance.

Never load an unbounded attachment fully into worker memory.

## Derivative identity

Cache key includes:

- workspace/access-policy scope,
- content hash,
- processor type/version,
- processor security-policy version,
- normalization version,
- and vision binding/prompt versions when applicable.

Global blob deduplication may exist behind authorized workspace references, but derivative
visibility and retention never cross access boundaries.

## Runtime isolation

Archive, image, and structured-text parsers run outside the privileged worker with:

- no network or credentials,
- disposable filesystem,
- canonical path confinement,
- no symlink/device traversal,
- CPU/memory/time/output limits,
- archive file-count/depth/expanded-size/compression-ratio limits,
- and workspace-scoped inputs/outputs.

## Processor behavior

- Text processors validate encoding and cap normalized output.
- CSV/JSON/XML processors do not execute formulas, entities, scripts, or external
  references.
- ZIP processing recursively handles only allowed content within limits.
- Vision prompts target visible support evidence and are immutable versions.
- Unsupported content records a typed skip reason.

## Failure policy

Failures are attached to the source/case and do not disappear. Analysis/source policy
decides whether a derivative is required. Retry reuses completed work and cleans every
temporary artifact.

## Minimum tests

- Streaming size rejection.
- MIME mismatch.
- Content-addressed cache hit.
- Cross-workspace access denial.
- Prompt/model/security-version cache invalidation.
- Zip Slip, symlink, archive bomb, deep nesting, and excessive file fixtures.
- Timeout/cancellation cleanup.
- Vision call attribution and cost.

Use a focused malicious fixture set; do not generate hundreds of redundant archive
variants.
