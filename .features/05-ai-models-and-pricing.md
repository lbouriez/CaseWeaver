# AI providers, model roles, and pricing

## Separation of concepts

- A **provider** knows how to authenticate and call an API.
- A **model** identifies capabilities and pricing metadata.
- A **model binding** assigns a configured provider/model to a CaseWeaver role.
- An **AI operation** is one attributable invocation.

Required roles:

- `embedding`
- `vision`
- `analysis`
- `repositoryAgent`

Optional roles:

- `keywordExtraction`
- `reranker`
- `chat`

Each role may use a different provider and model.

Bindings are selected by configuration scope. A workspace supplies defaults, while a
knowledge collection or analysis profile may select a different immutable binding for a
role. No orchestration code may branch on provider, endpoint, model, or agent-runtime
name.

Model bindings are immutable versions. A binding version includes role, provider
instance, endpoint or deployment, canonical model key, wire API, generation parameters,
capability snapshot, pricing selection, and secret-reference identity. Profiles, cache
keys, operations, and derivatives reference the exact binding version. Editing
configuration creates a new version.

## Provider interfaces

Provider-neutral ports must exist for:

```ts
interface EmbeddingProvider {}
interface VisionProvider {}
interface GenerationProvider {}
interface RepositoryAgentProvider {}
interface RerankerProvider {}
```

Interfaces return normalized output and normalized usage while preserving the encrypted
or redacted provider response needed for diagnostics. Provider-specific request options
must not leak into domain services; an explicitly typed extension bag may be attached to
a model binding.

Initial implementations:

- OpenAI-compatible generation, embedding, and vision.
- Native Azure OpenAI where its authentication or API shape requires it.
- GitHub Copilot SDK repository agent using BYOK.

Copilot SDK BYOK supports OpenAI-compatible endpoints through provider type `openai`,
with configurable `baseUrl`, API key or bearer token, and `completions` or `responses`
wire APIs. CaseWeaver must not require GitHub Copilot authentication or subscription.
Copilot SDK remains one `RepositoryAgentProvider`; a different agent runtime must be
replaceable without changing orchestration.

The repository-agent runtime and its underlying agentic model are separate configuration
concerns. For example, Copilot SDK may orchestrate a BYOK OpenAI-compatible model, while
another `RepositoryAgentProvider` may use a different runtime and provider entirely.

## Model catalog

CaseWeaver maintains a local model catalog containing:

- provider and canonical model key,
- supported roles and capabilities,
- maximum input and output tokens,
- vision, tool, structured-output, and prompt-cache support,
- pricing source and source revision,
- effective date and optional deprecation date.

Binding creation validates that the selected catalog entry supports the assigned role,
required capabilities, and configured context/output limits.

## LiteLLM pricing import

The default catalog importer consumes LiteLLM's MIT-licensed
`model_prices_and_context_window.json`. The upstream file includes a `sample_spec` and
model entries with fields such as:

- `input_cost_per_token`
- `output_cost_per_token`
- `cache_read_input_token_cost`
- `cache_creation_input_token_cost`
- `max_input_tokens`
- `max_output_tokens`
- `mode`
- `litellm_provider`
- capability flags such as `supports_vision` and `supports_prompt_caching`

The upstream structure is not a stable CaseWeaver API. Imports must:

1. Validate through a permissive Zod schema.
2. Preserve unknown fields for forward compatibility.
3. Record the upstream URL, commit SHA, fetch time, and content hash.
4. Convert supported prices to CaseWeaver's normalized per-unit representation.
5. Reject negative, non-finite, or ambiguous values.
6. Never update production pricing implicitly during a model call.

A release may ship a pinned catalog snapshot. Administrators may explicitly refresh it.

## Override precedence

From highest to lowest:

1. Workspace model-binding override.
2. Installation-level override.
3. Imported LiteLLM catalog value.
4. Unknown.

Provider-reported billed cost is stored separately from estimated cost; it does not erase
the price calculation inputs.

Pricing is represented as components with:

- billing unit,
- price and currency,
- effective interval,
- source revision,
- and applicable conditions such as provider region, service tier, batch mode, context
  tier, media type, or token threshold.

An override can set input, output, cache-read, cache-creation, image, audio, or other
supported components and must include conditions, currency, effective time, and
operator/source. Precedence is applied independently to each pricing component. When
multiple overrides at the same scope overlap, the most specific applicable condition
wins, followed by latest effective time; unresolved ties are configuration errors.

The initial release enforces budgets in one configured installation currency. Automatic
foreign-exchange conversion is not performed.

Unknown price is never interpreted as zero. A role with hard budget enforcement cannot
run with unknown applicable pricing unless the administrator explicitly allows it.
If an applicable upstream pricing condition is unsupported, calculation is incomplete
or unknown rather than silently using a partial base price.

## Usage normalization

Capture when available:

- uncached input tokens,
- cache-read input tokens,
- cache-creation input tokens,
- output tokens,
- reasoning tokens,
- image/audio units,
- provider request ID,
- latency and retry count.

Cost records store raw usage, normalized usage, catalog revision, applied overrides,
estimated cost, provider-reported cost, and calculation status.

## Budget reservations

Hard budgets use transactional reservations across operation, analysis, day, and
workspace scopes. An upper-bound amount is reserved before each provider request and is
reconciled or released afterward. Retry, timeout, cancellation, missing-usage, and
provider-overage behavior is recorded explicitly.

Repository agents may make several model turns. Each underlying request must receive
budget authorization and an AI operation record. Agent profiles also limit turns, tool
calls, elapsed time, and total tokens. If an agent provider cannot expose reliable
per-turn usage, CaseWeaver stores an aggregate estimate and cannot claim strict monetary
budget enforcement for that binding.
