# OpenAI-compatible provider

**PBI:** 003

Boundary-only embedding, vision, and generation adapter for configurable
OpenAI-compatible endpoints. It uses safe `fetch`, validates configuration and responses,
normalizes usage and provider identifiers, and propagates cancellation. It does not
choose bindings, resolve secrets, reserve budgets, calculate costs, or persist operations.
