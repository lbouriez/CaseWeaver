# Live attachment preparation worker module

This module is the worker-side composition boundary for live attachment
preparation. It has no connector-, database-, storage-, or AI-provider-specific
branch. Instead, it resolves a declared `AttachmentSource` through the exact
immutable connector configuration pin supplied by durable knowledge or case
work, then delegates bytes and derived text to `@caseweaver/attachments`.

Every normalized attachment occurrence receives a deterministic CaseWeaver
attachment ID and is reserved before streaming begins. The reservation and
occurrence-persistence ports are deliberately narrow: the worker never imports
PostgreSQL implementation types. Distinct occurrences may share one attachment
ID (and therefore a derivative cache entry), while retaining their distinct
occurrence identities for immutable evidence. Each descriptor also preserves a
SHA-256 `ownerIdentity` and the connector's original owner-local
`sourceOrdinal`; its `ordinal` is instead the deterministic globally unique
preparation sequence required when multiple case/message owners all use ordinal
zero.

`LiveKnowledgeAttachmentPreparation` implements the knowledge feature's
attachment port. The port itself carries the exact source configuration and
connector configuration pins selected by the durable knowledge command; it
never resolves a mutable current configuration. An injected processing-policy
resolver is invoked for the supplied immutable attachment policy immediately
before preparation. Knowledge passes its exact source configuration version to
that resolver; case capture passes only its immutable case policy. The resolver
must fail closed when those exact policy inputs cannot be resolved.
`LiveCaseAttachmentPreparation` is used before case capture and returns only
the safe terminal outcome plus opaque attempt ID; it never returns attachment
text, locators, URLs, paths, or storage handles. Required case preparation fails
closed after the terminal attempt is persisted; optional preparation returns its
bounded safe warnings.

Completed attempts retain safe derivative identities, not plaintext. A trusted
`PreparedAttachmentTextReader` is therefore required only when a knowledge
ingestion retry reuses a completed attempt and needs private text to build
evidence chunks. It must validate the exact selected derivatives and must never
be exposed outside worker composition.

Cancellation is propagated as the safe `AttachmentCancelledError` from the
attachments package. The worker does not surface an abort reason or translate a
cancelled command into a retryable runtime-unavailable failure.

`index.ts` is the deliberately small worker composition surface. Process
bootstrap may compose these ports with PostgreSQL, object storage, isolated
runtime and AI-execution adapters, but neither HTTP nor browser code may import
this module.
