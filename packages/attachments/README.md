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
