import type { SecretReference } from "@caseweaver/domain";
import type {
  PreparedRepositoryChange,
  RepositoryChangePreparation,
  RepositoryChangeRequest,
  RepositoryDraftPullRequestPublisher,
} from "@caseweaver/repository-changes";

const zeroObjectId = "0000000000000000000000000000000000000000";
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu;

export class AzureDevOpsRepositoryError extends Error {
  public readonly code = "repositoryChange.azureDevOpsUnavailable";

  public constructor() {
    super("Azure DevOps repository automation is unavailable.");
    this.name = "AzureDevOpsRepositoryError";
  }
}

export interface AzureDevOpsRepositoryLocation {
  readonly organization: string;
  readonly project: string;
  readonly repository: string;
}

export interface AzureDevOpsRepositoryChangeConfiguration {
  readonly remoteUrl: string;
  readonly checkoutSecretReference: SecretReference;
}

/** Server-only configuration resolver; it never returns settings to an API or browser. */
export interface AzureDevOpsRepositoryChangeConfigurationResolver {
  resolve(
    request: RepositoryChangeRequest,
    signal: AbortSignal,
  ): Promise<AzureDevOpsRepositoryChangeConfiguration>;
}

export interface AzureDevOpsTokenResolver {
  resolve(
    reference: SecretReference,
    signal: AbortSignal,
  ): Promise<{ readonly value: string }>;
}

