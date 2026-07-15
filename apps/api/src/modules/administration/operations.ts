import { randomUUID } from "node:crypto";

import {
  AdministrationUnavailableError,
  type AuthAuditAction,
  type AuthAuditReasonCode,
  type AuthAuditRecorder,
  type AuthAuditRequestMetadata,
  type ConfigurationDescriptor,
  type ConfigurationHistoryQuery,
  canonicalizeConfiguration,
  type DescriptorRegistry,
  type DiagnosticExportArtifactStore,
  type DiagnosticExportRequestMutationStore,
  type DiagnosticExportRequestStore,
  policyForAction,
  policyForResource,
  type ReplaceWorkspacePrincipalRoles,
  type PreviewProviderCapabilityTest,
  type RunProviderCapabilityTest,
  requestDiagnosticExport,
  type SecretReferenceRegistrationCommand,
  toConfigurationSurfaceDto,
  toDiagnosticExportStatus,
  type WorkspaceRoleAssignmentStore,
} from "@caseweaver/administration";
import type { AuditStore, UnitOfWork } from "@caseweaver/application";
import {
  auditEventId,
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  principalId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import type {
  AdministrationReadStore,
  AdministrationResourceReadStore,
} from "@caseweaver/postgres";
import type { AuditRecord } from "@caseweaver/security";
import {
  createAuthAuditPlan,
  resolveAuditClientAddress,
} from "../auth/audit-compliance.js";
import type { AuthSessionService } from "../auth/session-service.js";
import {
  type AdministrationOperationDispatcher,
  digestIdempotencyKey,
  mapPrivacyPurge,
  mapRoutedOperation,
} from "./operation-dispatcher.js";
import type {
  AdministrationRouteOperations,
  AdminRequestContext,
  AdminResource,
} from "./routes.js";

type RequestLike = {
  readonly headers?: Record<string, unknown>;
  readonly query?: unknown;
  readonly id?: string;
  readonly ip?: string;
};

/**
 * Composition advertises only workflows that are actually backed by a feature
 * use case. The rest remain explicit instead of looking like empty CRUD views.
 */
const configurationSurfaces = Object.freeze([
  {
    surface: "connector-instances",
    mode: "managed" as const,
    workflows: [
      "create_draft",
      "activate",
      "disable",
      "inspect_history",
    ] as const,
    operationalActions: [] as const,
  },
  {
    surface: "ai-provider-instances",
    mode: "managed" as const,
    workflows: [
      "create_draft",
      "activate",
      "disable",
      "inspect_history",
    ] as const,
    operationalActions: [] as const,
  },
  {
    surface: "knowledge-sources",
    mode: "managed" as const,
    workflows: [
      "create_draft",
      "activate",
      "disable",
      "inspect_history",
    ] as const,
    operationalActions: ["source.synchronize", "source.fullRescan"] as const,
  },
  {
    surface: "schedules",
    mode: "managed" as const,
    workflows: [
      "create_draft",
      "activate",
      "disable",
      "inspect_history",
    ] as const,
    operationalActions: [] as const,
  },
  {
    surface: "publication-profiles",
    mode: "managed" as const,
    workflows: [
      "create_draft",
      "activate",
      "disable",
      "inspect_history",
    ] as const,
    operationalActions: [] as const,
  },
  {
    surface: "publications",
    mode: "read_only" as const,
    reasonCode: "workflow_not_composed" as const,
    reason:
      "Publication state is read-only; only eligible approvals use the existing guarded workflow.",
    workflows: [] as const,
    operationalActions: ["publication.approve"] as const,
  },
  {
    surface: "webhook-endpoints",
    mode: "managed" as const,
    workflows: [
      "create_draft",
      "activate",
      "disable",
      "inspect_history",
    ] as const,
    operationalActions: [] as const,
  },
  ...[
    "ai-catalog-snapshots",
    "ai-models",
    "ai-bindings",
    "ai-role-defaults",
    "ai-pricing-overrides",
    "ai-budgets",
    "collections",
    "retrieval-profiles",
    "prompt-profiles",
    "analysis-profiles",
    "workspaces",
    "principals",
    "role-assignments",
  ].map((surface) =>
    Object.freeze({
      surface,
      mode: "read_only" as const,
      reasonCode: "workflow_not_composed" as const,
      reason:
        "This existing control-plane record is visible, but its feature-owned change workflow is not composed.",
      workflows: [] as const,
      operationalActions: [] as const,
    }),
  ),
  // The implementation has no editable platform configuration path. These
  // values are deployment bootstrap only and remain explicitly read-only.
  {
    surface: "platform",
    mode: "managed" as const,
    workflows: ["create_draft", "activate", "inspect_history"] as const,
    operationalActions: [] as const,
  },
]);

/** Transport composition: derives identity from the server session and never from headers. */
export class AdministrationApiOperations
  implements AdministrationRouteOperations
{
  public constructor(
    private readonly dependencies: Readonly<{
      auth: AuthSessionService;
      reads: AdministrationReadStore;
      resources: AdministrationResourceReadStore;
      descriptors: DescriptorRegistry;
      unitOfWork: UnitOfWork;
      auditStore: AuditStore;
      authAudits: AuthAuditRecorder;
      auditWorkspaceId: string;
      dispatcher?: AdministrationOperationDispatcher;
      createDraft: (
        input: Readonly<{
          workspaceId: string;
          resourceType: string;
          displayName: string;
          descriptorType: string;
          settings: Record<string, unknown>;
          context: AdminRequestContext;
        }>,
      ) => Promise<{ id: string; revision: number }>;
      createSecretReference: (
        input: Readonly<{
          workspaceId: string;
          reference: string;
          context: AdminRequestContext;
        }>,
      ) => Promise<{ id: string; lifecycle: string }>;
      createKnowledgeSourceDraft: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly displayName: string;
          readonly connectorInstanceId: string;
          readonly collectionId: string;
          readonly normalizationProfileVersion: string;
          readonly chunkingProfileVersion: string;
          readonly synchronizationPolicy: Readonly<Record<string, unknown>>;
          readonly deletionBehavior: "tombstone" | "retain";
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<{ id: string; revision: number }>;
      createKnowledgeScheduleDraft: (
        input: Readonly<{
          readonly workspaceId: string;
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
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<{ id: string; revision: number }>;
      transitionKnowledgeSource: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly sourceId: string;
          readonly expectedRevision: number;
          readonly lifecycle: "active" | "disabled";
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<
        Readonly<{ readonly revision: number; readonly lifecycle: string }>
      >;
      transitionKnowledgeSchedule: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly scheduleId: string;
          readonly expectedRevision: number;
          readonly lifecycle: "active" | "disabled";
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<
        Readonly<{ readonly revision: number; readonly lifecycle: string }>
      >;
      createPublicationProfile?: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly displayName: string;
          readonly definition: Readonly<Record<string, unknown>>;
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<
        Readonly<{ readonly id: string; readonly revision: number }>
      >;
      transitionPublicationProfile?: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly profileId: string;
          readonly expectedRevision: number;
          readonly lifecycle: "active" | "disabled";
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<
        Readonly<{ readonly revision: number; readonly lifecycle: string }>
      >;
      createWebhookEndpoint?: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly displayName: string;
          readonly connectorInstanceId: string;
          readonly verifiedEventTypes: readonly string[];
          readonly maximumBodyBytes: number;
          readonly maximumRequestsPerMinute: number;
          readonly analysisTriggerId?: string;
          readonly settings: Readonly<Record<string, unknown>>;
          readonly secretReferenceRegistrationIds: readonly string[];
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<
        Readonly<{ readonly id: string; readonly revision: number }>
      >;
      transitionWebhookEndpoint?: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly endpointId: string;
          readonly expectedRevision: number;
          readonly lifecycle: "active" | "disabled";
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<
        Readonly<{ readonly revision: number; readonly lifecycle: string }>
      >;
      platformLinks?: (
        input: Readonly<{ readonly workspaceId: string }>,
      ) => Promise<unknown>;
      savePlatformLinks?: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly apiPublicBaseUrl: string;
          readonly webhookPublicBaseUrl: string;
          readonly expectedRevision?: number;
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<
        Readonly<{ readonly revision: number; readonly lifecycle: string }>
      >;
      createAiBindingDraft?: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly providerInstanceId: string;
          readonly catalogSnapshotId: string;
          readonly canonicalModel: string;
          readonly role: string;
          readonly requiredCapabilities?: readonly string[];
          readonly maximumInputTokens?: number;
          readonly maximumOutputTokens?: number;
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<
        Readonly<{ readonly id: string; readonly revision: number }>
      >;
      createAiBindingVersionDraft?: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly bindingId: string;
          readonly expectedRevision: number;
          readonly providerInstanceId: string;
          readonly catalogSnapshotId: string;
          readonly canonicalModel: string;
          readonly requiredCapabilities?: readonly string[];
          readonly maximumInputTokens?: number;
          readonly maximumOutputTokens?: number;
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<
        Readonly<{ readonly id: string; readonly revision: number }>
      >;
      transitionAiBinding?: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly bindingId: string;
          readonly expectedRevision: number;
          readonly lifecycle: "active" | "disabled";
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<
        Readonly<{ readonly revision: number; readonly lifecycle: string }>
      >;
      setAiRoleDefault?: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly role: string;
          readonly bindingVersionId: string;
          readonly expectedRevision: number;
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<
        Readonly<{
          readonly revision: number;
          readonly bindingVersionId: string;
        }>
      >;
      createAiPriceOverride?: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly overrideId?: string;
          readonly scope: "workspace" | "binding";
          readonly provider: string;
          readonly canonicalModel: string;
          readonly bindingVersionId?: string;
          readonly effectiveFrom: string;
          readonly effectiveTo?: string;
          readonly components: readonly Readonly<{
            readonly kind: string;
            readonly unit: string;
            readonly amount: string;
            readonly currency: string;
            readonly conditions?: Readonly<Record<string, unknown>>;
          }>[];
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<Readonly<{ readonly id: string }>>;
      replaceAiBudget?: (
        input: Readonly<{
          readonly workspaceId: string;
          readonly budgetPolicyId?: string;
          readonly scope: string;
          readonly scopeKey: string;
          readonly limitAmount: string;
          readonly currency: string;
          readonly hard: boolean;
          readonly expectedRevision: number;
          readonly context: AdminRequestContext;
        }>,
      ) => Promise<
        Readonly<{
          readonly id: string;
          readonly revision: number;
          readonly active: boolean;
        }>
      >;
      /** Capability checks are composed with the exclusive metered AI gateway.
       * The browser chooses only a descriptor operation key and confirmation. */
      providerCapabilityTests?: Readonly<{
        readonly preview: Pick<PreviewProviderCapabilityTest, "execute">;
        readonly run: Pick<RunProviderCapabilityTest, "execute">;
      }>;
      replaceWorkspacePrincipalRoles?: Pick<
        ReplaceWorkspacePrincipalRoles,
        "execute"
      >;
      workspaceRoleAssignments?: Pick<WorkspaceRoleAssignmentStore, "read">;
      diagnostics?: Readonly<{
        readonly requests: DiagnosticExportRequestStore &
          DiagnosticExportRequestMutationStore;
        readonly artifacts: DiagnosticExportArtifactStore;
      }>;
    }>,
  ) {}
  public async resolve(
    request: unknown,
    options: { readonly mutation: boolean },
  ): Promise<AdminRequestContext> {
    const input = request as RequestLike;
    const headers = input.headers ?? {};
    let context: Awaited<ReturnType<AuthSessionService["resolve"]>>;
    try {
      context = await this.dependencies.auth.resolve({
        cookieHeader: header(headers, "cookie"),
        mutation: options.mutation,
        origin: header(headers, "origin"),
        csrfToken: header(headers, "x-csrf-token"),
      });
    } catch (error) {
      await this.recordAuth(request, {
        workspaceId: this.dependencies.auditWorkspaceId,
        action: "auth.session.denied",
        outcome: "denied",
        targetType: "auth-session",
        targetId: "current",
        reasonCode: authReason(error),
      });
      throw error;
    }
    return Object.freeze({
      principalId: context.principalId,
      workspaceId: context.workspaceId,
      sessionId: context.session.id,
      permissions: context.permissions,
      requestId: input.id ?? randomUUID(),
      correlationId: randomUUID(),
      ...(typeof header(headers, "x-ui-action-id") === "string"
        ? { uiActionId: header(headers, "x-ui-action-id") }
        : {}),
      ...(typeof header(headers, "idempotency-key") === "string"
        ? { idempotencyKey: header(headers, "idempotency-key") }
        : {}),
      ...(traceId(header(headers, "traceparent")) === undefined
        ? {}
        : { traceId: traceId(header(headers, "traceparent")) }),
      ...(resolveAuditClientAddress({
        directAddress: input.ip,
        proxyTrusted: false,
      }) === undefined
        ? {}
        : {
            clientAddress: resolveAuditClientAddress({
              directAddress: input.ip,
              proxyTrusted: false,
            }),
          }),
      ...(header(headers, "user-agent") === undefined
        ? {}
        : { userAgent: header(headers, "user-agent") }),
      requestMode: "user",
    });
  }
  public async session(request: unknown) {
    const value = await this.dependencies.auth.session(
      header((request as RequestLike).headers ?? {}, "cookie"),
    );
    if (value.authenticated) {
      await this.recordAuth(request, {
        workspaceId: value.activeWorkspace.id,
        actorPrincipalId: value.principal.id,
        action: "auth.session.read",
        outcome: "succeeded",
        targetType: "auth-session",
        targetId: "current",
      });
    }
    return value;
  }
  public async login(request: unknown) {
    const returnTo = query((request as RequestLike).query, "returnTo");
    await this.recordAuth(request, {
      workspaceId: this.dependencies.auditWorkspaceId,
      action: "auth.login.initiated",
      outcome: "attempted",
      targetType: "oidc-login",
      targetId: "configured-issuer",
    });
    try {
      return await this.dependencies.auth.login(returnTo);
    } catch (error) {
      await this.recordAuth(request, {
        workspaceId: this.dependencies.auditWorkspaceId,
        action: "auth.login.failed",
        outcome: "failed",
        targetType: "oidc-login",
        targetId: "configured-issuer",
        reasonCode: authReason(error),
      });
      throw error;
    }
  }
  public async callback(request: unknown) {
    const q = (request as RequestLike).query;
    try {
      const response = await this.dependencies.auth.callback({
        code: query(q, "code"),
        state: query(q, "state"),
        audit: this.authAuditMetadata(request),
      });
      return response;
    } catch (error) {
      await this.recordAuth(request, {
        workspaceId: this.dependencies.auditWorkspaceId,
        action: "auth.login.failed",
        outcome: "failed",
        targetType: "oidc-login",
        targetId: "configured-issuer",
        reasonCode: authReason(error),
      });
      throw error;
    }
  }
  public async logout(request: unknown) {
    const h = (request as RequestLike).headers ?? {};
    try {
      const response = await this.dependencies.auth.logout({
        cookieHeader: header(h, "cookie"),
        origin: header(h, "origin"),
        csrfToken: header(h, "x-csrf-token"),
        audit: this.authAuditMetadata(request),
      });
      return response;
    } catch (error) {
      await this.recordAuth(request, {
        workspaceId: this.dependencies.auditWorkspaceId,
        action: "auth.logout.denied",
        outcome: "denied",
        targetType: "auth-session",
        targetId: "current",
        reasonCode: authReason(error),
      });
      throw error;
    }
  }
  public async switchWorkspace(request: unknown, workspaceId: string) {
    const h = (request as RequestLike).headers ?? {};
    try {
      const response = await this.dependencies.auth.switchWorkspace({
        cookieHeader: header(h, "cookie"),
        origin: header(h, "origin"),
        csrfToken: header(h, "x-csrf-token"),
        workspaceId,
        audit: this.authAuditMetadata(request),
      });
      return response;
    } catch (error) {
      await this.recordAuth(request, {
        workspaceId: this.dependencies.auditWorkspaceId,
        action: "auth.workspace.switch.denied",
        outcome: "denied",
        targetType: "workspace",
        targetId: workspaceId,
        reasonCode: authReason(error),
      });
      throw error;
    }
  }
  public async descriptors(
    kind: "connector" | "ai-provider",
    type?: string,
    context?: AdminRequestContext,
  ) {
    if (context !== undefined)
      await this.authorizeAndAudit(
        context,
        "configuration.read",
        `admin.descriptor.${kind}.read`,
        type ?? "catalog",
      );
    const values = await this.dependencies.descriptors.list({
      kind: kind === "connector" ? "connector" : "aiProvider",
      limit: 200,
    });
    const mapped = values
      .map(toDescriptor)
      .filter((entry) => type === undefined || entry.type === type);
    return Object.freeze({ items: mapped });
  }
  public async list(
    resource: AdminResource,
    queryValue: { readonly limit: number; readonly after?: string },
    context: AdminRequestContext,
  ) {
    const policy = policyForResource(resource);
    await this.authorizeAndAudit(
      context,
      policy.permission,
      policy.readAction,
      resource,
    );
    return this.dependencies.resources.list({
      workspaceId: context.workspaceId,
      resource,
      limit: queryValue.limit,
      ...(queryValue.after === undefined ? {} : { after: queryValue.after }),
    });
  }
  public async detail(
    resource: AdminResource,
    id: string,
    context: AdminRequestContext,
  ) {
    const policy = policyForResource(resource);
    await this.authorizeAndAudit(
      context,
      policy.permission,
      policy.readAction,
      id,
    );
    const row = await this.dependencies.resources.detail({
      workspaceId: context.workspaceId,
      resource,
      id,
    });
    if (row === undefined) throw new Error("resource.notFound");
    return row;
  }
  public async configurationInspection(
    configurationId: string,
    context: AdminRequestContext,
  ) {
    await this.authorizeAndAudit(
      context,
      "configuration.read",
      "admin.configuration.inspect",
      configurationId,
    );
    const value = await this.dependencies.resources.configurationInspection({
      workspaceId: context.workspaceId,
      configurationId,
    });
    if (value === undefined) throw new Error("resource.notFound");
    return value;
  }
  public async configurationHistory(
    configurationId: string,
    query: ConfigurationHistoryQuery,
    context: AdminRequestContext,
  ) {
    await this.authorizeAndAudit(
      context,
      "configuration.read",
      "admin.configuration.history.read",
      configurationId,
    );
    const value = await this.dependencies.resources.configurationHistory({
      workspaceId: context.workspaceId,
      configurationId,
      query,
    });
    if (value === undefined) throw new Error("resource.notFound");
    return value;
  }
  public async configurationVersion(
    configurationId: string,
    versionId: string,
    context: AdminRequestContext,
  ) {
    await this.authorizeAndAudit(
      context,
      "configuration.read",
      "admin.configuration.version.read",
      `${configurationId}:${versionId}`,
    );
    const value = await this.dependencies.resources.configurationVersion({
      workspaceId: context.workspaceId,
      configurationId,
      versionId,
    });
    if (value === undefined) throw new Error("resource.notFound");
    return value;
  }
  public async configurationSurfaces(context: AdminRequestContext) {
    await this.authorizeAndAudit(
      context,
      "configuration.read",
      "admin.configuration.surface.list",
      "catalog",
    );
    const surfaces = configurationSurfaces.map((surface) => {
      if (
        surface.surface === "publication-profiles" &&
        this.dependencies.createPublicationProfile === undefined
      ) {
        return Object.freeze({
          surface: "publication-profiles",
          mode: "read_only" as const,
          reasonCode: "workflow_not_composed" as const,
          reason:
            "Publication profile versions are visible, but profile authoring is not composed.",
          workflows: [] as const,
          operationalActions: [] as const,
        });
      }
      if (
        surface.surface === "webhook-endpoints" &&
        this.dependencies.createWebhookEndpoint === undefined
      ) {
        return Object.freeze({
          surface: "webhook-endpoints",
          mode: "unavailable" as const,
          reasonCode: "workflow_not_composed" as const,
          reason:
            "Verified delivery summaries are available, but endpoint configuration is not composed.",
          workflows: [] as const,
          operationalActions: [] as const,
        });
      }
      if (
        surface.surface === "platform" &&
        this.dependencies.savePlatformLinks === undefined
      ) {
        return Object.freeze({
          surface: "platform",
          mode: "read_only" as const,
          reasonCode: "deployment_owned" as const,
          reason:
            "Configured by the deployment and visible only as redacted status.",
          workflows: [] as const,
          operationalActions: [] as const,
        });
      }
      if (
        [
          "ai-bindings",
          "ai-role-defaults",
          "ai-pricing-overrides",
          "ai-budgets",
        ].includes(surface.surface) &&
        this.dependencies.createAiBindingDraft !== undefined &&
        this.dependencies.createAiBindingVersionDraft !== undefined &&
        this.dependencies.transitionAiBinding !== undefined &&
        this.dependencies.setAiRoleDefault !== undefined &&
        this.dependencies.createAiPriceOverride !== undefined &&
        this.dependencies.replaceAiBudget !== undefined
      ) {
        const workflows =
          surface.surface === "ai-bindings"
            ? ([
                "create_draft",
                "activate",
                "disable",
                "inspect_history",
              ] as const)
            : (["create", "replace", "inspect_history"] as const);
        return Object.freeze({
          surface: surface.surface,
          mode: "managed" as const,
          workflows,
          operationalActions: [] as const,
        });
      }
      return surface;
    });
    return Object.freeze({
      items: surfaces.map(toConfigurationSurfaceDto),
    });
  }
  public async createDraft(
    kind: "connector" | "ai-provider",
    input: {
      readonly descriptorType: string;
      readonly displayName: string;
      readonly settings: Record<string, unknown>;
    },
    context: AdminRequestContext,
  ) {
    const resourceType =
      kind === "connector" ? "connector-instances" : "ai-provider-instances";
    await this.authorizeAndAudit(
      context,
      "configuration.manage",
      "admin.configuration.draft.create.attempt",
      resourceType,
    );
    const created = await this.dependencies.createDraft({
      workspaceId: context.workspaceId,
      resourceType,
      displayName: input.displayName,
      descriptorType: input.descriptorType,
      settings: input.settings,
      context,
    });
    return Object.freeze({
      id: created.id,
      label: input.displayName,
      status: "draft",
      version: String(created.revision),
      fields: { descriptorType: input.descriptorType },
    });
  }
  public async createSecretReference(
    input: SecretReferenceRegistrationCommand,
    context: AdminRequestContext,
  ) {
    await this.authorizeAndAudit(
      context,
      "credential.manage",
      "admin.secretReference.create.attempt",
      "new",
    );
    const created = await this.dependencies.createSecretReference({
      workspaceId: context.workspaceId,
      reference: input.reference,
      context,
    });
    return Object.freeze({
      id: created.id,
      label: `Secret reference ${created.id}`,
      status: created.lifecycle,
      fields: Object.freeze({}),
    });
  }
  /**
   * A source draft is a resource-owned immutable configuration, not a generic
   * JSON document.  The feature projection validates the active connector
   * capability and collection ownership in the mutation transaction.
   */
  public async createKnowledgeSourceDraft(
    input: Readonly<{
      readonly displayName: string;
      readonly connectorInstanceId: string;
      readonly collectionId: string;
      readonly normalizationProfileVersion: string;
      readonly chunkingProfileVersion: string;
      readonly synchronizationPolicy: Readonly<Record<string, unknown>>;
      readonly deletionBehavior: "tombstone" | "retain";
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.knowledgeSource.draft.create.denied",
      "new",
    );
    const created = await this.dependencies.createKnowledgeSourceDraft({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: created.id,
      label: input.displayName,
      status: "draft",
      version: String(created.revision),
      fields: Object.freeze({}),
    });
  }
  /** Schedule authoring is separate from source authoring so a schedule can
   * only pin an immutable, workspace-owned source configuration version. */
  public async createKnowledgeScheduleDraft(
    input: Readonly<{
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
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.knowledgeSchedule.draft.create.denied",
      "new",
    );
    const created = await this.dependencies.createKnowledgeScheduleDraft({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: created.id,
      label: input.displayName,
      status: "draft",
      version: String(created.revision),
      fields: Object.freeze({}),
    });
  }
  /**
   * Source lifecycle derives its immutable projection from the current server
   * version. The browser supplies only the aggregate revision and requested
   * lifecycle; connector, collection, filters, and version references remain
   * server-owned.
   */
  public async transitionKnowledgeSource(
    input: Readonly<{
      readonly sourceId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.knowledgeSource.lifecycle.denied",
      input.sourceId,
    );
    const transitioned = await this.dependencies.transitionKnowledgeSource({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: input.sourceId,
      label: `Knowledge source ${input.sourceId}`,
      status: transitioned.lifecycle,
      version: String(transitioned.revision),
      fields: Object.freeze({}),
    });
  }
  /** Schedule lifecycle is an independent guarded workflow because enabling
   * one must preserve its pinned source version and verify that source is live. */
  public async transitionKnowledgeSchedule(
    input: Readonly<{
      readonly scheduleId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.knowledgeSchedule.lifecycle.denied",
      input.scheduleId,
    );
    const transitioned = await this.dependencies.transitionKnowledgeSchedule({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: input.scheduleId,
      label: `Knowledge schedule ${input.scheduleId}`,
      status: transitioned.lifecycle,
      version: String(transitioned.revision),
      fields: Object.freeze({}),
    });
  }
  public async createPublicationProfile(
    input: Readonly<{
      readonly displayName: string;
      readonly definition: Readonly<Record<string, unknown>>;
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.publicationProfile.draft.create.denied",
      "new",
    );
    const create = this.dependencies.createPublicationProfile;
    if (create === undefined) throw new AdministrationUnavailableError();
    const created = await create({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: created.id,
      label: input.displayName,
      status: "draft",
      version: String(created.revision),
      fields: Object.freeze({}),
    });
  }
  public async transitionPublicationProfile(
    input: Readonly<{
      readonly profileId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.publicationProfile.lifecycle.denied",
      input.profileId,
    );
    const transition = this.dependencies.transitionPublicationProfile;
    if (transition === undefined) throw new AdministrationUnavailableError();
    const result = await transition({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: input.profileId,
      label: `Publication profile ${input.profileId}`,
      status: result.lifecycle,
      version: String(result.revision),
      fields: Object.freeze({}),
    });
  }
  public async createWebhookEndpoint(
    input: Readonly<{
      readonly displayName: string;
      readonly connectorInstanceId: string;
      readonly verifiedEventTypes: readonly string[];
      readonly maximumBodyBytes: number;
      readonly maximumRequestsPerMinute: number;
      readonly analysisTriggerId?: string;
      readonly settings: Readonly<Record<string, unknown>>;
      readonly secretReferenceRegistrationIds: readonly string[];
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.webhookEndpoint.draft.create.denied",
      "new",
    );
    const create = this.dependencies.createWebhookEndpoint;
    if (create === undefined) throw new AdministrationUnavailableError();
    const created = await create({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: created.id,
      label: input.displayName,
      status: "draft",
      version: String(created.revision),
      fields: Object.freeze({}),
    });
  }
  public async transitionWebhookEndpoint(
    input: Readonly<{
      readonly endpointId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.webhookEndpoint.lifecycle.denied",
      input.endpointId,
    );
    const transition = this.dependencies.transitionWebhookEndpoint;
    if (transition === undefined) throw new AdministrationUnavailableError();
    const result = await transition({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: input.endpointId,
      label: `Webhook endpoint ${input.endpointId}`,
      status: result.lifecycle,
      version: String(result.revision),
      fields: Object.freeze({}),
    });
  }
  public async platformLinks(context: AdminRequestContext) {
    await this.authorizeAndAudit(
      context,
      "configuration.read",
      "admin.platformLink.read",
      "platform-links",
    );
    const find = this.dependencies.platformLinks;
    if (find === undefined) throw new AdministrationUnavailableError();
    const result = await find({ workspaceId: context.workspaceId });
    if (result === undefined) throw new Error("resource.notFound");
    return result;
  }
  public async savePlatformLinks(
    input: Readonly<{
      readonly apiPublicBaseUrl: string;
      readonly webhookPublicBaseUrl: string;
      readonly expectedRevision?: number;
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.platformLink.write.denied",
      "platform-links",
    );
    const save = this.dependencies.savePlatformLinks;
    if (save === undefined) throw new AdministrationUnavailableError();
    const result = await save({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: "platform-links",
      label: "Public links",
      status: result.lifecycle,
      version: String(result.revision),
      fields: Object.freeze({}),
    });
  }
  public async createAiBindingDraft(
    input: Readonly<{
      readonly providerInstanceId: string;
      readonly catalogSnapshotId: string;
      readonly canonicalModel: string;
      readonly role: string;
      readonly requiredCapabilities?: readonly string[];
      readonly maximumInputTokens?: number;
      readonly maximumOutputTokens?: number;
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.aiBinding.draft.create.denied",
      "new",
    );
    const create = this.dependencies.createAiBindingDraft;
    if (create === undefined) throw new AdministrationUnavailableError();
    const created = await create({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: created.id,
      label: `AI binding ${created.id}`,
      status: "draft",
      version: String(created.revision),
      fields: Object.freeze({}),
    });
  }
  public async createAiBindingVersionDraft(
    input: Readonly<{
      readonly bindingId: string;
      readonly expectedRevision: number;
      readonly providerInstanceId: string;
      readonly catalogSnapshotId: string;
      readonly canonicalModel: string;
      readonly requiredCapabilities?: readonly string[];
      readonly maximumInputTokens?: number;
      readonly maximumOutputTokens?: number;
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.aiBinding.version.draft.create.denied",
      input.bindingId,
    );
    const create = this.dependencies.createAiBindingVersionDraft;
    if (create === undefined) throw new AdministrationUnavailableError();
    const created = await create({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: created.id,
      label: `AI binding ${created.id}`,
      status: "draft",
      version: String(created.revision),
      fields: Object.freeze({}),
    });
  }
  public async transitionAiBinding(
    input: Readonly<{
      readonly bindingId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.aiBinding.lifecycle.denied",
      input.bindingId,
    );
    const transition = this.dependencies.transitionAiBinding;
    if (transition === undefined) throw new AdministrationUnavailableError();
    const result = await transition({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: input.bindingId,
      label: `AI binding ${input.bindingId}`,
      status: result.lifecycle,
      version: String(result.revision),
      fields: Object.freeze({}),
    });
  }
  public async setAiRoleDefault(
    input: Readonly<{
      readonly role: string;
      readonly bindingVersionId: string;
      readonly expectedRevision: number;
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.aiRoleDefault.set.denied",
      input.role,
    );
    const set = this.dependencies.setAiRoleDefault;
    if (set === undefined) throw new AdministrationUnavailableError();
    const result = await set({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: input.role,
      label: `AI role default ${input.role}`,
      status: "configured",
      version: String(result.revision),
      fields: Object.freeze({ bindingVersionId: result.bindingVersionId }),
    });
  }
  public async createAiPriceOverride(
    input: Readonly<{
      readonly overrideId?: string;
      readonly scope: "workspace" | "binding";
      readonly provider: string;
      readonly canonicalModel: string;
      readonly bindingVersionId?: string;
      readonly effectiveFrom: string;
      readonly effectiveTo?: string;
      readonly components: readonly Readonly<{
        readonly kind: string;
        readonly unit: string;
        readonly amount: string;
        readonly currency: string;
        readonly conditions?: Readonly<Record<string, unknown>>;
      }>[];
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.aiPriceOverride.create.denied",
      "new",
    );
    const create = this.dependencies.createAiPriceOverride;
    if (create === undefined) throw new AdministrationUnavailableError();
    const result = await create({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: result.id,
      label: `AI price override ${result.id}`,
      status: "configured",
      fields: Object.freeze({}),
    });
  }
  public async replaceAiBudget(
    input: Readonly<{
      readonly budgetPolicyId?: string;
      readonly scope: string;
      readonly scopeKey: string;
      readonly limitAmount: string;
      readonly currency: string;
      readonly hard: boolean;
      readonly expectedRevision: number;
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.aiBudgetPolicy.replace.denied",
      input.scopeKey,
    );
    const replace = this.dependencies.replaceAiBudget;
    if (replace === undefined) throw new AdministrationUnavailableError();
    const result = await replace({
      workspaceId: context.workspaceId,
      ...input,
      context,
    });
    return Object.freeze({
      id: result.id,
      label: `AI budget ${result.id}`,
      status: result.active ? "active" : "disabled",
      version: String(result.revision),
      fields: Object.freeze({}),
    });
  }
  /** The operation key is a descriptor-owned contract; no request, model, or
   * provider credential is disclosed by discovery. */
  public async providerCapabilityTestOperations(
    providerInstanceId: string,
    context: AdminRequestContext,
  ) {
    await this.authorizeAndAudit(
      context,
      "configuration.read",
      "admin.provider.capabilityTest.operations.read",
      providerInstanceId,
    );
    if (this.dependencies.providerCapabilityTests === undefined) {
      throw new AdministrationUnavailableError();
    }
    return Object.freeze({
      items: Object.freeze([
        Object.freeze({
          operation: "provider.test",
          requiresConfirmation: true,
          requiresIdempotencyKey: true,
        }),
      ]),
    });
  }
  /** Preview auditing is owned by the administration use case because issuance
   * and its append-only audit must commit atomically. */
  public async previewProviderCapabilityTest(
    input: Readonly<{
      readonly providerInstanceId: string;
      readonly testOperation: string;
    }>,
    context: AdminRequestContext,
  ) {
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.provider.capabilityTest.preview.denied",
      input.providerInstanceId,
    );
    const tests = this.dependencies.providerCapabilityTests;
    if (tests === undefined) throw new AdministrationUnavailableError();
    return tests.preview.execute({
      workspaceId: context.workspaceId,
      principalId: context.principalId,
      sessionId: context.sessionId,
      providerInstanceId: input.providerInstanceId,
      testOperation: input.testOperation,
      auditMetadata: providerCapabilityAuditMetadata(context),
    });
  }
  /** Execution carries a server-derived idempotency digest and never returns a
   * model response, an endpoint, or credential material. */
  public async runProviderCapabilityTest(
    input: Readonly<{
      readonly providerInstanceId: string;
      readonly testOperation: string;
      readonly confirmationId: string;
    }>,
    context: AdminRequestContext,
  ) {
    if (context.idempotencyKey === undefined) {
      throw new AdministrationUnavailableError();
    }
    await this.requireMutationPermission(
      context,
      "configuration.manage",
      "admin.provider.capabilityTest.execute.denied",
      input.providerInstanceId,
    );
    const tests = this.dependencies.providerCapabilityTests;
    if (tests === undefined) throw new AdministrationUnavailableError();
    return tests.run.execute({
      workspaceId: context.workspaceId,
      principalId: context.principalId,
      sessionId: context.sessionId,
      providerInstanceId: input.providerInstanceId,
      testOperation: input.testOperation,
      confirmationId: input.confirmationId,
      idempotency: { keyDigest: digestIdempotencyKey(context.idempotencyKey) },
      signal: new AbortController().signal,
      auditMetadata: providerCapabilityAuditMetadata(context),
    });
  }
  /** Replaces a principal's role set through the persisted-membership use case.
   * Workspace and actor derive from the cookie session; the browser supplies
   * only a target, roles, expected aggregate revision, and idempotency key. */
  public async replaceWorkspacePrincipalRoles(
    input: Readonly<{
      readonly targetPrincipalId: string;
      readonly roles: readonly import("@caseweaver/security").WorkspaceRole[];
      readonly expectedRevision: number;
    }>,
    context: AdminRequestContext,
  ) {
    if (context.idempotencyKey === undefined) {
      throw new AdministrationUnavailableError();
    }
    await this.requireMutationPermission(
      context,
      "identity.manage",
      "admin.roleAssignment.replace.denied",
      input.targetPrincipalId,
    );
    const useCase = this.dependencies.replaceWorkspacePrincipalRoles;
    if (useCase === undefined) throw new AdministrationUnavailableError();
    const result = await useCase.execute(
      {
        targetPrincipalId: input.targetPrincipalId,
        roles: input.roles,
        expectedRevision: input.expectedRevision,
        mutation: {
          operation: "admin.roleAssignment.replace",
          keyDigest: digestIdempotencyKey(context.idempotencyKey),
          requestDigest: digestIdempotencyKey(
            canonicalizeConfiguration({
              targetPrincipalId: input.targetPrincipalId,
              roles: [...input.roles].sort(),
              expectedRevision: input.expectedRevision,
            }),
          ),
        },
      },
      {
        workspaceId: context.workspaceId,
        actorPrincipalId: context.principalId,
        occurredAt: new Date().toISOString(),
        origin: "admin_ui",
        requestId: context.requestId,
        correlationId: context.correlationId,
        ...(context.uiActionId === undefined
          ? {}
          : { uiActionId: context.uiActionId }),
        idempotencyKeyDigest: digestIdempotencyKey(context.idempotencyKey),
      },
    );
    return Object.freeze({
      id: result.assignment.principalId,
      label: `Roles for ${result.assignment.principalId}`,
      status: result.idempotency === "replayed" ? "replayed" : "updated",
      version: String(result.assignment.revision),
      fields: Object.freeze({ roles: result.assignment.roles.join(", ") }),
    });
  }
  /** An audited snapshot contains only code-owned roles and the workspace-wide
   * revision needed for optimistic role replacement. */
  public async workspacePrincipalRoles(
    targetPrincipalId: string,
    context: AdminRequestContext,
  ) {
    await this.authorizeAndAudit(
      context,
      "identity.manage",
      "admin.roleAssignment.inspect",
      targetPrincipalId,
    );
    const store = this.dependencies.workspaceRoleAssignments;
    if (store === undefined) throw new AdministrationUnavailableError();
    const assignment = await store.read({
      workspaceId: context.workspaceId,
      principalId: targetPrincipalId,
    });
    if (assignment === undefined) throw new Error("resource.notFound");
    return Object.freeze({
      principalId: assignment.principalId,
      roles: Object.freeze([...assignment.roles]),
      revision: assignment.revision,
    });
  }
  /**
   * Accepts a bounded diagnostics export. The request, opaque worker envelope,
   * and success audit are one PostgreSQL transaction; no artifact data is read
   * or returned from this UI command.
   */
  public async requestDiagnosticExport(context: AdminRequestContext) {
    const diagnostics = this.dependencies.diagnostics;
    if (diagnostics === undefined || context.idempotencyKey === undefined) {
      throw new AdministrationUnavailableError();
    }
    if (!context.permissions.includes("diagnostics.export")) {
      await this.authorizeAndAudit(
        context,
        "diagnostics.export",
        "admin.diagnostics.export.requested",
        "new",
      );
      throw new AdministrationUnavailableError();
    }
    const now = new Date();
    const exportId = randomUUID();
    const envelope = createEnvelope<"diagnostics.export.generate.v1">({
      id: outboxEnvelopeId(randomUUID()),
      kind: "command",
      type: "diagnostics.export.generate.v1",
      schemaVersion: 1,
      workspaceId: workspaceId(context.workspaceId),
      occurredAt: utcInstant(now),
      correlationId: correlationId(context.correlationId),
      causationId: causationId(context.requestId),
      payload: { exportId },
    });
    const audit: AuditRecord = {
      id: auditEventId(randomUUID()),
      workspaceId: workspaceId(context.workspaceId),
      actorPrincipalId: principalId(context.principalId),
      action: "admin.diagnostics.export.requested",
      targetId: exportId,
      targetType: "diagnostic_export",
      permission: "diagnostics.export",
      outcome: "succeeded",
      origin: "admin_ui",
      occurredAt: utcInstant(now),
      requestId: context.requestId,
      correlationId: context.correlationId,
      ...(context.uiActionId === undefined
        ? {}
        : { uiActionId: context.uiActionId }),
      idempotencyKeyDigest: digestIdempotencyKey(context.idempotencyKey),
    };
    return requestDiagnosticExport(
      {
        request: (input) =>
          diagnostics.requests.requestAndEnqueueAndRecord({
            ...input,
            envelope,
            audit,
          }),
      },
      { now: () => now.toISOString() },
      {
        id: exportId,
        workspaceId: context.workspaceId,
        requestedByPrincipalId: context.principalId,
        idempotencyKeyDigest: digestIdempotencyKey(context.idempotencyKey),
        requestDigest: digestIdempotencyKey("diagnostics.export.request.v1"),
        expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      },
    ).then((result) => result.status);
  }
  public async diagnosticExportStatus(
    exportId: string,
    context: AdminRequestContext,
  ) {
    const diagnostics = this.dependencies.diagnostics;
    if (diagnostics === undefined) throw new AdministrationUnavailableError();
    await this.authorizeAndAudit(
      context,
      "diagnostics.export",
      "admin.diagnostics.export.status.read",
      exportId,
    );
    const request = await diagnostics.requests.find({
      workspaceId: context.workspaceId,
      exportId,
    });
    if (request === undefined) throw new Error("resource.notFound");
    return toDiagnosticExportStatus(request);
  }
  public async downloadDiagnosticExport(
    exportId: string,
    context: AdminRequestContext,
  ): Promise<
    Readonly<{
      readonly content: AsyncIterable<Uint8Array>;
      readonly fileName: string;
    }>
  > {
    const diagnostics = this.dependencies.diagnostics;
    if (diagnostics === undefined) throw new AdministrationUnavailableError();
    const request = await diagnostics.requests.find({
      workspaceId: context.workspaceId,
      exportId,
    });
    if (
      request === undefined ||
      request.status !== "ready" ||
      request.artifactLocator === undefined
    ) {
      throw new Error("resource.notFound");
    }
    // Resolve the private stream before the audit write, but never iterate it
    // until the sensitive-read audit succeeds.
    const content = await diagnostics.artifacts.open({
      handle: { workspaceId: context.workspaceId, exportId },
      locator: request.artifactLocator,
      signal: new AbortController().signal,
    });
    await this.authorizeAndAudit(
      context,
      "diagnostics.export",
      "admin.diagnostics.export.download",
      exportId,
    );
    return Object.freeze({
      content,
      fileName: `caseweaver-diagnostics-${exportId}.json`,
    });
  }
  public async previewAction(
    input: {
      readonly action:
        | "connector.test"
        | "connector.activate"
        | "connector.disable"
        | "provider.test"
        | "provider.activate"
        | "provider.disable"
        | "source.synchronize"
        | "source.fullRescan"
        | "dead-letter.retry"
        | "job.cancel"
        | "job.recover"
        | "retention.reap"
        | "privacy.purge"
        | "diagnostics.export"
        | "secret.rotate"
        | "secret.revoke"
        | "publication.approve";
      readonly resource: AdminResource;
      readonly id?: string;
    },
    context: AdminRequestContext,
  ) {
    const policy = policyForAction(input.action);
    await this.authorizeAndAudit(
      context,
      policy.permission,
      policy.actionCode,
      input.id ?? input.resource,
    );
    const mapped = mapRoutedOperation(input);
    if (
      this.dependencies.dispatcher === undefined ||
      mapped.kind === "unavailable"
    ) {
      return Object.freeze({
        previewId: randomUUID(),
        action: input.action,
        confirmation: "Operation unavailable.",
        impact:
          "No command will be submitted for this unsupported control-plane action.",
        canConfirm: false,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    const preview = await this.dependencies.dispatcher.preview(
      mapped.command,
      context,
    );
    return Object.freeze({
      previewId: preview.id,
      action: input.action,
      confirmation: preview.confirmation,
      impact: preview.impact,
      canConfirm: preview.canConfirm,
      ...(preview.estimatedCost === undefined
        ? {}
        : { estimatedCost: preview.estimatedCost }),
      expiresAt: preview.expiresAt,
    });
  }
  public async previewPrivacyPurge(
    input: Readonly<{
      readonly caseSnapshotId: string;
      readonly reason: string;
    }>,
    context: AdminRequestContext,
  ) {
    await this.authorizeAndAudit(
      context,
      "privacy.delete",
      "admin.privacy.purge.preview",
      input.caseSnapshotId,
    );
    const mapped = mapPrivacyPurge(input);
    if (this.dependencies.dispatcher === undefined) {
      return Object.freeze({
        previewId: randomUUID(),
        action: "privacy.purge",
        confirmation: "Operation unavailable.",
        impact:
          "No privacy purge will be submitted until the server-side workflow is composed.",
        canConfirm: false,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    const preview = await this.dependencies.dispatcher.preview(
      mapped.command,
      context,
    );
    return Object.freeze({
      previewId: preview.id,
      action: "privacy.purge",
      confirmation: preview.confirmation,
      impact: preview.impact,
      canConfirm: preview.canConfirm,
      expiresAt: preview.expiresAt,
    });
  }
  public async executeAction(previewId: string, context: AdminRequestContext) {
    await this.auditExecution(context, previewId, "attempted");
    if (
      this.dependencies.dispatcher === undefined ||
      context.idempotencyKey === undefined
    ) {
      throw new AdministrationUnavailableError();
    }
    try {
      return await this.dependencies.dispatcher.execute(
        previewId,
        digestIdempotencyKey(context.idempotencyKey),
        context,
      );
    } catch (error) {
      await this.auditExecution(context, previewId, "denied");
      throw error;
    }
  }
  private async authorizeAndAudit(
    context: AdminRequestContext,
    permission: import("@caseweaver/security").Permission,
    action: string,
    targetId: string,
  ) {
    const authorized = context.permissions.includes(permission);
    await this.dependencies.unitOfWork.transaction(async (transaction) =>
      this.dependencies.auditStore.append(transaction, {
        id: auditEventId(randomUUID()),
        workspaceId: workspaceId(context.workspaceId),
        actorPrincipalId: principalId(context.principalId),
        action,
        targetId,
        occurredAt: utcInstant(new Date()),
        origin: "admin_ui",
        targetType: "administration",
        outcome: authorized ? "succeeded" : "denied",
        permission,
        ...(!authorized ? { reasonCode: "authorization.denied" } : {}),
        requestId: context.requestId,
        correlationId: context.correlationId,
        ...(context.uiActionId === undefined
          ? {}
          : { uiActionId: context.uiActionId }),
        ...(context.idempotencyKey === undefined
          ? {}
          : {
              idempotencyKeyDigest: digestIdempotencyKey(
                context.idempotencyKey,
              ),
            }),
      }),
    );
    if (!authorized) throw new Error("authorization.denied");
  }

  /** Successful mutations receive their authoritative audit from the
   * transaction-owning use case.  This helper records only denied attempts,
   * avoiding a misleading pre-commit success audit. */
  private async requireMutationPermission(
    context: AdminRequestContext,
    permission: import("@caseweaver/security").Permission,
    action: string,
    targetId: string,
  ): Promise<void> {
    if (context.permissions.includes(permission)) return;
    await this.authorizeAndAudit(context, permission, action, targetId);
  }

  /** Auth reads and transitions fail closed: no session/cookie response is
   * returned after audit persistence fails. Only Fastify's trusted `request.ip`
   * is used; raw forwarding headers are never inspected here. */
  private async recordAuth(
    request: unknown,
    input: Readonly<{
      readonly workspaceId: string;
      readonly actorPrincipalId?: string;
      readonly action: AuthAuditAction;
      readonly outcome: "attempted" | "succeeded" | "failed" | "denied";
      readonly targetType: "oidc-login" | "auth-session" | "workspace";
      readonly targetId?: string;
      readonly reasonCode?: AuthAuditReasonCode;
    }>,
  ): Promise<void> {
    try {
      await this.dependencies.authAudits.record(
        createAuthAuditPlan({
          ...input,
          ...this.authAuditMetadata(request),
        }),
      );
    } catch {
      // Authentication is a sensitive control-plane boundary. A response must
      // not be issued when its audit record cannot be persisted.
      throw new AdministrationUnavailableError();
    }
  }

  private authAuditMetadata(request: unknown): AuthAuditRequestMetadata {
    const requestLike = request as RequestLike;
    const headers = requestLike.headers ?? {};
    const idempotencyKey = header(headers, "idempotency-key");
    const clientAddress = resolveAuditClientAddress({
      directAddress: requestLike.ip,
      proxyTrusted: false,
    });
    return Object.freeze({
      occurredAt: new Date().toISOString(),
      ...(requestLike.id === undefined ? {} : { requestId: requestLike.id }),
      correlationId: randomUUID(),
      ...(header(headers, "x-ui-action-id") === undefined
        ? {}
        : { uiActionId: header(headers, "x-ui-action-id") }),
      ...(idempotencyKey === undefined
        ? {}
        : { idempotencyKeyDigest: digestIdempotencyKey(idempotencyKey) }),
      ...(clientAddress === undefined ? {} : { clientAddress }),
      ...(header(headers, "user-agent") === undefined
        ? {}
        : { userAgent: header(headers, "user-agent") }),
    });
  }

  private async auditExecution(
    context: AdminRequestContext,
    previewId: string,
    outcome: "attempted" | "denied",
  ): Promise<void> {
    await this.dependencies.unitOfWork.transaction(async (transaction) =>
      this.dependencies.auditStore.append(transaction, {
        id: auditEventId(randomUUID()),
        workspaceId: workspaceId(context.workspaceId),
        actorPrincipalId: principalId(context.principalId),
        action: "admin.action.execute",
        targetId: previewId,
        targetType: "administration_action_preview",
        outcome,
        ...(outcome === "denied" ? { reasonCode: "operation.denied" } : {}),
        origin: "admin_ui",
        occurredAt: utcInstant(new Date()),
        requestId: context.requestId,
        correlationId: context.correlationId,
        ...(context.uiActionId === undefined
          ? {}
          : { uiActionId: context.uiActionId }),
        ...(context.idempotencyKey === undefined
          ? {}
          : {
              idempotencyKeyDigest: digestIdempotencyKey(
                context.idempotencyKey,
              ),
            }),
      }),
    );
  }
}
function header(
  headers: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === "string" && value.length <= 8_192 ? value : undefined;
}
function query(value: unknown, name: string): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[name] === "string"
    ? (value as Record<string, string>)[name]
    : undefined;
}
function traceId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parts = value.split("-");
  const candidate = parts[1];
  return candidate !== undefined && /^[a-f0-9]{32}$/iu.test(candidate)
    ? candidate
    : undefined;
}
function providerCapabilityAuditMetadata(
  context: AdminRequestContext,
): Readonly<{
  readonly requestId: string;
  readonly correlationId: string;
  readonly uiActionId?: string;
  readonly traceId?: string;
  readonly clientAddress?: string;
  readonly userAgent?: string;
}> {
  return Object.freeze({
    requestId: context.requestId,
    correlationId: context.correlationId,
    ...(context.uiActionId === undefined
      ? {}
      : { uiActionId: context.uiActionId }),
    ...(context.traceId === undefined ? {} : { traceId: context.traceId }),
    ...(context.clientAddress === undefined
      ? {}
      : { clientAddress: context.clientAddress }),
    ...(context.userAgent === undefined
      ? {}
      : { userAgent: context.userAgent }),
  });
}
function authReason(error: unknown): AuthAuditReasonCode {
  switch (error instanceof Error ? error.message : "") {
    case "auth.identity.unmapped":
      return "identity.unmapped";
    case "auth.session.required":
      return "session.required";
    case "auth.csrf.invalid":
      return "csrf.invalid";
    case "auth.origin.invalid":
      return "origin.invalid";
    case "auth.workspace.denied":
      return "workspace.denied";
    default:
      return "callback.invalid";
  }
}
function toDescriptor(value: ConfigurationDescriptor) {
  return Object.freeze({
    kind: value.kind === "connector" ? "connector" : "ai-provider",
    type: value.type,
    version: value.version,
    displayName: value.displayName,
    description: value.description,
    ...(value.documentationUrl === undefined
      ? {}
      : { documentationUrl: value.documentationUrl }),
    connectorCapabilities: value.connectorCapabilities,
    aiCapabilities: value.aiCapabilities,
    supportedWireApis: value.supportedWireApis,
    supportedWebhookEventTypes: value.supportedWebhookEventTypes,
    settingsSchema: value.settingsSchema,
    uiGroups: value.uiGroups,
    secretSlots: value.secretSlots,
    supportsConfigurationMigration: value.supportsConfigurationMigration,
    supportedTestOperations: value.supportedTestOperations,
  });
}
