# Git repository runtime infrastructure

**PBI:** 005

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
- Discovery resolves a branch/tag to a full commit. Reads and diffs verify and use that
  exact commit SHA, never a mutable ref.

## Composition

Trusted composition creates one `GitCliRepository` with a private worker cache and
injects it through `createGitMarkdownRuntimeContribution` from
`@caseweaver/connector-git-markdown`. The cache and temporary directories must be
owned by the worker identity and must not be browser- or tenant-controlled.

The default Node runner is intentionally injectable so package tests can prove command
shape and credential handling without invoking Git or a network. A host may supply a
different process runner only if it preserves the same no-shell, cancellation, bounded
output, and no-secret-observability guarantees.
