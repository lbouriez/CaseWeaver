# AI provider runtime composition

**PBIs:** 011, 013, 016, 021

This outer composition package selects a server-side AI provider dispatcher from
registered provider contributions. It has no administration, HTTP, persistence,
or feature-policy dependency. A host supplies provider-type contributions from
provider packages and routes all AI work through `@caseweaver/ai-execution`.

`EnvironmentAiSecretResolver` is the deliberately narrow open-source default:
it resolves only `env:UPPERCASE_NAME` opaque references. It never logs, returns
to transport, or persists a secret value. Deployments that use a vault or KMS
replace it through the `ai-sdk` `SecretResolver` port.

`RegisteredAiProviderModelDiscovery` is the separate server-only registry for a
provider's `/models`-style metadata endpoint. It resolves an opaque reference only for
the bounded discovery call and returns safe normalized model metadata for immutable
provider-inventory persistence. It is not an inference gateway, does not reserve AI
budgets, and never returns raw provider metadata or credentials to administration/UI.

`RegisteredAiModelTokenizerResolver` selects a provider-owned tokenizer from the exact
immutable binding already resolved by persistence. It has no default encoding and never
makes a provider request; a missing or invalid contribution fails execution closed.
