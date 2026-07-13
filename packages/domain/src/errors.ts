export type OperationalErrorDetails = Readonly<
  Record<string, boolean | number | string>
>;

export class OperationalError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly details?: OperationalErrorDetails;

  public constructor(
    code: string,
    safeMessage: string,
    retryable = false,
    details?: OperationalErrorDetails,
  ) {
    super(safeMessage);
    this.name = "OperationalError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export class DomainValidationError extends OperationalError {
  public constructor(message: string, details?: OperationalErrorDetails) {
    super("domain.validation", message, false, details);
    this.name = "DomainValidationError";
  }
}

export class StateTransitionError extends OperationalError {
  public constructor(aggregate: string, from: string, to: string) {
    super(
      "domain.invalidStateTransition",
      `Cannot transition ${aggregate} from ${from} to ${to}.`,
      false,
      { aggregate, from, to },
    );
    this.name = "StateTransitionError";
  }
}

export class IdempotencyConflictError extends OperationalError {
  public constructor(operation: string) {
    super(
      "operation.idempotencyConflict",
      "The idempotency key was already used for a different request.",
      false,
      { operation },
    );
    this.name = "IdempotencyConflictError";
  }
}

export class AuthorizationError extends OperationalError {
  public constructor(permission: string) {
    super(
      "authorization.denied",
      "The principal is not authorized for this operation.",
      false,
      { permission },
    );
    this.name = "AuthorizationError";
  }
}
