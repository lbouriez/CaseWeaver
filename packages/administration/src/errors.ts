export type AdministrationErrorCode =
  | "administration.conflict"
  | "administration.idempotencyConflict"
  | "administration.invalid"
  | "administration.notFound"
  | "administration.denied"
  | "administration.unavailable"
  | "administration.auditUnavailable"
  | "administration.finalAdministrator";

/**
 * An error safe to map at the API boundary. It intentionally carries no submitted
 * setting, secret, provider response, stack trace, or persistence detail.
 */
export class AdministrationError extends Error {
  public constructor(
    public readonly code: AdministrationErrorCode,
    public readonly retryable = false,
  ) {
    super(code);
    this.name = "AdministrationError";
  }
}

export class AdministrationConflictError extends AdministrationError {
  public constructor() {
    super("administration.conflict");
    this.name = "AdministrationConflictError";
  }
}

export class IdempotencyConflictError extends AdministrationError {
  public constructor() {
    super("administration.idempotencyConflict");
    this.name = "IdempotencyConflictError";
  }
}

export class AdministrationValidationError extends AdministrationError {
  public constructor() {
    super("administration.invalid");
    this.name = "AdministrationValidationError";
  }
}

export class AdministrationNotFoundError extends AdministrationError {
  public constructor() {
    super("administration.notFound");
    this.name = "AdministrationNotFoundError";
  }
}

export class AdministrationDeniedError extends AdministrationError {
  public constructor() {
    super("administration.denied");
    this.name = "AdministrationDeniedError";
  }
}

export class AdministrationUnavailableError extends AdministrationError {
  public constructor() {
    super("administration.unavailable", true);
    this.name = "AdministrationUnavailableError";
  }
}

/** Sensitive reads and all mutations fail rather than silently losing their audit trail. */
export class AdministrationAuditUnavailableError extends AdministrationError {
  public constructor() {
    super("administration.auditUnavailable", true);
    this.name = "AdministrationAuditUnavailableError";
  }
}

/** A workspace must retain at least one administrator at every committed state. */
export class FinalAdministratorError extends AdministrationError {
  public constructor() {
    super("administration.finalAdministrator");
    this.name = "FinalAdministratorError";
  }
}
