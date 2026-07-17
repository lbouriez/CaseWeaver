# AI SDK

**PBI:** 003

Provider-neutral contracts for embedding, vision, generation, reranking, and repository
agents. It exposes normalized usage, provider metadata, typed safe errors, cancellation,
and deterministic test dispatchers. It contains no provider SDK imports, pricing policy,
binding selection, or persistence behavior.

Provider-owned model tokenizer contributions are also declared here. They construct a
counter only from an already-selected immutable binding; selection/caching belong to
outer runtime composition and a missing contribution is a configuration failure.

Repository-agent requests declare per-turn token limits. Their results explicitly state
whether usage is a whole-run aggregate or observable turns, while the shared runtime
port keeps administrator-selected repositories and read-only tools vendor-neutral.

`RepositoryAgentRuntimePin` identifies the exact workspace-scoped runtime version,
repository, and commit retained by an analysis. A
`PinnedRepositoryAgentRuntimeResolver` resolves that pin only on the server and must
never replace it with a current/default configuration. The resolver's result may carry
an opaque checkout-secret reference, but it is for the checkout broker alone: browser,
case, prompt, model-tool, and audit contracts must not receive a checkout endpoint,
filesystem location, or secret value.

Provider-visible repository calls use `OpaqueRepositoryRuntime` with only repository ID
and pinned commit. Server composition binds private checkout material before returning
the executable runtime capability. Provider citations/findings are unverified and bounded;
only the isolated runtime can turn them into deterministic evidence IDs and exact excerpt
hashes.

`RepositoryAgentResult.evidence` contains runtime-validated pinned-tree locations,
deterministic IDs, and excerpt hashes. Its findings reference that verified evidence and
are capped at 100. Provider adapters must not return source excerpts, checkout metadata,
or credential material; worker composition governs retained model text downstream.
