import {
  type AttachmentSource,
  ConnectorCancelledError,
  ConnectorConfigurationError,
  ConnectorProtocolError,
  type ConnectorSecretResolver,
  type OpenAttachmentRequest,
  type OpenedAttachment,
} from "@caseweaver/connector-sdk";

import {
  type GitMarkdownAttachmentAddress,
  type GitMarkdownAttachmentLocatorCodec,
  gitMarkdownAttachmentReferenceId,
  invalidAttachmentIdentity,
  parseGitMarkdownAttachmentAddress,
} from "./attachment-locator.js";
import {
  type GitMarkdownConfiguration,
  gitMarkdownConfigurationSchema,
} from "./config.js";
import {
  assertActive,
  type GitRepository,
  type GitRepositoryAuthentication,
  requireGitObjectId,
  requireRepositoryPath,
} from "./git-repository.js";

const documentResourceType = "document";
const attachmentResourceType = "attachment";

export interface GitMarkdownAttachmentSourceOptions {
  readonly configuration: GitMarkdownConfiguration;
  readonly repository: GitRepository;
  readonly secrets?: ConnectorSecretResolver;
  readonly locatorCodec: GitMarkdownAttachmentLocatorCodec;
}

function sameReference(
  left: Readonly<{
    connectorInstanceId: string;
    resourceType: string;
    externalId: string;
  }>,
  right: Readonly<{
    connectorInstanceId: string;
    resourceType: string;
    externalId: string;
  }>,
): boolean {
  return (
    left.connectorInstanceId === right.connectorInstanceId &&
    left.resourceType === right.resourceType &&
    left.externalId === right.externalId
  );
}

export class GitMarkdownAttachmentSource implements AttachmentSource {
  private readonly configuration: GitMarkdownConfiguration;
  private readonly repository: GitRepository;
  private readonly secrets?: ConnectorSecretResolver;
  private readonly locatorCodec: GitMarkdownAttachmentLocatorCodec;

  public constructor(options: GitMarkdownAttachmentSourceOptions) {
    this.configuration = gitMarkdownConfigurationSchema.parse(
      options.configuration,
    );
    this.repository = options.repository;
    this.secrets = options.secrets;
    this.locatorCodec = options.locatorCodec;
  }

  public async openAttachment(
    request: OpenAttachmentRequest,
  ): Promise<OpenedAttachment> {
    assertActive(request.signal);
    const identity = request.identity;
    if (identity === undefined) throw invalidAttachmentIdentity();
    if (
      identity.owner.kind !== "knowledgeDocument" ||
      identity.owner.document.connectorInstanceId !==
        this.configuration.settings.connectorInstanceId ||
      identity.owner.document.resourceType !== documentResourceType ||
      !sameReference(identity.reference, request.reference) ||
      identity.reference.connectorInstanceId !==
        this.configuration.settings.connectorInstanceId ||
      identity.reference.resourceType !== attachmentResourceType ||
      identity.reference.externalId !==
        gitMarkdownAttachmentReferenceId(identity.locator) ||
      identity.ordinal < 0
    ) {
      throw invalidAttachmentIdentity();
    }

    let address: GitMarkdownAttachmentAddress;
    try {
      address = parseGitMarkdownAttachmentAddress(
        await this.locatorCodec.open(identity.locator, request.signal),
      );
    } catch (error) {
      if (error instanceof ConnectorCancelledError) throw error;
      throw invalidAttachmentIdentity();
    }
    assertActive(request.signal);
    if (
      address.connectorInstanceId !==
      this.configuration.settings.connectorInstanceId
    ) {
      throw invalidAttachmentIdentity();
    }
    if (address.kind !== "repositoryFile") {
      throw new ConnectorProtocolError(
        "This Git Markdown attachment requires the configured external image source.",
      );
    }

    try {
      requireGitObjectId(address.commitSha);
      requireRepositoryPath(address.path);
      const sourcePath = requireRepositoryPath(
        identity.owner.document.externalId,
      );
      if (
        address.sourcePath !== sourcePath ||
        address.ordinal !== identity.ordinal ||
        address.relation !== identity.relation
      ) {
        throw invalidAttachmentIdentity();
      }
    } catch {
      throw invalidAttachmentIdentity();
    }
    const readBinary = this.repository.readBinary;
    if (readBinary === undefined) {
      throw new ConnectorConfigurationError(
        "The configured Git runtime cannot stream attachment bytes.",
        {
          connectorInstanceId: this.configuration.settings.connectorInstanceId,
        },
      );
    }

    const authentication = await this.resolveAuthentication(request.signal);
    const opened = await readBinary.call(this.repository, {
      repository: this.configuration.settings.repository,
      allowedLocalRoots: this.configuration.settings.allowedLocalRoots,
      ref: this.configuration.settings.ref,
      authentication,
      path: address.path,
      commitSha: address.commitSha,
      signal: request.signal,
    });
    assertActive(request.signal);
    if (
      opened.path !== address.path ||
      opened.commitSha !== address.commitSha ||
      opened.content === undefined
    ) {
      throw new ConnectorProtocolError(
        "The Git runtime did not return the requested pinned attachment.",
      );
    }

    return Object.freeze({
      content: opened.content,
      mediaType: opened.mediaType,
      contentLength: opened.contentLength,
    });
  }

  private async resolveAuthentication(
    signal: AbortSignal,
  ): Promise<GitRepositoryAuthentication> {
    assertActive(signal);
    const authentication = this.configuration.settings.authentication;
    if (authentication.kind === "none") return Object.freeze({ kind: "none" });
    if (this.secrets === undefined) {
      throw new ConnectorConfigurationError(
        "A Git token resolver is required for this connector configuration.",
        {
          connectorInstanceId: this.configuration.settings.connectorInstanceId,
        },
      );
    }
    const reference = this.configuration.secrets[authentication.secretName];
    if (reference === undefined) {
      throw new ConnectorConfigurationError(
        "The configured Git token secret reference is missing.",
        {
          connectorInstanceId: this.configuration.settings.connectorInstanceId,
        },
      );
    }
    const resolved = await this.secrets.resolve(reference, signal);
    assertActive(signal);
    if (resolved.value.length === 0) {
      throw new ConnectorConfigurationError(
        "The configured Git token resolved to an empty value.",
        {
          connectorInstanceId: this.configuration.settings.connectorInstanceId,
        },
      );
    }
    return Object.freeze({ kind: "token", token: resolved.value });
  }
}
