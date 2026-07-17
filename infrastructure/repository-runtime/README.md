# Repository runtime infrastructure

**PBI:** 010

`AttestedRepositoryRuntime` composes injected checkout and sandbox implementations.
It permits the checkout secret reference only at the broker boundary, validates the
administrator-selected pinned tree and evidence, and provides the agent only an explicit
read-only tool gateway. Sandboxes must attest network, credential, filesystem, tool, and
quota isolation; timeout/cancellation terminates and cleans up the session.

Checkout material is bound into a runtime capability before a provider receives it.
Provider-visible calls contain only repository ID and exact commit, never a locator,
remote URL, local directory, or credential reference. The runtime resolves model
citations from the private prepared tree and derives exact excerpt hashes and evidence
IDs before returning at most 100 evidence-linked findings. Conventional credential files
and high-confidence literal credentials are omitted during tree preparation.

Agent prompting and model calls remain in provider/application layers.

`src/contracts.ts` is the inward-facing repository-runtime contract boundary. It keeps
checkout, sandbox, attestation, evidence, and failure contracts independent of the
outer local-Git/OCI adapter, so composition can replace that adapter without creating
an infrastructure-internal dependency cycle.

## Concrete local-Git/OCI core

`LocalGitPinnedRepositoryCheckoutBroker` is a deliberately narrow implementation
for administrator-mapped, server-local Git worktree roots. It verifies one exact full
commit SHA, reads only regular text blobs at that commit, and materializes them in a
new private tree. Its public result is an opaque tree identifier plus a path/line
manifest; it never contains a remote URL, local path, Git configuration, or checkout
secret reference. Oversized and non-text blobs are excluded, while symlinks,
submodules, and other non-regular Git entries fail closed.

This is not a remote/private-repository checkout solution. It intentionally has no
network or credential implementation and must not be used as a substitute for a
future server-private remote checkout broker.

That separate broker is now `GitCliPinnedRepositoryCheckoutBroker` in
`@caseweaver/git-repository-runtime`. It reuses hardened Git cache/AskPass mechanics,
then materializes only sanitized text into this private tree store and returns the same
opaque tree contract.

`DockerOciRepositorySandbox.create` is available only on a Linux worker with a local
Docker Engine Unix socket. It requires an immutable image digest and verifies that the
server reports Linux before returning an attesting sandbox. Each tool call runs a
new container with no network, a read-only root and repository mount, an empty process
environment, dropped capabilities, an unprivileged user, CPU/memory/PID/output bounds,
and only the bundled `listFiles`, `readFile`, and `searchFiles` JSON protocol. The
adapter fails closed when that host/runtime/image prerequisite is unavailable. An
operator must still supply a trusted, credential-free image; image provenance and
attestation verification belong to deployment delivery work, not this adapter.

Prepared files are written only in a private staging tree, then atomically published
as a read-only child tree (`0555` directories and `0444` regular files). Its random
parent remains `0700`; Docker mounts only the final child, so its fixed UID `65532`
can list/read the sanitized files without gaining host-tree traversal outside that
mount.

Every tool container receives a private name and is force-removed after completion or
cancellation. Creation verifies the local Linux Docker daemon and configured digest-pinned
image before attesting the enforced no-network, read-only, and unprivileged command shape.

The local broker and OCI sandbox share `LocalPreparedRepositoryTreeStore` only in
server composition. No browser, model tool, audit record, or `SanitizedPinnedTree`
contract receives the prepared directory path.
