import type { RuntimeConfig } from "../runtime-config.js";
import {
  type ActionOutcome,
  type ActionPreview,
  type AdminActionName,
  type AdminDetail,
  type AdminListResponse,
  type AdminResourceName,
  type AiBindingDraftRequest,
  type AiBudgetRequest,
  type AiPriceOverrideRequest,
  type AiRoleDefaultRequest,
  actionOutcomeSchema,
  actionPreviewSchema,
  adminDetailSchema,
  adminListResponseSchema,
  type ConfigurationDescriptor,
  type ConfigurationHistoryResponse,
  type ConfigurationInspection,
  type ConfigurationSurface,
  type ConnectorDraftTestOperation,
  type ConnectorDraftTestPreview,
  type ConnectorDraftTestResult,
  configurationHistoryResponseSchema,
  configurationInspectionSchema,
  configurationSurfacesSchema,
  connectorDraftTestOperationsSchema,
  connectorDraftTestPreviewSchema,
  connectorDraftTestResultSchema,
  type DiagnosticExportStatus,
  descriptorCatalogSchema,
  diagnosticExportStatusSchema,
  type KnowledgeCollectionCreateInput,
  type PlatformLinkConfiguration,
  type ProviderCapabilityTestPreview,
  type ProviderCapabilityTestResult,
  type PublicApiErrorBody,
  type RepositoryAnalysisConfiguration,
  repositoryAnalysisConfigurationSchema,
  type RepositoryAnalysisDraftInput,
  type RepositoryAnalysisDraftRevisionInput,
  type RepositoryAnalysisOptions,
  repositoryAnalysisOptionsSchema,
  type RepositoryAnalysisResource,
  type RepositoryDraftTestExecution,
  repositoryDraftTestExecutionSchema,
  type RepositoryDraftTestPreview,
  repositoryDraftTestPreviewSchema,
  platformLinkConfigurationSchema,
  providerCapabilityTestOperationsSchema,
  providerCapabilityTestPreviewSchema,
  providerCapabilityTestResultSchema,
  publicApiErrorBodySchema,
  resourceEndpoints,
  type Session,
  sessionSchema,
  type WorkspaceRoleAssignment,
  workspaceRoleAssignmentSchema,
} from "./contracts.js";

export type UiActionMode = "user" | "passive_poll";

export interface ApiClientOptions {
  readonly fetchImplementation?: typeof fetch;
  readonly createActionId?: () => string;
}

export interface ListQuery {
  readonly limit?: number;
  readonly after?: string;
  readonly sort?: string;
  readonly direction?: "ASC" | "DESC";
  readonly filter?: Readonly<Record<string, string | number | boolean>>;
}

export interface DescriptorDraftInput {
  readonly descriptorType: string;
  readonly displayName: string;
  readonly settings: Readonly<Record<string, unknown>>;
}

/** Submitted only to the dedicated HTTPS sign-in endpoint and never retained by this client. */
export interface PasswordLoginInput {
  readonly login: string;
  readonly password: string;
}

export interface SecretReferenceRegistrationInput {
  /** Opaque locator in the configured external secret backend, never a value. */
  readonly reference: string;
}

/** Resource-owned source draft. Connector settings remain descriptor-owned and
 * are never copied into this feature-level control-plane command. */
export interface KnowledgeSourceDraftInput {
  readonly displayName: string;
  readonly connectorInstanceId: string;
  readonly collectionId: string;
  readonly normalizationProfileId: string;
  readonly normalizationProfileVersion: string;
  readonly chunkingProfileId: string;
  readonly chunkingProfileVersion: string;
  readonly embeddingBatchSize: number;
  readonly embeddingBudgetPolicyId: string;
  /** Source-owned immutable attachment policy selection. The API validates the
   * policy version and derives all limits, bindings and secret-free runtime
   * settings; the browser never supplies those fields. */
  readonly attachmentStage:
    | Readonly<{ readonly mode: "disabled" }>
    | Readonly<{
        readonly mode: "optional" | "required";
        readonly attachmentPolicyId: string;
        readonly attachmentPolicyConfigurationVersionId: string;
      }>;
  readonly synchronizationPolicy: Readonly<Record<string, unknown>>;
  readonly deletionBehavior: "tombstone" | "retain";
}

