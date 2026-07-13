# Testing strategy

## Principle

Test risks and contracts, not every line. CaseWeaver does not require a global 100%
coverage target. A small number of meaningful tests is preferred over large brittle
suites.

## Unit tests

Use for deterministic logic with important branches:

- state machines and invariants,
- canonical hashes and idempotency identities,
- schedule calculation,
- chunking and score fusion,
- pricing/budget calculation,
- authorization policy,
- prompt/context budgets,
- and result validation.

Do not unit-test trivial constructors, getters, constant mappings, or framework wiring.

## Contract tests

Write one reusable suite per public adapter family:

- connector capabilities,
- AI providers,
- repository-agent providers,
- object storage/runtime where implementations vary.

Each adapter runs the shared suite plus a few vendor-specific cases. Contract tests are
the main protection for reusability.

## Integration tests

Use real PostgreSQL/pgvector for:

- migrations and constraints,
- repositories and transactions,
- hybrid search,
- leases and concurrency,
- inbox/outbox and queue recovery,
- budget reservations,
- and workspace isolation.

Use deterministic fake remote systems. Do not mock Prisma for database behavior.

## End-to-end tests

Keep a small critical set:

1. Unchanged knowledge synchronization performs no embedding.
2. Changed source reaches searchable knowledge and evidence-backed analysis.
3. Verified webhook reaches analysis/publication exactly once.
4. Failure/restart recovers durable queued work.

Additional E2E tests require a distinct production risk.

## AI tests

- Default tests use deterministic fake providers.
- Provider adapters use recorded sanitized fixtures and optional live smoke tests.
- Live tests are opt-in, budget-capped, and excluded from normal CI.
- Test structured output and evidence, not natural-language wording.
- Prompt golden files are used only for stable structural sections.

## Security tests

Maintain focused fixtures for webhook forgery, workspace leakage, path traversal, archive
bombs, prompt injection boundaries, credential isolation, and publication duplication.

## Test placement

- Unit tests beside source.
- Shared conformance suites in `tests/contract`.
- PostgreSQL/composition tests in `tests/integration`.
- Critical workflows in `tests/e2e`.

## Definition of sufficient

A change has enough tests when its important success path, failure behavior, boundary
contract, and regression risk are covered. Reviewers should reject both untested critical
logic and redundant low-value tests.
