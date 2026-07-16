# AI provider runtime composition

**PBIs:** 011, 013, 016

This outer composition package selects a server-side AI provider dispatcher from
registered provider contributions. It has no administration, HTTP, persistence,
or feature-policy dependency. A host supplies provider-type contributions from
provider packages and routes all AI work through `@caseweaver/ai-execution`.

`EnvironmentAiSecretResolver` is the deliberately narrow open-source default:
it resolves only `env:UPPERCASE_NAME` opaque references. It never logs, returns
to transport, or persists a secret value. Deployments that use a vault or KMS
replace it through the `ai-sdk` `SecretResolver` port.

`RegisteredAiModelTokenizerResolver` selects a provider-owned tokenizer from the exact
immutable binding already resolved by persistence. It has no default encoding and never
makes a provider request; a missing or invalid contribution fails execution closed.
