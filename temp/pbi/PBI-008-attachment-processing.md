# PBI-008: Secure attachment processing

## Outcome

Safely convert supported case and knowledge attachments into reusable text derivatives.

## Existing implementation reference

Inspect `C:\GIT\Nectari\Scripts\Cloud\Modules\HelpDeskHelper.psm1` before
implementation, specifically `Get-JitbitTicketAttachments`,
`Invoke-TicketAttachmentAnalysis`, and `New-TicketSummary`. They document attachment
discovery from ticket and comment HTML, Jitbit attachment downloads, image-to-text
enrichment, text-file context, archive handling, and temporary-file cleanup in the
current solution.

This is behavioral reference material only. PBI-008 must replace its in-process,
connector-specific behavior with source-neutral streaming, cache identities,
workspace/access isolation, hardened archive handling, isolated processing, and
metered AI execution as defined in `.features/18-attachments-guide.md`.

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
- Parsers execute outside the privileged worker with workspace-scoped inputs/outputs and
  no network or credentials.
- Temporary files are cleaned after success, failure, timeout, and cancellation.
- Vision usage and cost link to the attachment and analysis/source job.

## Excluded

PDF/Office extraction and OCR beyond configured vision behavior.
