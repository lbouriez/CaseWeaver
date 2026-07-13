# Connector SDK

**PBI:** 006

`@caseweaver/connector-sdk` supplies vendor-neutral contracts for `KnowledgeSource`,
`CaseSource`, `AttachmentSource`, `AnalysisDestination`, and `WebhookAdapter`.

## Public API

- Zod schemas for normalized cases, messages, visibility, actors, access, resolution,
  attachments, references, cursors, and opaque fingerprints.
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
  omitted.
- Generic fixtures for Jitbit-shaped and Odoo-shaped inputs, fingerprint strategies,
  missing capabilities, and deterministic pagination.

Connectors validate vendor input at their boundary, map it to these schemas, and do not
return vendor SDK objects or add vendor fields to normalized cases.
