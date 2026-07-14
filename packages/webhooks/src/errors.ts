export class WebhookVerificationError extends Error {
  public constructor() {
    super("Webhook verification failed.");
    this.name = "WebhookVerificationError";
  }
}

export class WebhookTranslationError extends Error {
  public constructor() {
    super("Verified webhook event could not be translated.");
    this.name = "WebhookTranslationError";
  }
}
