# Domain and application implementation guide

## Purpose

`packages/domain` defines what CaseWeaver is. `packages/application` defines what the
system can do. Neither package knows how PostgreSQL, HTTP, Git, Jitbit, OpenAI, Copilot,
or another tool works.

## Domain rules

- Entities protect invariants through constructors/factories and explicit methods.
- Identifiers are opaque branded values, not interchangeable strings.
- Times are UTC instants. Inject `Clock`; do not call the system clock in domain logic.
- Monetary values carry amount and currency and never use floating-point arithmetic.
- State transitions use discriminated unions or explicit transition methods.
- External identifiers are always scoped by workspace and connector instance.
- Immutable revisions, binding versions, profiles, snapshots, and analysis results are
  never updated in place.
- JSON metadata is validated at the boundary and represented as `unknown` until parsed.

Do not create an anemic global `BaseEntity`, generic `Repository<T>`, or generic event
bus abstraction that hides domain semantics.

## Application contracts

Application use cases receive commands or queries and return typed results:

```ts
interface CommandHandler<C, R> {
  execute(command: C, context: ExecutionContext): Promise<R>;
}

interface ExecutionContext {
  requestId: RequestId;
  workspaceId: WorkspaceId;
  principal: Principal;
  signal: AbortSignal;
}
```

Exact names may evolve, but every use case must have:

- validated input,
- explicit authorization,
- one documented transaction boundary,
- idempotency behavior for mutations,
- cancellation propagation,
- typed operational errors,
- and audit/telemetry correlation.

## Ports

Ports describe capability rather than technology:

- repositories use domain-specific operations,
- `UnitOfWork` coordinates atomic persistence,
- queue ports enqueue domain/application commands,
- inbox/outbox ports guarantee delivery,
- `Clock`, `IdGenerator`, `SecretResolver`, and blob/runtime ports are injected,
- AI calls use only `AiExecutionGateway`,
- connectors use contracts from `connector-sdk`.

Do not expose Prisma clients, SQL rows, Fastify requests, provider SDK types, or queue
library jobs through application ports.

## Transactions and events

- Validate and authorize before opening long transactions.
- State change and outbox event commit atomically.
- External calls do not occur inside a database transaction unless the operation is
  specifically designed for it.
- Domain events describe committed facts; commands request future work.
- Event handlers must be idempotent.

## Error contract

Errors have a stable code, safe message, retryability, optional cause, and structured
details. Expected operational failures are values/classes, not log-and-return-null.
Unexpected errors propagate to the application boundary and become failed attempts.

## Minimum tests

- Unit tests for state transitions, identity, hashing, money, authorization decisions,
  and non-trivial invariants.
- Application tests with fake ports for transaction, idempotency, cancellation, and
  error paths.
- Do not test trivial property assignment or TypeScript's type system.

## Forbidden

- Vendor imports in domain/application.
- Hidden global service locators.
- Catch-all success fallbacks.
- Mutable singleton configuration.
- Direct database/provider calls from entities.