export interface AzureDevOpsRepositoryApi {
  resolveBranch(
    input: {
      readonly location: AzureDevOpsRepositoryLocation;
      readonly branch: string;
      readonly token: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly commit: string }>;
  findDraft(
    input: {
      readonly location: AzureDevOpsRepositoryLocation;
      readonly sourceRef: string;
      readonly token: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly url: string } | undefined>;
  createCommit(
    input: {
      readonly location: AzureDevOpsRepositoryLocation;
      readonly sourceRef: string;
      readonly parentCommit: string;
      readonly message: string;
      readonly files: readonly {
        readonly path: string;
        readonly content: string;
      }[];
      readonly token: string;
    },
    signal: AbortSignal,
  ): Promise<void>;
  createDraftPullRequest(
    input: {
      readonly location: AzureDevOpsRepositoryLocation;
      readonly sourceRef: string;
      readonly targetRef: string;
      readonly title: string;
      readonly description: string;
      readonly token: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly url: string }>;
}

function locationFromRemoteUrl(value: string): AzureDevOpsRepositoryLocation {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AzureDevOpsRepositoryError();
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new AzureDevOpsRepositoryError();
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const host = url.hostname.toLowerCase();
  const organization =
    host === "dev.azure.com" && parts.length === 4 && parts[2] === "_git"
      ? parts[0]
      : host.endsWith(".visualstudio.com") &&
          parts.length === 3 &&
          parts[1] === "_git"
        ? host.slice(0, -".visualstudio.com".length)
        : undefined;
  const project = host === "dev.azure.com" ? parts[1] : parts[0];
  const repository = host === "dev.azure.com" ? parts[3] : parts[2];
  if (
    organization === undefined ||
    project === undefined ||
    repository === undefined ||
    ![organization, project, repository].every((part) =>
      /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,199}$/u.test(part),
    )
  ) {
    throw new AzureDevOpsRepositoryError();
  }
  return Object.freeze({
    organization,
    project,
    repository,
  });
}

function sourceRef(request: RepositoryChangeRequest): string {
  return `refs/heads/caseweaver/analysis/${request.id}`;
}

function targetRef(targetBranch: string): string {
  if (!validBranch(targetBranch)) {
    throw new AzureDevOpsRepositoryError();
  }
  return `refs/heads/${targetBranch}`;
}

function validBranch(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 240 &&
    !value.startsWith("refs/") &&
    !value.startsWith("/") &&
    !value.startsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !/[~^:?*[\\\]\s\0]/u.test(value) &&
    /^[A-Za-z0-9._/-]+$/u.test(value)
  );
}

function validCommit(value: string): boolean {
  return sha.test(value);
}

/** Bridges the provider-neutral application ports to Azure DevOps REST operations. */
export class AzureDevOpsRepositoryChangeGateway
  implements RepositoryChangePreparation, RepositoryDraftPullRequestPublisher
{
  public constructor(
    private readonly dependencies: {
      readonly configurations: AzureDevOpsRepositoryChangeConfigurationResolver;
      readonly tokens: AzureDevOpsTokenResolver;
      readonly api: AzureDevOpsRepositoryApi;
    },
  ) {}

  public async prepare(
    request: RepositoryChangeRequest,
    signal: AbortSignal,
  ): Promise<PreparedRepositoryChange> {
    const configuration = await this.dependencies.configurations.resolve(
      request,
      signal,
    );
    const location = locationFromRemoteUrl(configuration.remoteUrl);
    const token = await this.requireToken(
      configuration.checkoutSecretReference,
      signal,
    );
    const target = await this.dependencies.api.resolveBranch(
      { location, branch: request.runtime.targetBranch, token },
      signal,
    );
    if (!validCommit(target.commit)) throw new AzureDevOpsRepositoryError();
    return Object.freeze({
      targetCommit: target.commit.toLowerCase(),
      runtimePin: Object.freeze({
        workspaceId: request.workspaceId,
        runtimeVersionId: request.runtime.runtimeVersionId,
        repositoryId: request.runtime.repositoryId,
        pinnedCommit: target.commit.toLowerCase(),
      }),
    });
  }

  public async createDraft(
    input: Parameters<RepositoryDraftPullRequestPublisher["createDraft"]>[0],
    signal: AbortSignal,
  ): Promise<{ readonly url: string }> {
    const configuration = await this.dependencies.configurations.resolve(
      input.request,
      signal,
    );
    const location = locationFromRemoteUrl(configuration.remoteUrl);
    const token = await this.requireToken(
      configuration.checkoutSecretReference,
      signal,
    );
    const source = sourceRef(input.request);
    const existing = await this.dependencies.api.findDraft(
      { location, sourceRef: source, token },
      signal,
    );
    if (existing !== undefined) return existing;
    try {
      await this.dependencies.api.createCommit(
        {
          location,
          sourceRef: source,
          parentCommit: input.prepared.targetCommit,
          message: `CaseWeaver: ${input.draft.title}`,
          files: input.draft.files,
          token,
        },
        signal,
      );
    } catch (error) {
      // A lease can expire after the push succeeds. A retry must reuse the fixed branch,
      // not create another change; continue to the idempotent PR lookup/create path.
      const afterPush = await this.dependencies.api.findDraft(
        { location, sourceRef: source, token },
        signal,
      );
      if (afterPush !== undefined) return afterPush;
      if (!(error instanceof AzureDevOpsRepositoryError)) throw error;
    }
    const created = await this.dependencies.api.createDraftPullRequest(
      {
        location,
        sourceRef: source,
        targetRef: targetRef(input.request.runtime.targetBranch),
        title: input.draft.title,
        description: reviewerDescription(input),
        token,
      },
      signal,
    );
    if (created.url.length === 0 || created.url.length > 4_096)
      throw new AzureDevOpsRepositoryError();
    return created;
  }

  private async requireToken(
    reference: SecretReference,
    signal: AbortSignal,
  ): Promise<string> {
    const token = (await this.dependencies.tokens.resolve(reference, signal))
      .value;
    if (token.length === 0 || /[\r\n\0]/u.test(token))
      throw new AzureDevOpsRepositoryError();
    return token;
  }
}

function reviewerDescription(
  input: Parameters<RepositoryDraftPullRequestPublisher["createDraft"]>[0],
): string {
  const references = [
    `CaseWeaver analysis: ${input.request.issue.analysisResultId}`,
    ...(input.request.issue.caseReference === undefined
      ? []
      : [`Support case: ${input.request.issue.caseReference}`]),
    ...(input.request.issue.workItemReference === undefined
      ? []
      : [`Azure DevOps work item: ${input.request.issue.workItemReference}`]),
    `Architect plan: ${input.plan.summary}`,
    `Documentation impact: ${input.plan.documentationImpact || "None identified."}`,
    "Target-repository tests were not run by CaseWeaver.",
  ];
  return `${input.draft.description.trim().slice(0, 24_000)}\n\n---\n${references.join("\n")}`.slice(
    0,
    32_000,
  );
}

export interface AzureDevOpsRestApiOptions {
  readonly fetch?: typeof fetch;
}

/** Bounded Azure DevOps Git REST implementation. Response bodies are never surfaced. */
export class AzureDevOpsRestApi implements AzureDevOpsRepositoryApi {
  private readonly fetch: typeof fetch;

