# Engineering standards

## TypeScript

- Enable strict TypeScript and no unchecked indexed access.
- Avoid `any`, unsafe double casts, and unvalidated JSON.
- Parse all external input at boundaries with Zod.
- Use discriminated unions for capabilities, states, and typed failures.
- Keep provider and connector SDKs serializable where practical.

## Error handling

- No broad catch-and-success fallback.
- Errors identify category, retryability, external system, and safe operator message.
- Rate-limit and retry-after information is preserved.
- Background failures transition durable state before a worker releases the job.
- Cancellation is distinct from failure.

## Testing

Required test layers:

- domain unit tests,
- provider normalization tests,
- connector contract tests,
- PostgreSQL integration tests including pgvector,
- migration tests,
- attachment security fixtures,
- orchestration state-machine and lease tests,
- publication idempotency tests,
- and end-to-end Docker Compose tests.

AI-dependent tests use deterministic fakes by default. Optional live-provider tests are
explicitly enabled and budget-limited.

## Security

- Threat-model every new tool, connector, attachment parser, and publication capability.
- Dependencies processing untrusted files require active maintenance and size limits.
- Never log secrets or complete raw prompts by default.
- Repository-agent permission changes require security-focused tests.

## Documentation and compatibility

- Public SDK changes use semantic versioning.
- Connector contracts include compatibility tests.
- Database changes use forward migrations and documented rollback constraints.
- Architecture-changing choices receive an ADR.
- Feature documentation changes in the same pull request as behavior.

## Definition of done

A feature is not complete until:

- behavior and failure modes are implemented,
- durable state and idempotency are covered,
- usage and cost behavior is defined for every AI call,
- security boundaries are tested,
- public configuration and documentation are updated,
- and targeted tests pass.
