---
sidebar_position: 8
title: AI configuration and cost
---

# AI configuration, inventory, and cost

**Availability:** provider configuration is descriptor-driven. The browser supplies no
key, provider response, or direct model invocation.

## Configure an OpenAI-compatible provider

1. Register an opaque credential locator in **Access & security**, for example
   `env:CASEWEAVER_OPENROUTER_KEY` when that name is available to the server secret
   backend. It is a reference, not an API key value.
2. In **AI configuration**, create a provider draft from the registered
   OpenAI-compatible descriptor. Use an HTTPS API base endpoint and choose its immutable
   protocol mode (embeddings, chat completions, or responses) deliberately.
3. Review and activate the draft. Activation makes a safe provider identity eligible for
   the next server-owned step; it does not prove every model is available.
4. Choose **Refresh models available from provider**. The server calls the provider and
   persists a bounded, workspace-scoped inventory tied to that exact provider version.
5. Create an immutable binding from a model in that inventory, select its CaseWeaver
   role, then configure price/budget policy and use the guarded capability test.

The trusted LiteLLM catalog is a separate pricing/capability source. Refreshing it does
not make a global catalog model available from a provider. An exact price match enriches
the provider inventory; an unmatched model has **unknown** price. Unknown price is never
zero and cannot satisfy a hard-budget test without a deliberate, complete pricing
override for that same provider-owned model.

Use an embeddings instance for embedding work and a distinct chat/responses instance for
generation when the provider requires it. The capability test is server-owned,
confirmation-bound, rate-limited, budget-gated, and executed only through
`@caseweaver/ai-execution`.

## Binding, budget, and history

A binding selects a provider model for a role; a role default chooses an active binding;
a collection/profile/recipe pins a binding version for work. Price components must cover
the role's units: input tokens for embeddings/reranking, input and output tokens for
generation, and image units for vision. Costs and unknown-price states are queryable,
but provider credentials and raw account/model data are not.

The optional Copilot SDK BYOK repository-agent descriptor remains a separate,
policy-bounded repository runtime. It is not a substitute for an embedding or chat
binding and is never called directly by a feature package.
