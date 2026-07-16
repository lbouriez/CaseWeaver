# Analysis worker feature module

This module adapts a prebuilt analysis execution service to the durable worker
command boundary. `production-factory.ts` is the feature-owned assembly point:
it accepts all real analysis ports explicitly and creates an
`AnalysisOrchestrator` service. It does not create defaults, load environment
configuration, open PostgreSQL, register queues, or manage process lifecycle.

The PBI-013 host/integration composition supplies the PostgreSQL stores,
frozen evidence adapters, retained-binding tokenizer resolver, exclusive AI
gateway, and exact immutable repository-runtime execution projection before it
registers this handler. That projection contains no checkout locator.
`repository-investigation.ts` validates the retained runtime and binding pin
before dispatching only through `ai-execution`, retaining no model summary or
source excerpt. `pinned-repository-runtime.ts` is the optional
Linux local-Git/digest-pinned-OCI composition for a provider adapter; it binds
the existing attested checkout/sandbox implementation to that exact pin and
has no direct provider call. Tests may use deterministic ports outside that
production path.
