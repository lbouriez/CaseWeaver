# Connector SDK

**PBI:** 006

`@caseweaver/connector-sdk` supplies vendor-neutral contracts for `KnowledgeSource`,
`CaseSource`, `AttachmentSource`, `AnalysisDestination`, and `WebhookAdapter`.

## Public API

- Zod schemas for normalized cases, messages, visibility, actors, access, resolution,
  attachment metadata and occurrences, references, cursors, and opaque fingerprints.
- Snapshot discovery pages with a stable scan epoch and completion marker, plus delta
  pages with explicit upsert/tombstone events.
- Capability registry: an undeclared capability resolves to `undefined`; it is never
  fabricated.
- Abort-signal operations, opaque cursor pagination, safe connector errors preserving
  retryability, retry-after, and request IDs, and a separate cancellation error.
- Versioned configuration envelopes that hold secret references only, plus redacted
  diagnostics, an in-memory test secret resolver, and source synchronization-policy
  schemas (manual, cron, interval, or webhook triggers).
- Canonical UTF-8 SHA-256 case revisions. Object keys are sorted, array order remains
  significant, and connector metadata, observation time, and original bodies are
  omitted. Attachment occurrences participate in a revision when present, while a
  rotated server-private reopen locator does not.
- Generic fixtures for Jitbit-shaped and Odoo-shaped inputs, fingerprint strategies,
  missing capabilities, and deterministic pagination.

Connectors validate vendor input at their boundary, map it to these schemas, and do not
return vendor SDK objects or add vendor fields to normalized cases.

## Attachment occurrences

`AttachmentMetadata` remains the legacy, reference-only declaration used by existing
connectors. New attachment-capable connectors should also emit `AttachmentOccurrence`
records at their real owner: a knowledge document, a case, or a case message. An
occurrence retains a connector-scoped attachment reference, a stable ordinal, and one
neutral relationship (`declaredAttachment`, `inlineImage`, or `inlineFile`), plus only
optional safe declared metadata.

Each occurrence has a versioned `AttachmentOpenIdentity` with an opaque locator. This
is server-private connector/runtime data used only when a trusted `AttachmentSource`
reopens the bytes. The locator accepts URL-safe opaque tokens only, up to 16,384
characters to support durable encrypted attachment addresses; it is never a URL, local
path, credential, browser value, API DTO, log field, or trace attribute. The
streaming `AttachmentSource` port remains unchanged; `OpenAttachmentRequest.identity`
is optional for existing sources and supplied for occurrence-aware reopen operations.

The normalized case/document schemas reject cross-connector references, duplicate case
message external IDs, occurrences whose owner does not match their containing
case/document/message, and duplicate ordinals for one owner. Connector-specific
attachment fields remain outside this SDK.
