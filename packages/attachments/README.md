# Attachments

**PBI:** 008

Attachment identity, MIME policy, processor selection, derivative caching, vision/text
normalization, archive limits, and cleanup orchestration.

Binary storage and isolated processor execution are infrastructure ports. Blob
handles are workspace-scoped, opaque server references with a deployment storage
backend identifier; they never contain a bucket, endpoint, credential, or
browser-accessible URL. The attachment package opens bounded blob streams through
the port and does not construct object-store URLs. Vision policies must provide a
positive server-configured `maximumInlineBytes`; image content above that limit is
rejected before a claim or output allocation, and streaming rechecks the limit
before holding bytes to build the provider request.

Before a derivative can be marked complete, this package independently reopens its
stored output and seals the exact canonical UTF-8 bytes with a SHA-256 and length.
It never repairs noncanonical processor output after writing it. The resulting
server-private derivative record is the only storage-identity boundary consumed by
frozen analysis evidence; legacy derivatives without verified metadata fail closed.

## Preparation result boundary

`AttachmentPreparationPolicy` pins `disabled`, `optional`, or `required` attachment
handling with an immutable policy version and an access-policy hash. The package's
`createAttachmentPreparationResult` produces an order-independent identity over that
policy, selected completed derivative identities/content hashes, and bounded typed
warnings. The safe `outcome` intentionally contains no blob key, object-store URL,
connector locator, local path, source text, or secret. Derived searchable text remains
server-private work input for knowledge chunking and analysis prompt construction.

Optional warnings keep the source usable but set `retryRequired` when a retry may add
evidence; required warnings make the outcome terminal. Disabled preparation has no
derivatives or warnings. The knowledge package consumes the matching structural port
without importing this sibling feature package, preserving the inward dependency rule.

## Stable occurrence preparation

`prepareAttachmentOccurrences` prepares attachments before a knowledge revision or
finalized case snapshot exists. Its stable subject is a `sourceDocument` or
`caseCapture`; every `AttachmentOccurrenceDescriptor` keeps its own immutable
identity, ordinal, relation, and requiredness even when identical bytes reuse a
derivative-cache record. The plan identity intentionally covers only those safe values
and the pinned policy—not external references, reopen locators, blob keys, URLs, or
paths.

The coordinator validates the subject kind, pinned preparation mode, boolean
requiredness, unique occurrence identities, and unique occurrence ordinals before it
derives a plan identity or claims a durable attempt. Malformed inputs therefore cannot
create a retryable durable record.

`ServerPrivateAttachmentOccurrence` is the only input that carries connector opening
material. The coordinator passes its optional opaque `AttachmentOpenIdentity` only to
the existing `AttachmentSource` port before using the normal streaming intake and
`processAttachment` flow. Images therefore remain metered `ai-execution` work, while
text and archives retain the isolated-runtime path. Its returned execution contains no
opening material; selected evidence text remains server-side input only.

`AttachmentPreparationAttemptStore` is the inward persistence contract for a fenced,
immutable durable attempt. A future adapter must atomically finalize the safe outcome
and all server-private occurrence evidence under its fence, reject stale finalizers,
and create a new attempt chained to the old one for retry. This package deliberately
does not choose a database schema or persistence technology.
