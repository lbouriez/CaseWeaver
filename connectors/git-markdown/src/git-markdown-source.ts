import {
  ConnectorConfigurationError,
  ConnectorProtocolError,
  type ConnectorSecretResolver,
  type DiscoveredKnowledgeItem,
  type DiscoveryPage,
  type ExternalReference,
  type KnowledgeDocument,
  type KnowledgeSource,
  type LoadKnowledgeRequest,
  type VersionedOpaqueValue,
  versionedOpaqueValue,
} from "@caseweaver/connector-sdk";

import {
  type GitMarkdownConfiguration,
  gitMarkdownConfigurationSchema,
} from "./config.js";
import {
  assertActive,
  type GitRepository,
  type GitRepositoryAuthentication,
  parseGitRepositoryDelta,
  parseGitRepositoryFile,
  parseGitRepositorySnapshot,
  requireGitObjectId,
  requireRepositoryPath,
} from "./git-repository.js";
import {
  docusaurusDocumentUrl,
  gitBlobSourceUrl,
  type ParsedMarkdownDocument,
  parseMarkdownDocument,
} from "./markdown.js";

const documentResourceType = "document";
const cursorVersion = "git-markdown.cursor.v1";
const fingerprintVersion = "git-blob.v1";
const revisionVersion = "git-commit.v1";
const defaultPageSize = 100;
const maximumPageSize = 1_000;

export interface GitMarkdownKnowledgeSourceOptions {
  readonly configuration: GitMarkdownConfiguration;
  readonly repository: GitRepository;
  readonly secrets?: ConnectorSecretResolver;
}

export interface ParsedGitMarkdownDocument {
  readonly document: KnowledgeDocument;
  readonly sourceUrl?: string;
  readonly parsed: ParsedMarkdownDocument;
  readonly provenance: Readonly<{
    repository: "local" | "remote";
    commitSha: string;
    path: string;
    blobOid: string;
  }>;
}

export interface PinnedGitMarkdownReadRequest {
  readonly reference: ExternalReference;
  readonly commitSha: string;
  readonly signal: AbortSignal;
}

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|mdx)$/i.test(path);
}