/** Schedule draft pins an immutable source configuration version, not a mutable
 * source record. This prevents later source edits from rewriting queued work. */
export interface KnowledgeScheduleDraftInput {
  readonly displayName: string;
  readonly sourceId: string;
  readonly sourceConfigurationVersionId: string;
  readonly kind: "synchronize" | "fullRescan";
  readonly cadence:
    | Readonly<{
        readonly kind: "cron";
        readonly expression: string;
        readonly timezone: string;
        readonly jitterMs?: number;
        readonly overlapPolicy: "skip" | "queue";
      }>
    | Readonly<{
        readonly kind: "interval";
        readonly intervalMs: number;
        readonly jitterMs?: number;
        readonly overlapPolicy: "skip" | "queue";
      }>;
  readonly nextRunAt: string;
}

/** Provider-neutral immutable policy-profile draft. The browser supplies only
 * safe bounded settings; profile IDs, versions, validation, authorization, and
 * audit metadata remain API-owned. */
export type PolicyProfileResource = "retrieval-profiles" | "prompt-profiles";

export interface PolicyProfileDraftInput {
  readonly displayName: string;
  readonly settings: Readonly<Record<string, unknown>>;
}

const policyProfileDraftEndpoints: Readonly<
  Record<string, string | undefined>
> = Object.freeze({
  "retrieval-profiles": "/v1/admin/retrieval-profiles/drafts",
  "prompt-profiles": "/v1/admin/prompt-profiles/drafts",
});

/** Publication policy is a server-validated opaque configuration object. The
 * browser has no profile/version identity and may not include secret fields. */
export interface PublicationProfileDraftInput {
  readonly displayName: string;
  readonly definition: Readonly<Record<string, unknown>>;
}

/**
 * Webhook authoring selects only opaque server registrations. In particular,
 * `secretReferenceRegistrationIds` are registration identifiers, never secret
 * values, locators, headers, or connector adapter configuration.
 */
export interface WebhookEndpointDraftInput {
  readonly displayName: string;
  readonly connectorInstanceId: string;
  readonly verifiedEventTypes: readonly string[];
  readonly maximumBodyBytes: number;
  readonly maximumRequestsPerMinute: number;
  readonly analysisTriggerId?: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secretReferenceRegistrationIds: readonly string[];
}

export interface PlatformLinkUpdateInput {
  readonly apiPublicBaseUrl: string;
  readonly webhookPublicBaseUrl: string;
  /** Omitted only while creating the first workspace-level configuration. */
  readonly expectedRevision?: number;
}

/** A source/schedule lifecycle transition contains no feature settings. The API
 * reloads the current immutable projection and rejects a stale revision. */
export interface ConfigurationLifecycleTransitionInput {
  readonly expectedRevision: number;
  readonly lifecycle: "active" | "disabled";
}

export interface ReplaceWorkspaceRolesInput {
  readonly roles: readonly (
    | "administrator"
    | "operator"
    | "analyst"
    | "viewer"
  )[];
  readonly expectedRevision: number;
}

export type ApiFailureKind =
  | "unauthenticated"
  | "denied"
  | "invalid"
  | "conflict"
  | "unavailable"
  | "cancelled"
  | "failed";

export class PublicApiError extends Error {
  public readonly kind: ApiFailureKind;
  public readonly status?: number;
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly requestId?: string;
  public readonly correlationId?: string;
  public readonly retryAfterSeconds?: number;

