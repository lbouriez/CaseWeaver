import type {
  AttachmentRuntime,
  AttachmentRuntimeAttestation,
  AttachmentRuntimeRequest,
  AttachmentRuntimeResult,
  BlobHandle,
} from "@caseweaver/attachments";
import {
  AttachmentCancelledError,
  AttachmentError,
} from "@caseweaver/attachments";

export * from "./derivative-evidence-reader.js";

export interface IsolatedAttachmentExecutor {
  readonly attestation: AttachmentRuntimeAttestation;
  execute(
    request: AttachmentRuntimeRequest,
  ): Promise<{ readonly outputByteLength: number }>;
  cleanup(workspaceId: string): Promise<void>;
}

export interface AttachmentOutputCleaner {
  delete(handle: BlobHandle, workspaceId: string): Promise<void>;
}

function assertQuotas(request: AttachmentRuntimeRequest): void {
  const values = Object.values(request.quotas);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new RangeError(
      "Attachment runtime quotas must be positive integers.",
    );
  }
}

function assertAttestation(attestation: AttachmentRuntimeAttestation): void {
  if (
    !attestation.networkDisabled ||
    !attestation.credentialsUnavailable ||
    !attestation.disposableFilesystem ||
    !attestation.quotasEnforced
  ) {
    throw new AttachmentError(
      "attachment.runtimeAttestation",
      "Attachment runtime did not attest the required isolation.",
      false,
    );
  }
}

/**
 * Adapts a separately-provisioned isolated executor. It deliberately does not spawn a
 * process or expose filesystem, credential, or networking configuration to callers.
 */
export class AttestedAttachmentRuntime implements AttachmentRuntime {
  public constructor(
    private readonly executor: IsolatedAttachmentExecutor,
    private readonly outputs: AttachmentOutputCleaner,
  ) {}

  public async execute(
    request: AttachmentRuntimeRequest,
  ): Promise<AttachmentRuntimeResult> {
    assertQuotas(request);
    if (request.signal.aborted) throw new AttachmentCancelledError();

    const timeout = new AbortController();
    let rejectTimeout: ((reason: AttachmentError) => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const cancel = () => {
      timeout.abort(request.signal.reason);
      rejectTimeout?.(new AttachmentCancelledError());
    };
    request.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timeout.abort();
      rejectTimeout?.(
        new AttachmentError(
          "attachment.runtimeTimeout",
          "Attachment runtime exceeded its time limit.",
          true,
        ),
      );
    }, request.quotas.timeoutMs);
    try {
      assertAttestation(this.executor.attestation);
      const result = await Promise.race([
        this.executor.execute({ ...request, signal: timeout.signal }),
        deadline,
      ]);
      if (request.signal.aborted) throw new AttachmentCancelledError();
      if (timeout.signal.aborted) {
        throw new AttachmentError(
          "attachment.runtimeTimeout",
          "Attachment runtime exceeded its time limit.",
          true,
        );
      }
      if (result.outputByteLength > request.quotas.maximumOutputBytes) {
        throw new AttachmentError(
          "attachment.outputTooLarge",
          "Attachment runtime output exceeded its byte limit.",
          false,
        );
      }
      return Object.freeze({
        output: request.output,
        outputByteLength: result.outputByteLength,
        attestation: this.executor.attestation,
      });
    } catch (error) {
      if (request.signal.aborted) throw new AttachmentCancelledError();
      if (timeout.signal.aborted) {
        throw new AttachmentError(
          "attachment.runtimeTimeout",
          "Attachment runtime exceeded its time limit.",
          true,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", cancel);
      await this.executor.cleanup(request.workspaceId);
    }
  }

  public async cleanup(input: {
    readonly workspaceId: string;
    readonly handles: readonly BlobHandle[];
  }): Promise<void> {
    await Promise.all(
      input.handles.map((handle) =>
        this.outputs.delete(handle, input.workspaceId),
      ),
    );
  }
}