function pathGlobMatches(pattern: string, path: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === undefined) break;
    if (character === "*") {
      const nextCharacter = pattern[index + 1];
      if (nextCharacter === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`, "u").test(path);
}

function isIncluded(
  path: string,
  configuration: GitMarkdownConfiguration,
): boolean {
  const { include, exclude } = configuration.settings.paths;
  return (
    isMarkdownPath(path) &&
    include.some((pattern) => pathGlobMatches(pattern, path)) &&
    !exclude.some((pattern) => pathGlobMatches(pattern, path))
  );
}

function pageSize(requestedPageSize: number | undefined): number {
  if (requestedPageSize === undefined) return defaultPageSize;
  if (
    !Number.isInteger(requestedPageSize) ||
    requestedPageSize < 1 ||
    requestedPageSize > maximumPageSize
  ) {
    throw new ConnectorProtocolError(
      "Git Markdown discovery requires a page size between 1 and 1000.",
    );
  }
  return requestedPageSize;
}

function requireDocumentReference(
  reference: ExternalReference,
  configuration: GitMarkdownConfiguration,
): string {
  if (
    reference.connectorInstanceId !==
      configuration.settings.connectorInstanceId ||
    reference.resourceType !== documentResourceType
  ) {
    throw new ConnectorProtocolError(
      "The requested document does not belong to this Git Markdown source.",
    );
  }
  const path = requireRepositoryPath(reference.externalId);
  if (!isIncluded(path, configuration)) {
    throw new ConnectorProtocolError(
      "The requested document is excluded by the configured Git path filters.",
    );
  }
  return path;
}

export class GitMarkdownKnowledgeSource implements KnowledgeSource {
  private readonly configuration: GitMarkdownConfiguration;
  private readonly repository: GitRepository;
  private readonly secrets?: ConnectorSecretResolver;

  public constructor(options: GitMarkdownKnowledgeSourceOptions) {
    this.configuration = gitMarkdownConfigurationSchema.parse(
      options.configuration,
    );
    this.repository = options.repository;
    this.secrets = options.secrets;
  }

  public async *discover(request: {
    readonly cursor?: VersionedOpaqueValue;
    readonly pageSize?: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<DiscoveryPage<DiscoveredKnowledgeItem>> {
    assertActive(request.signal);
    if (
      request.cursor !== undefined &&
      request.cursor.version !== cursorVersion
    ) {
      throw new ConnectorProtocolError(
        "The Git Markdown source received an incompatible cursor.",
      );
    }

    const authentication = await this.resolveAuthentication(request.signal);
    const diffRepository = this.repository.diff;
    if (request.cursor !== undefined && diffRepository !== undefined) {
      yield* this.discoverDelta(
        request,
        authentication,
        requireGitObjectId(request.cursor.value),
        diffRepository,
      );
      return;
    }

    const snapshot = parseGitRepositorySnapshot(
      await this.repository.inspect({
        repository: this.configuration.settings.repository,
        allowedLocalRoots: this.configuration.settings.allowedLocalRoots,
        ref: this.configuration.settings.ref,
        authentication,
        signal: request.signal,
      }),
    );
    assertActive(request.signal);

    const files = snapshot.files
      .filter((file) => isIncluded(file.path, this.configuration))
      .sort((left, right) => left.path.localeCompare(right.path));
    const scanEpoch = versionedOpaqueValue(revisionVersion, snapshot.commitSha);
    const nextCursor = versionedOpaqueValue(cursorVersion, snapshot.commitSha);
    const size = pageSize(request.pageSize);

    if (files.length === 0) {
      yield {
        mode: "snapshot",
        scanEpoch,
        items: [],
        nextCursor,
        complete: true,
      };
      return;
    }

    for (let offset = 0; offset < files.length; offset += size) {
      assertActive(request.signal);
      const pageFiles = files.slice(offset, offset + size);
      yield {
        mode: "snapshot",
        scanEpoch,
        items: pageFiles.map((file) => ({
          reference: {
            connectorInstanceId:
              this.configuration.settings.connectorInstanceId,
            resourceType: documentResourceType,
            externalId: file.path,
          },
          fingerprint: versionedOpaqueValue(fingerprintVersion, file.blobOid),
          externalRevision: versionedOpaqueValue(
            revisionVersion,
            snapshot.commitSha,
          ),
          loadToken: versionedOpaqueValue(revisionVersion, snapshot.commitSha),
        })),
        nextCursor,
        complete: offset + size >= files.length,
      };
    }
  }

  public async load(request: LoadKnowledgeRequest): Promise<KnowledgeDocument> {
    assertActive(request.signal);
    requireDocumentReference(request.reference, this.configuration);
    const loadToken = request.loadToken;
    if (loadToken === undefined || loadToken.version !== revisionVersion) {
      throw new ConnectorProtocolError(
        "Git Markdown loading requires a Git commit load token from discovery.",
      );
    }
    const commitSha = requireGitObjectId(loadToken.value);
    if (
      request.externalRevision !== undefined &&
      (request.externalRevision.version !== revisionVersion ||
        request.externalRevision.value !== commitSha)
    ) {
      throw new ConnectorProtocolError(
        "The Git Markdown load token and external revision must identify the same commit.",
      );
    }
    const loaded = await this.readPinned({
      reference: request.reference,
      commitSha,
      signal: request.signal,
    });
    return loaded.document;
  }

  /** Reads an immutable commit and exposes parsed connector-specific details. */
  public async readPinned(
    request: PinnedGitMarkdownReadRequest,
  ): Promise<ParsedGitMarkdownDocument> {
    assertActive(request.signal);
    const path = requireDocumentReference(
      request.reference,
      this.configuration,
    );
    const commitSha = requireGitObjectId(request.commitSha);
    const authentication = await this.resolveAuthentication(request.signal);
    const file = parseGitRepositoryFile(
      await this.repository.readFile({
        repository: this.configuration.settings.repository,
        allowedLocalRoots: this.configuration.settings.allowedLocalRoots,
        ref: this.configuration.settings.ref,
        authentication,
        path,
        commitSha,
        signal: request.signal,
      }),
    );
    assertActive(request.signal);
    if (file.path !== path) {
      throw new ConnectorProtocolError(
        "The Git repository returned a different document path.",
      );
    }
    if (file.commitSha !== commitSha) {
      throw new ConnectorProtocolError(
        "The Git repository returned a document from a different commit.",
      );
    }
    if (
      file.content.length >
      this.configuration.settings.maximumMarkdownCharacters
    ) {
      throw new ConnectorProtocolError(
        "The Git document exceeds the configured Markdown size limit.",
      );
    }

    const parsed = parseMarkdownDocument(file.content);
    const docusaurusUrl = docusaurusDocumentUrl({
      path,
      parsed,
      settings: this.configuration.settings.docusaurus,
    });
    const sourceUrl =
      docusaurusUrl ??
      gitBlobSourceUrl({
        repository: this.configuration.settings.repository,
        browserUrl: this.configuration.settings.browserUrl,
        commitSha: file.commitSha,
        path,
      });

    const document: KnowledgeDocument = {
      reference: request.reference,
      externalRevision: versionedOpaqueValue(revisionVersion, file.commitSha),
      title: parsed.title,
      body: {
        format: "markdown",
        normalizedText: parsed.markdown,
      },
      attachments: [],
      provenance: {
        sourceUrl,
        sourceLocator: path,
        contentIdentity: versionedOpaqueValue(fingerprintVersion, file.blobOid),
      },
      sourceAnchors: parsed.headings.map((heading) => ({
        anchor: heading.anchor,
        label: heading.text,
        position: heading.line,
      })),
    };

    return Object.freeze({
      document,
      sourceUrl,
      parsed,
      provenance: Object.freeze({
        repository: this.configuration.settings.repository.kind,
        commitSha: file.commitSha,
        path,
        blobOid: file.blobOid,
      }),
    });
  }

  private async *discoverDelta(
    request: {
      readonly pageSize?: number;
      readonly signal: AbortSignal;
    },
    authentication: GitRepositoryAuthentication,
    fromCommitSha: string,
    diffRepository: NonNullable<GitRepository["diff"]>,
  ): AsyncIterable<DiscoveryPage<DiscoveredKnowledgeItem>> {
    const diff = parseGitRepositoryDelta(
      await diffRepository.call(this.repository, {
        repository: this.configuration.settings.repository,
        allowedLocalRoots: this.configuration.settings.allowedLocalRoots,
        ref: this.configuration.settings.ref,
        authentication,
        fromCommitSha,
        signal: request.signal,
      }),
    );
    assertActive(request.signal);
    if (diff.fromCommitSha !== fromCommitSha) {
      throw new ConnectorProtocolError(
        "The Git repository diff does not match the requested cursor.",
      );
    }

    const events = diff.changes
      .filter((change) => isIncluded(change.path, this.configuration))
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((change) => {
        const reference: ExternalReference = {
          connectorInstanceId: this.configuration.settings.connectorInstanceId,
          resourceType: documentResourceType,
          externalId: change.path,
        };
        return change.kind === "tombstone"
          ? { kind: "tombstone" as const, reference }
          : {
              kind: "upsert" as const,
              item: {
                reference,
                fingerprint: versionedOpaqueValue(
                  fingerprintVersion,
                  change.blobOid,
                ),
                externalRevision: versionedOpaqueValue(
                  revisionVersion,
                  diff.commitSha,
                ),
                loadToken: versionedOpaqueValue(
                  revisionVersion,
                  diff.commitSha,
                ),
              },
            };
      });
    const nextCursor = versionedOpaqueValue(cursorVersion, diff.commitSha);
    const size = pageSize(request.pageSize);

    if (events.length === 0) {
      yield { mode: "delta", events: [], nextCursor, complete: true };
      return;
    }

    for (let offset = 0; offset < events.length; offset += size) {
      assertActive(request.signal);
      yield {
        mode: "delta",
        events: events.slice(offset, offset + size),
        nextCursor,
        complete: offset + size >= events.length,
      };
    }
  }

  private async resolveAuthentication(
    signal: AbortSignal,
  ): Promise<GitRepositoryAuthentication> {
    assertActive(signal);
    const authentication = this.configuration.settings.authentication;
    if (authentication.kind === "none") {
      return Object.freeze({ kind: "none" });
    }
    if (this.secrets === undefined) {
      throw new ConnectorConfigurationError(
        "A Git token resolver is required for this connector configuration.",
        {
          connectorInstanceId: this.configuration.settings.connectorInstanceId,
        },
      );
    }

    const secretReference =
      this.configuration.secrets[authentication.secretName];
    if (secretReference === undefined) {
      throw new ConnectorConfigurationError(
        "The configured Git token secret reference is missing.",
        {
          connectorInstanceId: this.configuration.settings.connectorInstanceId,
        },
      );
    }
    const resolved = await this.secrets.resolve(secretReference, signal);
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

export function isGitMarkdownPathIncluded(
  path: string,
  configuration: GitMarkdownConfiguration,
): boolean {
  return isIncluded(path, configuration);
}
