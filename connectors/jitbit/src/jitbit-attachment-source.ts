import {
  type AttachmentSource,
  ConnectorCancelledError,
  type OpenAttachmentRequest,
  type OpenedAttachment,
} from "@caseweaver/connector-sdk";

import {
  attachmentIdFromJitbitOpenIdentity,
  attachmentIdFromJitbitReference,
} from "./attachment-identity.js";
import type { JitbitClient } from "./client.js";
import {
  type JitbitConfiguration,
  jitbitConfigurationSchema,
} from "./config.js";

export interface JitbitAttachmentSourceOptions {
  readonly configuration: JitbitConfiguration;
  readonly client: JitbitClient;
}

/** Streams Jitbit attachment bytes without buffering or persistence. */
export class JitbitAttachmentSource implements AttachmentSource {
  private readonly configuration: JitbitConfiguration;
  private readonly client: JitbitClient;

  public constructor(options: JitbitAttachmentSourceOptions) {
    this.configuration = jitbitConfigurationSchema.parse(options.configuration);
    this.client = options.client;
  }

  public async openAttachment(
    request: OpenAttachmentRequest,
  ): Promise<OpenedAttachment> {
    if (request.signal.aborted) throw new ConnectorCancelledError();
    const connectorInstanceId = this.configuration.settings.connectorInstanceId;
    const attachmentId =
      request.identity === undefined
        ? attachmentIdFromJitbitReference(
            request.reference,
            connectorInstanceId,
          )
        : attachmentIdFromJitbitOpenIdentity(
            request.identity,
            request.reference,
            connectorInstanceId,
          );
    return this.client.getAttachment({
      id: attachmentId,
      signal: request.signal,
    });
  }
}
