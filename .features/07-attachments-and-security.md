# Attachments and security

## Attachment identity and caching

Every attachment records:

- connector-scoped external attachment ID,
- original and sanitized filename,
- declared and detected MIME type,
- byte size,
- SHA-256 content hash,
- source case or knowledge revision,
- and storage reference.

Derived content is keyed by content hash, processor type/version, model binding, and
prompt version. Connector attachment IDs provide traceability, while the content hash
allows identical files from different systems or cases to reuse work.

Attachment references and derivatives are workspace and access-policy scoped. A binary
blob may be globally deduplicated internally only when separate authorized references,
retention, and deletion behavior are preserved. Cache eligibility also includes the
processor security-policy version.

## Initial processors

- Images: PNG, JPEG, GIF, WebP, and other explicitly supported formats through vision.
- Text: plain text, logs, CSV, JSON, XML, INI, and configuration files.
- ZIP: recursively process allowed contained files within strict limits.
- Unknown or unsupported formats: preserve metadata and record a typed skip reason.

All files are identified through content inspection, not filename extension alone.
Archive, image, and structured-text processors run in an isolated networkless process or
container with filesystem, CPU, memory, output, and duration quotas.

## Required limits

Configuration must cover:

- maximum attachment bytes,
- maximum expanded archive bytes,
- maximum compression ratio,
- maximum file count,
- maximum nesting depth,
- maximum extracted file bytes,
- processor timeout,
- allowed MIME types,
- and maximum derivative text length.

Archive paths are canonicalized and must remain inside the extraction root. Symbolic
links, devices, absolute paths, parent traversal, and encrypted archives are rejected by
default.

## Vision behavior

Vision prompts are versioned and optimized for support evidence: visible error text,
user intent, UI state, configuration values, and relevant visual anomalies. The result
is stored as an attachment derivative and is always available to retrieval and case
analysis; it must not depend on an image being embedded in HTML.

## Trust boundaries

Case descriptions, comments, documents, attachments, and extracted files are untrusted.
They may contain prompt injection or malicious payloads.

Repository preparation and agent execution are separate trust stages:

1. A checkout broker uses repository credentials to resolve an administrator-configured
   repository and commit, then emits a sanitized tree without credentials or authenticated
   remote configuration.
2. The tool sandbox receives only that tree and has no network or credentials.
3. Model traffic is performed by the orchestrator or through endpoint-restricted egress
   that the tool sandbox cannot control.

The repository agent must run with:

- a pinned repository and commit,
- a disposable worktree or isolated container,
- read-only repository access,
- an explicit tool allowlist,
- no inherited process credentials,
- no write, commit, push, issue, or pull-request capability,
- no network by default,
- bounded CPU, memory, output, and duration,
- and a scrubbed environment.

Case content cannot select repository URLs, provider endpoints, egress destinations, or
secret references.

The model is instructed that evidence is data, not instruction, but prompt text is not
considered a security boundary.

## Secrets and privacy

- Connector configuration stores secret references, not plaintext values.
- Logs and traces redact credentials and configurable sensitive fields.
- Raw prompts, tool transcripts, and model responses have configurable retention.
- Administrators can disable storage of raw case content while retaining hashes,
  structured results, and usage.
- Access metadata must be enforced before retrieval and MCP exposure.