  public constructor(
    kind: ApiFailureKind,
    code: string,
    message: string,
    options: {
      readonly status?: number;
      readonly retryable?: boolean;
      readonly requestId?: string;
      readonly correlationId?: string;
      readonly retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = "PublicApiError";
    this.kind = kind;
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.correlationId = options.correlationId;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function createBrowserActionId(): string {
  return crypto.randomUUID();
}

function classifyStatus(status: number): ApiFailureKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "denied";
  if (status === 409 || status === 412) return "conflict";
  if (status === 400 || status === 422) return "invalid";
  if (status === 404 || status === 429 || status >= 500) return "unavailable";
  return "failed";
}

function genericFailure(status?: number): PublicApiError {
  return new PublicApiError(
    status === undefined ? "unavailable" : classifyStatus(status),
    status === undefined ? "network.unavailable" : "request.failed",
    status === undefined
      ? "The control-plane API is unavailable. No local data is being shown."
      : "The control-plane API could not complete this request.",
    { status, retryable: status === undefined || status >= 500 },
  );
}

function parsePublicError(status: number, value: unknown): PublicApiError {
  const parsed = publicApiErrorBodySchema.safeParse(value);
  if (!parsed.success) return genericFailure(status);

  const body: PublicApiErrorBody = parsed.data;
  return new PublicApiError(
    classifyStatus(status),
    body.code,
    body.message ?? "The control-plane API rejected this request.",
    {
      status,
      retryable: body.retryable,
      requestId: body.requestId,
      correlationId: body.correlationId,
      retryAfterSeconds: body.retryAfterSeconds,
    },
  );
}

function safelyEncodeIdentifier(identifier: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(identifier)) {
    throw new PublicApiError(
      "invalid",
      "client.invalidIdentifier",
      "The selected resource identifier is invalid.",
    );
  }
  return encodeURIComponent(identifier);
}

function validateIdentifier(identifier: string): string {
  safelyEncodeIdentifier(identifier);
  return identifier;
}

export class CaseWeaverApiClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly createActionId: () => string;
  private csrfToken: string | undefined;

  public constructor(
    private readonly config: RuntimeConfig,
    options: ApiClientOptions = {},
  ) {
    // Store a wrapper rather than the browser function itself: requestJson calls
    // this as an instance member, whereas browser fetch must retain its global
    // receiver. Test fakes remain injectable through the same narrow seam.
    this.fetchImplementation =
      options.fetchImplementation ??
      ((input, init) => globalThis.fetch(input, init));
    this.createActionId = options.createActionId ?? createBrowserActionId;
  }

  public async session(signal?: AbortSignal): Promise<Session> {
    const session = await this.requestJson(
      "/v1/auth/session",
      // A stale anonymous response would strand an operator on the sign-in
      // screen immediately after the API creates its HttpOnly session cookie.
      // Sessions also contain CSRF material, so they must never use a browser
      // or intermediary cache.
      { method: "GET", signal, cache: "no-store" },
      sessionSchema,
      "user",
    );
    this.csrfToken = session.authenticated ? session.csrfToken : undefined;
    return session;
  }

  public loginUrl(returnTo: string): URL {
    const url = this.endpointUrl("/v1/auth/login");
    url.searchParams.set("returnTo", returnTo);
    return url;
  }

  public async passwordLogin(
    input: PasswordLoginInput,
    signal?: AbortSignal,
  ): Promise<Session> {
    const session = await this.requestJson(
      "/v1/auth/login/password",
      {
        method: "POST",
        signal,
        body: JSON.stringify(input),
      },
      sessionSchema,
      "user",
    );
    this.csrfToken = session.authenticated ? session.csrfToken : undefined;
    return session;
  }

  public async logout(signal?: AbortSignal): Promise<void> {
    await this.requestJson(
      "/v1/auth/logout",
      { method: "POST", signal },
      undefined,
      "user",
    );
    this.csrfToken = undefined;
  }

