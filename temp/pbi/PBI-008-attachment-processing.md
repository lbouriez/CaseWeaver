# PBI-008: Secure attachment processing

## Outcome

Safely convert supported case and knowledge attachments into reusable text derivatives.

## Scope

- Streaming download, MIME detection, SHA-256 identity, and optional object storage.
- Workspace/access-policy-scoped attachment references and derivatives.
- Vision processor with versioned prompt and immutable model binding.
- Text/log/CSV/JSON/XML/config processors.
- ZIP extraction with all configured limits.
- Isolated networkless processor runner with resource quotas.
- Derivative cache including processor and security-policy versions.
- Typed skip/failure records, retention, and cleanup.

## Acceptance criteria

- Identical authorized content can reuse processing without crossing workspace/access
  policy boundaries.
- A changed vision prompt, model binding, processor, or security policy creates a new
  derivative.
- Standalone images always reach case analysis as evidence.
- Zip Slip, archive bombs, excessive nesting, symlinks, and unsupported MIME fixtures are
  rejected.
- Temporary files are cleaned after success, failure, timeout, and cancellation.
- Vision usage and cost link to the attachment and analysis/source job.

## Excluded

PDF/Office extraction and OCR beyond configured vision behavior.
