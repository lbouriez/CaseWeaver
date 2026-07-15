# OpenAI-compatible provider

**PBI:** 003

Boundary-only embedding, vision, and generation adapter for configurable
OpenAI-compatible endpoints. It uses safe `fetch`, validates configuration and responses,
normalizes usage and provider identifiers, and propagates cancellation. It does not
choose bindings, resolve secrets, reserve budgets, calculate costs, or persist operations.

Its exported administration descriptor is safe metadata registered at API composition
for dynamic console discovery. It exposes secret references rather than API keys, and
all actual AI calls continue to flow through `packages/ai-execution`.