  public async switchWorkspace(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<Session> {
    const session = await this.requestJson(
      "/v1/auth/session/workspace",
      {
        method: "POST",
        signal,
        body: JSON.stringify({ workspaceId: validateIdentifier(workspaceId) }),
      },
      sessionSchema,
      "user",
    );
    this.csrfToken = session.authenticated ? session.csrfToken : undefined;
    return session;
  }

  public async list(
    resource: AdminResourceName,
    query: ListQuery = {},
    options: {
      readonly signal?: AbortSignal;
      readonly mode?: UiActionMode;
    } = {},
  ): Promise<AdminListResponse> {
    const endpoint = this.listEndpoint(resource, query);
    return this.requestJson(
      endpoint,
      { method: "GET", signal: options.signal },
      adminListResponseSchema,
      options.mode ?? "user",
    );
  }

  public async get(
    resource: AdminResourceName,
    id: string,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    const route = resourceEndpoints[resource].detail;
    if (route === undefined) {
      throw new PublicApiError(
        "unavailable",
        "resource.readUnavailable",
        "This operational view is available only as a summary.",
      );
    }
    return this.requestJson(
      `${route}/${safelyEncodeIdentifier(id)}`,
      { method: "GET", signal },
      adminDetailSchema,
      "user",
    );
  }

  public async configurationInspection(
    configurationId: string,
    signal?: AbortSignal,
  ): Promise<ConfigurationInspection> {
    return this.requestJson(
      `/v1/admin/configurations/${safelyEncodeIdentifier(configurationId)}`,
      { method: "GET", signal },
      configurationInspectionSchema,
      "user",
    );
  }

  public async configurationHistory(
    configurationId: string,
    query: Readonly<{ readonly limit?: number; readonly after?: string }> = {},
    signal?: AbortSignal,
  ): Promise<ConfigurationHistoryResponse> {
    const parameters = new URLSearchParams();
    if (query.limit !== undefined) parameters.set("limit", String(query.limit));
    if (query.after !== undefined)
      parameters.set("after", validateIdentifier(query.after));
    const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
    return this.requestJson(
      `/v1/admin/configurations/${safelyEncodeIdentifier(configurationId)}/versions${suffix}`,
      { method: "GET", signal },
      configurationHistoryResponseSchema,
      "user",
    );
  }

  public async configurationSurfaces(
    signal?: AbortSignal,
  ): Promise<readonly ConfigurationSurface[]> {
    const result = await this.requestJson(
      "/v1/admin/configuration-surfaces",
      { method: "GET", signal },
      configurationSurfacesSchema,
      "user",
    );
    return result.items;
  }

  /** Safe, server-audited authoring choices for the repository-analysis area. */
  public async repositoryAnalysisOptions(
    signal?: AbortSignal,
  ): Promise<RepositoryAnalysisOptions> {
    return this.requestJson(
      "/v1/admin/repository-analysis/options",
      { method: "GET", signal },
      repositoryAnalysisOptionsSchema,
      "user",
    );
  }

  public async createRepositoryAnalysisDraft(
    input: RepositoryAnalysisDraftInput,
    signal?: AbortSignal,
  ): Promise<RepositoryAnalysisConfiguration> {
    return this.requestJson(
      "/v1/admin/repository-analysis/drafts",
      { method: "POST", signal, body: JSON.stringify(input) },
      repositoryAnalysisConfigurationSchema,
      "user",
    );
  }

  public async createRepositoryAnalysisDraftRevision(
    input: RepositoryAnalysisDraftRevisionInput,
    signal?: AbortSignal,
  ): Promise<RepositoryAnalysisConfiguration> {
    return this.requestJson(
      "/v1/admin/repository-analysis/draft-revisions",
      { method: "POST", signal, body: JSON.stringify(input) },
      repositoryAnalysisConfigurationSchema,
      "user",
    );
  }

  public async transitionRepositoryAnalysis(
    input: Readonly<{
      readonly resource: RepositoryAnalysisResource;
      readonly configurationId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
    }>,
    signal?: AbortSignal,
  ): Promise<RepositoryAnalysisConfiguration> {
    return this.requestJson(
      "/v1/admin/repository-analysis/lifecycle",
      { method: "POST", signal, body: JSON.stringify(input) },
      repositoryAnalysisConfigurationSchema,
      "user",
    );
  }

  public async previewRepositoryDraftTest(
    input: Readonly<{
      readonly repositoryId: string;
      readonly candidateVersionId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<RepositoryDraftTestPreview> {
    return this.requestJson(
      "/v1/admin/repository-analysis/code-repositories/draft-tests/previews",
      { method: "POST", signal, body: JSON.stringify(input) },
      repositoryDraftTestPreviewSchema,
      "user",
    );
  }

  public async executeRepositoryDraftTest(
    input: Readonly<{
      readonly repositoryId: string;
      readonly candidateVersionId: string;
      readonly confirmationId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<RepositoryDraftTestExecution> {
    return this.requestJson(
      "/v1/admin/repository-analysis/code-repositories/draft-tests/executions",
      { method: "POST", signal, body: JSON.stringify(input) },
      repositoryDraftTestExecutionSchema,
      "user",
    );
  }

  public async listDescriptors(
    kind: ConfigurationDescriptor["kind"],
    signal?: AbortSignal,
  ): Promise<readonly ConfigurationDescriptor[]> {
    const endpoint =
      kind === "connector"
        ? "/v1/admin/descriptors/connectors"
        : "/v1/admin/descriptors/ai-providers";
    const result = await this.requestJson(
      endpoint,
      { method: "GET", signal },
      descriptorCatalogSchema,
      "user",
    );
    return result.items.filter((descriptor) => descriptor.kind === kind);
  }

  public async createDescriptorDraft(
    kind: ConfigurationDescriptor["kind"],
    input: DescriptorDraftInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    const endpoint =
      kind === "connector"
        ? "/v1/admin/connector-instances/drafts"
        : "/v1/admin/ai/provider-instances/drafts";
    return this.requestJson(
      endpoint,
      {
        method: "POST",
        signal,
        body: JSON.stringify(input),
      },
      adminDetailSchema,
      "user",
    );
  }

  /**
   * Discovers only server-composed, descriptor-bound tests. An advertised
   * descriptor capability alone never grants the browser permission to invoke
   * a connector or expose a runtime implementation.
   */
  public async connectorDraftTestOperations(
    descriptorType: string,
    signal?: AbortSignal,
  ): Promise<readonly ConnectorDraftTestOperation[]> {
    const result = await this.requestJson(
      `/v1/admin/connector-descriptors/${safelyEncodeIdentifier(descriptorType)}/draft-tests`,
      { method: "GET", signal },
      connectorDraftTestOperationsSchema,
      "user",
    );
    return result.items;
  }

  /** Preview is an audited, no-dispatch confirmation step for an unpersisted
   * descriptor configuration. The settings contain only normal fields and
   * opaque registration IDs for secret slots. */
  public async previewConnectorDraftTest(
    descriptorType: string,
    testOperation: string,
    settings: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ConnectorDraftTestPreview> {
    return this.requestJson(
      `/v1/admin/connector-descriptors/${safelyEncodeIdentifier(descriptorType)}/draft-tests/${safelyEncodeIdentifier(testOperation)}/previews`,
      { method: "POST", signal, body: JSON.stringify({ settings }) },
      connectorDraftTestPreviewSchema,
      "user",
    );
  }

  /** The API revalidates and hashes settings before consuming the one-use
   * confirmation. It returns no connector response, locator, or secret. */
  public async runConnectorDraftTest(
    descriptorType: string,
    testOperation: string,
    settings: Readonly<Record<string, unknown>>,
    confirmationId: string,
    signal?: AbortSignal,
  ): Promise<ConnectorDraftTestResult> {
    return this.requestJson(
      `/v1/admin/connector-descriptors/${safelyEncodeIdentifier(descriptorType)}/draft-tests/${safelyEncodeIdentifier(testOperation)}/executions`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          settings,
          confirmationId: safelyEncodeIdentifier(confirmationId),
        }),
      },
      connectorDraftTestResultSchema,
      "user",
    );
  }

  public async createSecretReference(
    input: SecretReferenceRegistrationInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      "/v1/admin/secret-references",
      {
        method: "POST",
        signal,
        body: JSON.stringify(input),
      },
      adminDetailSchema,
      "user",
    );
  }

  public async createKnowledgeSourceDraft(
    input: KnowledgeSourceDraftInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      "/v1/admin/knowledge-sources/drafts",
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  /** Creates an immutable workspace vector-space identity. The server selects
   * the selected binding's active version and records the audited mutation. */
  public async createKnowledgeCollection(
    input: KnowledgeCollectionCreateInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      "/v1/admin/collections",
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async createKnowledgeScheduleDraft(
    input: KnowledgeScheduleDraftInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      "/v1/admin/schedules/drafts",
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async createPolicyProfileDraft(
    resource: PolicyProfileResource,
    input: PolicyProfileDraftInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    const endpoint = policyProfileDraftEndpoints[resource];
    if (endpoint === undefined) {
      throw new PublicApiError(
        "invalid",
        "client.invalidPolicyProfileResource",
        "The selected policy profile type is invalid.",
      );
    }
    return this.requestJson(
      endpoint,
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async createPublicationProfileDraft(
    input: PublicationProfileDraftInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      "/v1/admin/publication-profiles/drafts",
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async createWebhookEndpointDraft(
    input: WebhookEndpointDraftInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      "/v1/admin/webhook-endpoints/drafts",
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async transitionPublicationProfile(
    profileId: string,
    input: ConfigurationLifecycleTransitionInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      `/v1/admin/publication-profiles/${safelyEncodeIdentifier(profileId)}/lifecycle`,
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async transitionWebhookEndpoint(
    endpointId: string,
    input: ConfigurationLifecycleTransitionInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      `/v1/admin/webhook-endpoints/${safelyEncodeIdentifier(endpointId)}/lifecycle`,
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async platformLinks(
    signal?: AbortSignal,
  ): Promise<PlatformLinkConfiguration> {
    return this.requestJson(
      "/v1/admin/platform/links",
      { method: "GET", signal },
      platformLinkConfigurationSchema,
      "user",
    );
  }

  public async savePlatformLinks(
    input: PlatformLinkUpdateInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      "/v1/admin/platform/links",
      { method: "PUT", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async createAiBindingDraft(
    input: AiBindingDraftRequest,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      "/v1/admin/ai/bindings/drafts",
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async transitionAiBinding(
    bindingId: string,
    input: ConfigurationLifecycleTransitionInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      `/v1/admin/ai/bindings/${safelyEncodeIdentifier(bindingId)}/lifecycle`,
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async createAiBindingVersionDraft(
    bindingId: string,
    input: AiBindingDraftRequest &
      Readonly<{ readonly expectedRevision: number }>,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      `/v1/admin/ai/bindings/${safelyEncodeIdentifier(bindingId)}/versions/drafts`,
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async setAiRoleDefault(
    role: AiBindingDraftRequest["role"],
    input: AiRoleDefaultRequest,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      `/v1/admin/ai/role-defaults/${safelyEncodeIdentifier(role)}`,
      { method: "PUT", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async createAiPriceOverride(
    input: AiPriceOverrideRequest,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      "/v1/admin/ai/pricing-overrides",
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async replaceAiBudget(
    input: AiBudgetRequest,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      "/v1/admin/ai/budgets",
      { method: "PUT", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async providerCapabilityTestOperations(
    providerInstanceId: string,
    signal?: AbortSignal,
  ) {
    return this.requestJson(
      `/v1/admin/ai/provider-instances/${safelyEncodeIdentifier(providerInstanceId)}/capability-tests`,
      { method: "GET", signal },
      providerCapabilityTestOperationsSchema,
      "user",
    );
  }

  public async previewProviderCapabilityTest(
    providerInstanceId: string,
    testOperation: string,
    signal?: AbortSignal,
  ): Promise<ProviderCapabilityTestPreview> {
    return this.requestJson(
      `/v1/admin/ai/provider-instances/${safelyEncodeIdentifier(providerInstanceId)}/capability-tests/${safelyEncodeIdentifier(testOperation)}/previews`,
      { method: "POST", signal },
      providerCapabilityTestPreviewSchema,
      "user",
    );
  }

  public async runProviderCapabilityTest(
    providerInstanceId: string,
    testOperation: string,
    confirmationId: string,
    signal?: AbortSignal,
  ): Promise<ProviderCapabilityTestResult> {
    return this.requestJson(
      `/v1/admin/ai/provider-instances/${safelyEncodeIdentifier(providerInstanceId)}/capability-tests/${safelyEncodeIdentifier(testOperation)}/executions`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          confirmationId: safelyEncodeIdentifier(confirmationId),
        }),
      },
      providerCapabilityTestResultSchema,
      "user",
    );
  }

  public async transitionKnowledgeSource(
    sourceId: string,
    input: ConfigurationLifecycleTransitionInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      `/v1/admin/knowledge-sources/${safelyEncodeIdentifier(sourceId)}/lifecycle`,
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async transitionKnowledgeSchedule(
    scheduleId: string,
    input: ConfigurationLifecycleTransitionInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      `/v1/admin/schedules/${safelyEncodeIdentifier(scheduleId)}/lifecycle`,
      { method: "POST", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async workspaceRoleAssignment(
    principalId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceRoleAssignment> {
    return this.requestJson(
      `/v1/admin/role-assignments/${safelyEncodeIdentifier(principalId)}/assignment`,
      { method: "GET", signal },
      workspaceRoleAssignmentSchema,
      "user",
    );
  }

  public async replaceWorkspaceRoles(
    principalId: string,
    input: ReplaceWorkspaceRolesInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    return this.requestJson(
      `/v1/admin/role-assignments/${safelyEncodeIdentifier(principalId)}`,
      { method: "PUT", signal, body: JSON.stringify(input) },
      adminDetailSchema,
      "user",
    );
  }

  public async previewAction(
    action: AdminActionName,
    target: { readonly resource: AdminResourceName; readonly id?: string },
    signal?: AbortSignal,
  ): Promise<ActionPreview> {
    return this.requestJson(
      "/v1/admin/action-previews",
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          action,
          target: {
            resource: target.resource,
            ...(target.id === undefined
              ? {}
              : { id: safelyEncodeIdentifier(target.id) }),
          },
        }),
      },
      actionPreviewSchema,
      "user",
    );
  }

  /** A privacy reason is accepted only by its dedicated server route. It is
   * not logged, placed in a URL, or retained by browser state after the
   * preview request reaches a terminal result. */
  public async previewPrivacyPurge(
    caseSnapshotId: string,
    reason: string,
    signal?: AbortSignal,
  ): Promise<ActionPreview> {
    if (reason.trim().length < 1 || reason.length > 4_000) {
      throw new PublicApiError(
        "invalid",
        "privacy.reason.invalid",
        "Provide a concise reason for the privacy purge.",
      );
    }
    return this.requestJson(
      `/v1/admin/privacy/case-snapshots/${safelyEncodeIdentifier(caseSnapshotId)}/purge`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({ reason: reason.trim() }),
      },
      actionPreviewSchema,
      "user",
    );
  }

  public async executeAction(
    previewId: string,
    signal?: AbortSignal,
  ): Promise<ActionOutcome> {
    return this.requestJson(
      "/v1/admin/actions/execute",
      {
        method: "POST",
        signal,
        body: JSON.stringify({ previewId: safelyEncodeIdentifier(previewId) }),
      },
      actionOutcomeSchema,
      "user",
    );
  }

  /** Starts a bounded server-side diagnostic export; no diagnostic data passes
   * through this command response. */
  public async requestDiagnosticExport(
    signal?: AbortSignal,
  ): Promise<DiagnosticExportStatus> {
    return this.requestJson(
      "/v1/admin/diagnostics/exports",
      { method: "POST", signal },
      diagnosticExportStatusSchema,
      "user",
    );
  }

  public async diagnosticExportStatus(
    exportId: string,
    signal?: AbortSignal,
  ): Promise<DiagnosticExportStatus> {
    return this.requestJson(
      `/v1/admin/diagnostics/exports/${safelyEncodeIdentifier(exportId)}`,
      { method: "GET", signal },
      diagnosticExportStatusSchema,
      "user",
    );
  }

  /** Reads a private export only through the audited API download endpoint. */
  public async downloadDiagnosticExport(
    exportId: string,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const actionId = this.createActionId();
    const headers = new Headers({ Accept: "application/json" });
    headers.set("X-CaseWeaver-UI-Action-ID", actionId);
    headers.set("X-CaseWeaver-Correlation-ID", actionId);
    headers.set("X-CaseWeaver-Request-Mode", "user");
    let response: Response;
    try {
      response = await this.fetchImplementation(
        this.endpointUrl(
          `/v1/admin/diagnostics/exports/${safelyEncodeIdentifier(exportId)}/download`,
        ),
        { method: "GET", signal, headers, credentials: "include" },
      );
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new PublicApiError(
          "cancelled",
          "request.cancelled",
          "The request was cancelled.",
        );
      }
      throw genericFailure();
    }
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      throw parsePublicError(response.status, payload);
    }
    return response.blob();
  }

  private endpointUrl(endpoint: string): URL {
    if (this.config.apiBaseUrl === "/") {
      return new URL(endpoint, window.location.origin);
    }
    return new URL(endpoint.replace(/^\//u, ""), `${this.config.apiBaseUrl}/`);
  }

  private listEndpoint(resource: AdminResourceName, query: ListQuery): string {
    const url = new URL(
      resourceEndpoints[resource].list,
      "https://endpoint.invalid",
    );
    if (query.limit !== undefined)
      url.searchParams.set("limit", String(query.limit));
    if (query.after !== undefined) url.searchParams.set("after", query.after);
    if (query.sort !== undefined) url.searchParams.set("sort", query.sort);
    if (query.direction !== undefined)
      url.searchParams.set("direction", query.direction);
    if (query.filter !== undefined) {
      for (const [key, value] of Object.entries(query.filter)) {
        url.searchParams.set(`filter.${key}`, String(value));
      }
    }
    return `${url.pathname}${url.search}`;
  }

  private async requestJson<T>(
    endpoint: string,
    init: RequestInit,
    schema:
      | {
          readonly safeParse: (
            value: unknown,
          ) => { success: true; data: T } | { success: false };
        }
      | undefined,
    mode: UiActionMode,
  ): Promise<T> {
    const actionId = this.createActionId();
    const isMutation = init.method !== undefined && init.method !== "GET";
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("X-CaseWeaver-UI-Action-ID", actionId);
    headers.set("X-CaseWeaver-Correlation-ID", actionId);
    headers.set("X-CaseWeaver-Request-Mode", mode);
    if (isMutation) {
      // An empty POST (notably logout) is not JSON. Declaring it as such makes
      // strict HTTP parsers reject the request before the CSRF/session boundary.
      if (init.body !== undefined)
        headers.set("Content-Type", "application/json");
      headers.set("Idempotency-Key", actionId);
      if (this.csrfToken !== undefined)
        headers.set("X-CSRF-Token", this.csrfToken);
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpointUrl(endpoint), {
        ...init,
        headers,
        credentials: "include",
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new PublicApiError(
          "cancelled",
          "request.cancelled",
          "The request was cancelled.",
        );
      }
      throw genericFailure();
    }

    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      throw parsePublicError(response.status, payload);
    }

    if (schema === undefined) {
      return undefined as T;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PublicApiError(
        "failed",
        "response.invalid",
        "The control-plane API returned an invalid response.",
        { status: response.status },
      );
    }

    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new PublicApiError(
        "failed",
        "response.invalid",
        "The control-plane API returned an invalid response.",
        { status: response.status },
      );
    }
    return result.data;
  }
}
