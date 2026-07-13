export type AttachmentFailureCode =
  | "attachment.aborted"
  | "attachment.archiveUnsafe"
  | "attachment.cacheClaimLost"
  | "attachment.contentTooLarge"
  | "attachment.invalidCacheIdentity"
  | "attachment.invalidText"
  | "attachment.mimeMismatch"
  | "attachment.outputTooLarge"
  | "attachment.runtimeAttestation"
  | "attachment.runtimeTimeout"
  | "attachment.unsupportedMime";

export class AttachmentError extends Error {
  public constructor(
    public readonly code: AttachmentFailureCode,
    message: string,
    public readonly retryable: boolean,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "AttachmentError";
  }
}

export class AttachmentCancelledError extends AttachmentError {
  public constructor() {
    super("attachment.aborted", "Attachment processing was cancelled.", false);
    this.name = "AttachmentCancelledError";
  }
}

export function throwIfAttachmentAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AttachmentCancelledError();
}
