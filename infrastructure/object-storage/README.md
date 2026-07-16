# Object-storage infrastructure

**PBI:** 008

Streaming attachment/blob storage ports with an in-memory test fixture, a secure
local-development filesystem adapter, and an S3-compatible production adapter.
References are workspace-scoped opaque handles; this package never returns object
URLs, presigned URLs, buckets, endpoints, or credentials.

Trusted server composition loads `OBJECT_STORAGE_*` configuration only. `local`
storage requires an absolute root and is rejected in production. `s3` storage uses
the AWS SDK default credential chain, requires HTTPS custom endpoints in production,
stages uploads with bounded multipart buffers, verifies SHA-256 before publication,
and removes incomplete uploads. It applies SSE-S3 `AES256` encryption to every
write by default; set `OBJECT_STORAGE_S3_ENCRYPTION=aws:kms` together with the
server-private `OBJECT_STORAGE_S3_KMS_KEY_ID` to use a KMS key reference. Object
keys contain an HMAC-derived workspace scope, not the workspace identifier. Reads
observe cancellation after response headers and close the underlying stream. The
local adapter confines paths to a canonical root, rejects symbolic links, uses
restrictive permissions, and publishes files atomically.

Derivative text writes are create-only. Local and in-memory adapters reject a second
write to an allocated derivative handle; S3 sends `If-None-Match: *`. This keeps a
sealed derivative object from being overwritten between output verification and
persistence. Consumers still independently verify the persisted SHA-256 and length.

Retention scheduling and durable retention work items are application/workflow
concerns. `BlobStoreRetentionObjectStore` bridges only a complete immutable
`{ workspaceId, storageBackendId, key }` identity to idempotent,
workspace-and-backend-validated deletion; it never infers a backend from runtime
configuration or accepts a bare storage key. This package also owns stale staging
cleanup.

No attachment interpretation or vision logic.
