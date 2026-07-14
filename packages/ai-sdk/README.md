# AI SDK

**PBI:** 003

Provider-neutral contracts for embedding, vision, generation, reranking, and repository
agents. It exposes normalized usage, provider metadata, typed safe errors, cancellation,
and deterministic test dispatchers. It contains no provider SDK imports, pricing policy,
binding selection, or persistence behavior.

Repository-agent requests declare per-turn token limits. Their results explicitly state
whether usage is a whole-run aggregate or observable turns, while the shared runtime
port keeps administrator-selected repositories and read-only tools vendor-neutral.