  public constructor(options: AzureDevOpsRestApiOptions = {}) {
    this.fetch = options.fetch ?? fetch;
  }

  public async resolveBranch(
    input: Parameters<AzureDevOpsRepositoryApi["resolveBranch"]>[0],
    signal: AbortSignal,
  ) {
    const response = await this.request(
      input.location,
      `refs?filter=${encodeURIComponent(`heads/${input.branch}`)}`,
      input.token,
      signal,
    );
    const body = await this.json(response);
    const value = body.value;
    if (
      !Array.isArray(value) ||
      value.length !== 1 ||
      !record(value[0]) ||
      typeof value[0].objectId !== "string"
    ) {
      throw new AzureDevOpsRepositoryError();
    }
    return Object.freeze({ commit: value[0].objectId });
  }

  public async findDraft(
    input: Parameters<AzureDevOpsRepositoryApi["findDraft"]>[0],
    signal: AbortSignal,
  ) {
    const response = await this.request(
      input.location,
      `pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=${encodeURIComponent(input.sourceRef)}`,
      input.token,
      signal,
    );
    const body = await this.json(response);
    if (!Array.isArray(body.value)) throw new AzureDevOpsRepositoryError();
    const draft = body.value.find(
      (value): value is Record<string, unknown> =>
        record(value) && typeof value.url === "string",
    );
    return draft === undefined
      ? undefined
      : Object.freeze({ url: draft.url as string });
  }

  public async createCommit(
    input: Parameters<AzureDevOpsRepositoryApi["createCommit"]>[0],
    signal: AbortSignal,
  ): Promise<void> {
    if (!validCommit(input.parentCommit))
      throw new AzureDevOpsRepositoryError();
    const response = await this.request(
      input.location,
      "pushes",
      input.token,
      signal,
      {
        refUpdates: [{ name: input.sourceRef, oldObjectId: zeroObjectId }],
        commits: [
          {
            comment: input.message,
            parents: [input.parentCommit],
            changes: input.files.map((file) => ({
              changeType: "edit",
              item: { path: `/${file.path}` },
              newContent: { content: file.content, contentType: "rawtext" },
            })),
          },
        ],
      },
    );
    await this.discard(response);
  }

  public async createDraftPullRequest(
    input: Parameters<AzureDevOpsRepositoryApi["createDraftPullRequest"]>[0],
    signal: AbortSignal,
  ) {
    const response = await this.request(
      input.location,
      "pullrequests",
      input.token,
      signal,
      {
        sourceRefName: input.sourceRef,
        targetRefName: input.targetRef,
        title: input.title,
        description: input.description,
        isDraft: true,
      },
    );
    const body = await this.json(response);
    if (typeof body.url !== "string" || body.url.length === 0)
      throw new AzureDevOpsRepositoryError();
    return Object.freeze({ url: body.url });
  }

  private async request(
    location: AzureDevOpsRepositoryLocation,
    route: string,
    token: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    const base = `https://dev.azure.com/${encodeURIComponent(location.organization)}/${encodeURIComponent(location.project)}/_apis/git/repositories/${encodeURIComponent(location.repository)}`;
    let response: Response;
    try {
      response = await this.fetch(
        `${base}/${route}${route.includes("?") ? "&" : "?"}api-version=7.1`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Basic ${Buffer.from(`:${token}`, "utf8").toString("base64")}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal,
        },
      );
    } catch {
      throw new AzureDevOpsRepositoryError();
    }
    if (!response.ok) {
      await this.discard(response);
      throw new AzureDevOpsRepositoryError();
    }
    return response;
  }

  private async json(response: Response): Promise<Record<string, unknown>> {
    try {
      const value: unknown = await response.json();
      if (!record(value)) throw new AzureDevOpsRepositoryError();
      return value;
    } catch (error) {
      if (error instanceof AzureDevOpsRepositoryError) throw error;
      throw new AzureDevOpsRepositoryError();
    }
  }

  private async discard(response: Response): Promise<void> {
    await response.arrayBuffer().catch(() => undefined);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
