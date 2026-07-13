export type AiErrorDetails = Readonly<
  Record<string, boolean | number | string | undefined>
>;

export class AiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details?: AiErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AiError";
  }
}

export class AiConfigurationError extends AiError {
  public constructor(message: string, details?: AiErrorDetails) {
    super("ai.configuration", message, false, details);
    this.name = "AiConfigurationError";
  }
}

export class AiCapabilityError extends AiError {
  public constructor(message: string, details?: AiErrorDetails) {
    super("ai.capability", message, false, details);
    this.name = "AiCapabilityError";
  }
}

export class AiPriceError extends AiError {
  public constructor(
    message: string,
    details?: AiErrorDetails,
    retryable = false,
  ) {
    super("ai.price", message, retryable, details);
    this.name = "AiPriceError";
  }
}

export class AiHardBudgetError extends AiError {
  public constructor(message: string, details?: AiErrorDetails) {
    super("ai.hardBudget", message, false, details);
    this.name = "AiHardBudgetError";
  }
}

export class AiProviderError extends AiError {
  public constructor(
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly statusCode?: number;
      readonly retryAfterMs?: number;
      readonly provider?: string;
    } = {},
    cause?: unknown,
  ) {
    super(
      "ai.provider",
      message,
      options.retryable ?? false,
      {
        provider: options.provider,
        retryAfterMs: options.retryAfterMs,
        statusCode: options.statusCode,
      },
      { cause },
    );
    this.name = "AiProviderError";
  }
}

export class AiTimeoutError extends AiError {
  public constructor(timeoutMs: number) {
    super("ai.timeout", "The AI provider call exceeded its deadline.", true, {
      timeoutMs,
    });
    this.name = "AiTimeoutError";
  }
}

export class AiCancelledError extends AiError {
  public constructor() {
    super("ai.cancelled", "The AI provider call was cancelled.", false);
    this.name = "AiCancelledError";
  }
}

export class AiReconciliationError extends AiError {
  public constructor(message: string, details?: AiErrorDetails) {
    super("ai.reconciliation", message, false, details);
    this.name = "AiReconciliationError";
  }
}
