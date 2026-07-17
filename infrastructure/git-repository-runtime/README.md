# Git repository runtime infrastructure

**PBI:** 005, 020

`@caseweaver/git-repository-runtime` is the outer adapter that implements the
Git/Markdown connector's injected `GitRepository` port. It owns Git CLI process
execution, a worker-owned bare HTTPS cache, short-lived AskPass credentials, and
local-worktree containment checks. The connector remains responsible for Git source
configuration, Markdown parsing, discovery policy, and secret-reference resolution.

## Security boundary

- Every Git command is executed through an injected process runner with `shell: false`.
- Remote URLs must be credential-free HTTPS URLs. Resolved tokens are supplied only in
  the ephemeral AskPass environment; they are never placed in a URL, command argument,
  Git configuration, error, or log.
- Terminal prompts, inherited Git configuration, credential helpers, hooks, file and
  external protocols are disabled. The adapter reports bounded, generic connector
  errors rather than forwarding Git stderr.
- A remote cache contains bare repositories only and is supplied by trusted worker
  composition. The adapter never checks out a remote worktree.
- Local paths and every configured root are canonicalized again at runtime. The resolved
  Git worktree must remain within an allowed root, including after symlink resolution.
- Discovery resolves a branch/tag to a full commit, or verifies an administrator-selected
  full commit object ID directly. Text, binary, and diff reads verify and use that exact
  commit SHA, never a mutable ref. Binary reads keep their private
  Git session (including the ephemeral AskPass helper) alive for the lifetime of the
  bounded stream, then remove it.

## Git/Markdown attachment reopening

`AesGcmGitMarkdownAttachmentLocatorCodec` seals connector-owned Git/Markdown attachment
addresses as stateless AES-256-GCM tokens. Trusted deployment configuration supplies one
active key and may retain decrypt-only rotated keys; no process-local lookup, database
side channel, public URL, repository path, credential, or locator is required to reopen
a retained occurrence. The token is server-private and must never be placed in API
responses, logs, traces, diagnostics, audit payloads, or browser state.

`GitMarkdownAttachmentDispatcher` validates an occurrence's bounded external reference,
sealed locator, connector, document, ordinal, and relation before routing. Repository
files go back through the connector's exact-commit `GitMarkdownAttachmentSource`; a
sealed public-image address goes only to `SecurePublicHttpsImageAttachmentOpener`.

The public-image opener accepts only credential-free HTTPS URLs on port 443, resolves
every initial/redirect host before connecting, rejects private/link-local/loopback,
reserved, multicast, IPv4-mapped, NAT64, native 6to4, and the deprecated 6to4 relay
block (`192.88.99.0/24`), and pins Node's connection
to the screened literal address to prevent DNS rebinding. It revalidates every redirect,
uses no connection pool, enforces redirect/DNS/timeout/byte limits, requests identity
encoding, permits a narrow image MIME allowlist, streams bytes without buffering the
whole image, and emits only generic typed failures. The attachment pipeline still owns
authoritative MIME detection, hashing, storage, and derivative policy.

## Composition

Trusted composition creates one `GitCliRepository` with a private worker cache and
injects it through `createGitMarkdownRuntimeContribution` from
`@caseweaver/connector-git-markdown`. For Git/Markdown attachments it also creates one
key-rotatable sealed locator codec, the public-image opener, and a dispatcher that wraps
the connector's repository-file source. The cache, temporary directories, locator keys,
and public-image limits must be deployment-owned and must not be browser- or
tenant-controlled.

The default Node runner is intentionally injectable so package tests can prove command
shape and credential handling without invoking Git or a network. A host may supply a
different process runner only if it preserves the same no-shell, cancellation, bounded
output, and no-secret-observability guarantees.

## Repository-agent checkout

`GitCliPinnedRepositoryCheckoutBroker` maps a server-selected repository ID to a
credential-free HTTPS remote and trusted branch/tag (or a full configured commit). It resolves the checkout secret only
at the existing AskPass boundary, verifies the fetched ref still resolves to the retained
full commit, and verifies each returned blob's path, object ID, and commit against the
inspected exact-commit manifest before materializing bounded sanitized UTF-8 files into a
private prepared tree.
Its returned tree carries only opaque ID, repository ID, commit, and path/line manifest—
never remote URL, local directory, credential, or secret reference.
