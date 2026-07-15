import { z } from "zod";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const nonSensitiveTextSchema = z.string().trim().min(1).max(2_000);

export const resourceNames = [
  "overview",
  "secret-references",
  "connector-instances",
  "knowledge-sources",
  "schedules",
  "publication-profiles",
  "webhook-endpoints",
  "ai-provider-instances",
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
  "analyses",
  "publications",
  "operation-jobs",
  "dead-letters",
  "costs",
  "retention",
  "privacy",
  "diagnostics",
  "audit-events",
  "workspaces",
  "principals",
  "role-assignments",
  "platform",
] as const;

export type AdminResourceName = (typeof resourceNames)[number];

export const resourceEndpoints: Readonly<
  Record<AdminResourceName, { readonly list: string; readonly detail?: string }>
> = {
  overview: { list: "/v1/admin/overview" },
  "secret-references": {
    list: "/v1/admin/secret-references",
    detail: "/v1/admin/secret-references",
  },
  "connector-instances": {
    list: "/v1/admin/connector-instances",
    detail: "/v1/admin/connector-instances",
  },
  "knowledge-sources": {
    list: "/v1/admin/knowledge-sources",
    detail: "/v1/admin/knowledge-sources",
  },
  schedules: { list: "/v1/admin/schedules", detail: "/v1/admin/schedules" },
  "publication-profiles": {
    list: "/v1/admin/publication-profiles",
    detail: "/v1/admin/publication-profiles",
  },
  "webhook-endpoints": {
    list: "/v1/admin/webhook-endpoints",
    detail: "/v1/admin/webhook-endpoints",
  },
  "ai-provider-instances": {
    list: "/v1/admin/ai/provider-instances",
    detail: "/v1/admin/ai/provider-instances",
  },
  "ai-catalog-snapshots": {
    list: "/v1/admin/ai/catalog-snapshots",
    detail: "/v1/admin/ai/catalog-snapshots",
  },
  "ai-models": { list: "/v1/admin/ai/models", detail: "/v1/admin/ai/models" },
  "ai-bindings": {
    list: "/v1/admin/ai/bindings",
    detail: "/v1/admin/ai/bindings",
  },
  "ai-role-defaults": {
    list: "/v1/admin/ai/role-defaults",
    detail: "/v1/admin/ai/role-defaults",
  },
  "ai-pricing-overrides": {
    list: "/v1/admin/ai/pricing-overrides",
    detail: "/v1/admin/ai/pricing-overrides",
  },
  "ai-budgets": {
    list: "/v1/admin/ai/budgets",
    detail: "/v1/admin/ai/budgets",
  },
  collections: {
    list: "/v1/admin/collections",
    detail: "/v1/admin/collections",
  },
  "retrieval-profiles": {
    list: "/v1/admin/retrieval-profiles",
    detail: "/v1/admin/retrieval-profiles",
  },
  "prompt-profiles": {
    list: "/v1/admin/prompt-profiles",
    detail: "/v1/admin/prompt-profiles",
  },
  "analysis-profiles": {
    list: "/v1/admin/analysis-profiles",
    detail: "/v1/admin/analysis-profiles",
  },
  analyses: { list: "/v1/admin/analyses", detail: "/v1/admin/analyses" },
  publications: {
    list: "/v1/admin/publications",
    detail: "/v1/admin/publications",
  },
  "operation-jobs": {
    list: "/v1/admin/operations/jobs",
    detail: "/v1/admin/operations/jobs",
  },
  "dead-letters": {
    list: "/v1/admin/operations/dead-letters",
    detail: "/v1/admin/operations/dead-letters",
  },
  costs: { list: "/v1/admin/costs", detail: "/v1/admin/costs" },
  retention: { list: "/v1/admin/retention" },
  privacy: { list: "/v1/admin/privacy" },
  diagnostics: { list: "/v1/admin/diagnostics" },
  "audit-events": {
    list: "/v1/admin/audit-events",
    detail: "/v1/admin/audit-events",
  },
  workspaces: {
    list: "/v1/admin/workspaces",
    detail: "/v1/admin/workspaces",
  },
  principals: {
    list: "/v1/admin/principals",
    detail: "/v1/admin/principals",
  },
  "role-assignments": {
    list: "/v1/admin/role-assignments",
    detail: "/v1/admin/role-assignments",
  },
  platform: { list: "/v1/admin/platform" },
} as const;

export interface AdminListItem {
  readonly id: string;
  readonly label: string;
  readonly status?: string;
  readonly version?: string;
  readonly updatedAt?: string;
  readonly summary?: string;
}

const adminListItemSchema: z.ZodType<AdminListItem> = z
  .object({
    id: identifierSchema,
    label: nonSensitiveTextSchema,
    status: z.string().trim().min(1).max(80).optional(),
    version: z.string().trim().min(1).max(80).optional(),
    updatedAt: z.string().datetime({ offset: true }).optional(),
    summary: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export interface CursorPage {
  readonly hasNextPage: boolean;
  readonly endCursor?: string;
}

export interface AdminListResponse {
  readonly items: readonly AdminListItem[];
  readonly page: CursorPage;
}

export const adminListResponseSchema: z.ZodType<AdminListResponse> = z
  .object({
    items: z.array(adminListItemSchema).max(200),
    page: z
      .object({
        hasNextPage: z.boolean(),
        endCursor: z.string().min(1).max(500).optional(),
      })
      .strict(),
  })
  .strict();

export interface AdminDetail extends AdminListItem {
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

export interface WorkspaceRoleAssignment {
  readonly principalId: string;
  readonly roles: readonly (
    | "administrator"
    | "operator"
    | "analyst"
    | "viewer"
  )[];
  /** Revision of the complete workspace membership set. */
  readonly revision: number;
}

export const workspaceRoleAssignmentSchema: z.ZodType<WorkspaceRoleAssignment> =
  z
    .object({
      principalId: identifierSchema,
      roles: z
        .array(z.enum(["administrator", "operator", "analyst", "viewer"]))
        .max(4),
      revision: z.number().int().min(0),
    })
    .strict();

export const adminDetailSchema: z.ZodType<AdminDetail> = z
  .object({
    id: identifierSchema,
    label: nonSensitiveTextSchema,
    status: z.string().trim().min(1).max(80).optional(),
    version: z.string().trim().min(1).max(80).optional(),
    updatedAt: z.string().datetime({ offset: true }).optional(),
    summary: z.string().trim().min(1).max(1_000).optional(),
    fields: z.record(
      z.string().min(1).max(100),
      z.union([
        z.string().max(1_000),
        z.number().finite(),
        z.boolean(),
        z.null(),
      ]),
    ),
  })
  .strict();

export interface ConfigurationVersionSummary {
  readonly id: string;
  readonly version: number;
  readonly createdAt: string;
  readonly canonicalSettingsSha256: string;
  readonly secretReferenceCount: number;
  readonly descriptor?: Readonly<{
    readonly kind: "connector" | "aiProvider";
    readonly type: string;
    readonly version: string;
  }>;
}

const configurationVersionSummarySchema: z.ZodType<ConfigurationVersionSummary> =
  z
    .object({
      id: identifierSchema,
      version: z.number().int().positive(),
      createdAt: z.string().datetime({ offset: true }),
      canonicalSettingsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      secretReferenceCount: z.number().int().min(0).max(100),
      descriptor: z
        .object({
          kind: z.enum(["connector", "aiProvider"]),
          type: identifierSchema,
          version: identifierSchema,
        })
        .strict()
        .optional(),
    })
    .strict();

export interface ConfigurationInspection {
  readonly id: string;
  readonly resourceType: string;
  readonly lifecycle: "draft" | "active" | "disabled" | "superseded";
  readonly revision: number;
  readonly updatedAt: string;
  readonly currentVersionId?: string;
  readonly currentVersion?: ConfigurationVersionSummary;
}

export const configurationInspectionSchema: z.ZodType<ConfigurationInspection> =
  z
    .object({
      id: identifierSchema,
      resourceType: identifierSchema,
      lifecycle: z.enum(["draft", "active", "disabled", "superseded"]),
      revision: z.number().int().positive(),
      updatedAt: z.string().datetime({ offset: true }),
      currentVersionId: identifierSchema.optional(),
      currentVersion: configurationVersionSummarySchema.optional(),
    })
    .strict();

/** Public workspace links are safe configuration, but never deployment OIDC,
 * proxy, credential, or secret status. */
export interface PlatformLinkConfiguration {
  readonly workspaceId: string;
  readonly configurationId: string;
  readonly configurationVersionId: string;
  readonly revision: number;
  readonly lifecycle: "draft" | "active" | "disabled" | "superseded";
  readonly settings: Readonly<{
    readonly apiPublicBaseUrl: string;
    readonly webhookPublicBaseUrl: string;
  }>;
}

/** Browser-safe AI authoring inputs. Provider endpoint, wire API, parameters,
 * catalog model data, and secret locator are resolved server-side. */
export interface AiBindingDraftRequest {
  readonly providerInstanceId: string;
  readonly catalogSnapshotId: string;
  readonly canonicalModel: string;
  readonly role:
    | "embedding"
    | "vision"
    | "analysis"
    | "repositoryAgent"
    | "keywordExtraction"
    | "reranker"
    | "chat";
  readonly requiredCapabilities?: readonly (
    | "vision"
    | "structuredOutput"
    | "tools"
    | "promptCaching"
    | "reranking"
    | "repositoryAgent"
  )[];
  readonly maximumInputTokens?: number;
  readonly maximumOutputTokens?: number;
}

export interface AiRoleDefaultRequest {
  readonly bindingVersionId: string;
  readonly expectedRevision: number;
}

export interface AiPriceOverrideRequest {
  readonly overrideId?: string;
  readonly scope: "workspace" | "binding";
  readonly provider: string;
  readonly canonicalModel: string;
  readonly bindingVersionId?: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly components: readonly Readonly<{
    readonly kind:
      | "input"
      | "output"
      | "cacheRead"
      | "cacheCreation"
      | "image"
      | "audio";
    readonly unit: "token" | "image" | "audio";
    readonly amount: string;
    readonly currency: string;
    readonly conditions?: Readonly<Record<string, unknown>>;
  }>[];
}

export interface AiBudgetRequest {
  readonly budgetPolicyId?: string;
  readonly scope: "operation" | "analysis" | "day" | "workspace";
  readonly scopeKey: string;
  readonly limitAmount: string;
  readonly currency: string;
  readonly hard: boolean;
  readonly expectedRevision: number;
}

export interface ProviderCapabilityTestOperation {
  readonly operation: string;
  readonly requiresConfirmation: boolean;
  readonly requiresIdempotencyKey: boolean;
}

export interface ProviderCapabilityTestPreview {
  readonly providerInstanceId: string;
  readonly providerInstanceVersionId: string;
  readonly bindingVersionId: string;
  readonly testOperation: string;
  readonly pricingStatus: "known" | "unknown" | "incomplete";
  readonly canConfirm: boolean;
  readonly reasonCode?: "pricing.unknown" | "budget.policy_missing";
  readonly confirmationId?: string;
  readonly confirmation?: string;
  readonly impact?: string;
  readonly estimatedCost?: Readonly<{
    readonly amount: string;
    readonly currency: string;
  }>;
  readonly expiresAt?: string;
}

export interface ProviderCapabilityTestResult {
  readonly id: string;
  readonly providerInstanceId: string;
  readonly providerInstanceVersionId: string;
  readonly bindingVersionId: string;
  readonly testOperation: string;
  readonly outcome: "succeeded" | "failed" | "denied" | "outcome_unknown";
  readonly operationId?: string;
  readonly estimatedCost?: Readonly<{
    readonly amount: string;
    readonly currency: string;
  }>;
  readonly actualCost?: Readonly<{
    readonly amount: string;
    readonly currency: string;
  }>;
  readonly reasonCode?: string;
  readonly completedAt?: string;
  readonly idempotency: "created" | "replayed" | "in_progress";
}

const costSchema = z
  .object({
    amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u),
    currency: z.string().regex(/^[A-Z]{3}$/u),
  })
  .strict();
export const providerCapabilityTestOperationsSchema: z.ZodType<{
  readonly items: readonly ProviderCapabilityTestOperation[];
}> = z
  .object({
    items: z
      .array(
        z
          .object({
            operation: identifierSchema,
            requiresConfirmation: z.boolean(),
            requiresIdempotencyKey: z.boolean(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export const providerCapabilityTestPreviewSchema: z.ZodType<ProviderCapabilityTestPreview> =
  z
    .object({
      providerInstanceId: identifierSchema,
      providerInstanceVersionId: identifierSchema,
      bindingVersionId: identifierSchema,
      testOperation: identifierSchema,
      pricingStatus: z.enum(["known", "unknown", "incomplete"]),
      canConfirm: z.boolean(),
      reasonCode: z
        .enum(["pricing.unknown", "budget.policy_missing"])
        .optional(),
      confirmationId: identifierSchema.optional(),
      confirmation: z.string().trim().min(1).max(2_000).optional(),
      impact: z.string().trim().min(1).max(2_000).optional(),
      estimatedCost: costSchema.optional(),
      expiresAt: z.string().datetime({ offset: true }).optional(),
    })
    .strict();
export const providerCapabilityTestResultSchema: z.ZodType<ProviderCapabilityTestResult> =
  z
    .object({
      id: identifierSchema,
      providerInstanceId: identifierSchema,
      providerInstanceVersionId: identifierSchema,
      bindingVersionId: identifierSchema,
      testOperation: identifierSchema,
      outcome: z.enum(["succeeded", "failed", "denied", "outcome_unknown"]),
      operationId: identifierSchema.optional(),
      estimatedCost: costSchema.optional(),
      actualCost: costSchema.optional(),
      reasonCode: z.string().trim().min(1).max(100).optional(),
      completedAt: z.string().datetime({ offset: true }).optional(),
      idempotency: z.enum(["created", "replayed", "in_progress"]),
    })
    .strict();

export const platformLinkConfigurationSchema: z.ZodType<PlatformLinkConfiguration> =
  z
    .object({
      workspaceId: identifierSchema,
      configurationId: identifierSchema,
      configurationVersionId: identifierSchema,
      revision: z.number().int().positive(),
      lifecycle: z.enum(["draft", "active", "disabled", "superseded"]),
      settings: z
        .object({
          apiPublicBaseUrl: z.string().url().max(2_000),
          webhookPublicBaseUrl: z.string().url().max(2_000),
        })
        .strict(),
    })
    .strict();

export interface ConfigurationHistoryResponse {
  readonly items: readonly ConfigurationVersionSummary[];
  readonly page: CursorPage;
}

export const configurationHistoryResponseSchema: z.ZodType<ConfigurationHistoryResponse> =
  z
    .object({
      items: z.array(configurationVersionSummarySchema).max(100),
      page: z
        .object({
          hasNextPage: z.boolean(),
          endCursor: identifierSchema.optional(),
        })
        .strict(),
    })
    .strict();

export interface DiagnosticExportStatus {
  readonly id: string;
  readonly status:
    | "requested"
    | "generating"
    | "ready"
    | "failed"
    | "expired"
    | "deleted";
  readonly eventCutoffAt: string;
  readonly expiresAt: string;
  readonly generatedAt?: string;
  readonly failureCode?:
    | "source.unavailable"
    | "content.tooLarge"
    | "storage.unavailable";
}

export const diagnosticExportStatusSchema: z.ZodType<DiagnosticExportStatus> = z
  .object({
    id: identifierSchema,
    status: z.enum([
      "requested",
      "generating",
      "ready",
      "failed",
      "expired",
      "deleted",
    ]),
    eventCutoffAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    generatedAt: z.string().datetime({ offset: true }).optional(),
    failureCode: z
      .enum(["source.unavailable", "content.tooLarge", "storage.unavailable"])
      .optional(),
  })
  .strict();

export interface ConfigurationSurface {
  readonly surface: string;
  readonly mode: "managed" | "read_only" | "unavailable";
  readonly reasonCode?: string;
  readonly reason?: string;
  readonly workflows: readonly string[];
  readonly operationalActions: readonly (
    | "source.synchronize"
    | "source.fullRescan"
    | "publication.approve"
  )[];
}

export const configurationSurfacesSchema: z.ZodType<{
  readonly items: readonly ConfigurationSurface[];
}> = z
  .object({
    items: z
      .array(
        z
          .object({
            surface: identifierSchema,
            mode: z.enum(["managed", "read_only", "unavailable"]),
            reasonCode: z.string().trim().min(1).max(80).optional(),
            reason: nonSensitiveTextSchema.optional(),
            workflows: z.array(z.string().trim().min(1).max(80)).max(5),
            operationalActions: z
              .array(
                z.enum([
                  "source.synchronize",
                  "source.fullRescan",
                  "publication.approve",
                ]),
              )
              .max(3),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type JsonScalar = string | number | boolean | null;

export interface DescriptorSchema {
  readonly type?:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "array"
    | "object";
  readonly title?: string;
  readonly description?: string;
  readonly enum?: readonly JsonScalar[];
  readonly default?: JsonScalar;
  readonly format?: string;
  readonly properties?: Readonly<Record<string, DescriptorSchema>>;
  readonly required?: readonly string[];
  readonly items?: DescriptorSchema;
  /** Backend-owned JSON Schema safety rule; required for strict descriptor parsing. */
  readonly additionalProperties?: boolean;
}

const descriptorSchema: z.ZodType<DescriptorSchema> = z.lazy(() =>
  z
    .object({
      type: z
        .enum(["string", "number", "integer", "boolean", "array", "object"])
        .optional(),
      title: z.string().trim().min(1).max(160).optional(),
      description: z.string().trim().min(1).max(1_000).optional(),
      enum: z
        .array(
          z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
        )
        .min(1)
        .max(100)
        .optional(),
      default: z
        .union([z.string(), z.number().finite(), z.boolean(), z.null()])
        .optional(),
      format: z.string().trim().min(1).max(80).optional(),
      properties: z
        .record(z.string().min(1).max(100), descriptorSchema)
        .optional(),
      required: z.array(z.string().min(1).max(100)).max(100).optional(),
      items: descriptorSchema.optional(),
      additionalProperties: z.boolean().optional(),
    })
    .strict(),
);

export interface DescriptorUiGroup {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly string[];
  readonly advanced: boolean;
}

const descriptorUiGroupSchema: z.ZodType<DescriptorUiGroup> = z
  .object({
    id: identifierSchema,
    title: z.string().trim().min(1).max(160),
    fields: z.array(z.string().min(1).max(300)).min(1).max(100),
    advanced: z.boolean().default(false),
  })
  .strict();

export interface SecretReferenceSlot {
  readonly name: string;
  readonly label: string;
  readonly required: boolean;
  readonly acceptedReferenceKinds: readonly string[];
  readonly supportsRotation: boolean;
}

const secretReferenceSlotSchema: z.ZodType<SecretReferenceSlot> = z
  .object({
    name: z.string().trim().min(1).max(300),
    label: z.string().trim().min(1).max(160),
    required: z.boolean(),
    acceptedReferenceKinds: z.array(identifierSchema).max(20),
    supportsRotation: z.boolean(),
  })
  .strict();

export interface ConfigurationDescriptor {
  readonly kind: "connector" | "ai-provider";
  readonly type: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly documentationUrl?: string;
  /** Safe capability metadata drives selectors without vendor branches. */
  readonly connectorCapabilities: readonly (
    | "knowledgeSource"
    | "caseSource"
    | "attachmentSource"
    | "analysisDestination"
    | "webhookAdapter"
  )[];
  readonly aiCapabilities: readonly (
    | "embedding"
    | "vision"
    | "analysis"
    | "repositoryAgent"
    | "reranker"
    | "keywordExtraction"
    | "chat"
  )[];
  readonly supportedWireApis: readonly string[];
  readonly supportedWebhookEventTypes: readonly string[];
  readonly settingsSchema: DescriptorSchema;
  readonly uiGroups: readonly DescriptorUiGroup[];
  readonly secretSlots: readonly SecretReferenceSlot[];
  readonly supportsConfigurationMigration: boolean;
  readonly supportedTestOperations: readonly string[];
}

const configurationDescriptorSchema: z.ZodType<ConfigurationDescriptor> = z
  .object({
    kind: z.enum(["connector", "ai-provider"]),
    type: identifierSchema,
    version: identifierSchema,
    displayName: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000),
    documentationUrl: z.url().optional(),
    connectorCapabilities: z
      .array(
        z.enum([
          "knowledgeSource",
          "caseSource",
          "attachmentSource",
          "analysisDestination",
          "webhookAdapter",
        ]),
      )
      .max(5),
    aiCapabilities: z
      .array(
        z.enum([
          "embedding",
          "vision",
          "analysis",
          "repositoryAgent",
          "reranker",
          "keywordExtraction",
          "chat",
        ]),
      )
      .max(7),
    supportedWireApis: z.array(identifierSchema).max(20),
    supportedWebhookEventTypes: z.array(identifierSchema).max(100),
    settingsSchema: descriptorSchema,
    uiGroups: z.array(descriptorUiGroupSchema).max(30).default([]),
    secretSlots: z.array(secretReferenceSlotSchema).max(30).default([]),
    supportsConfigurationMigration: z.boolean(),
    supportedTestOperations: z.array(identifierSchema).max(20),
  })
  .strict();

export interface DescriptorCatalog {
  readonly items: readonly ConfigurationDescriptor[];
}

export const descriptorCatalogSchema: z.ZodType<DescriptorCatalog> = z
  .object({ items: z.array(configurationDescriptorSchema).max(200) })
  .strict();

export interface SessionMembership {
  readonly id: string;
  readonly name: string;
}

const membershipSchema: z.ZodType<SessionMembership> = z
  .object({ id: identifierSchema, name: nonSensitiveTextSchema })
  .strict();

export interface AuthenticatedSession {
  readonly authenticated: true;
  readonly principal: { readonly id: string; readonly displayName: string };
  readonly activeWorkspace: SessionMembership;
  readonly workspaces: readonly SessionMembership[];
  readonly permissions: readonly string[];
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export interface UnauthenticatedSession {
  readonly authenticated: false;
}

export type Session = AuthenticatedSession | UnauthenticatedSession;

export const sessionSchema: z.ZodType<Session> = z.discriminatedUnion(
  "authenticated",
  [
    z
      .object({
        authenticated: z.literal(true),
        principal: z
          .object({ id: identifierSchema, displayName: nonSensitiveTextSchema })
          .strict(),
        activeWorkspace: membershipSchema,
        workspaces: z.array(membershipSchema).min(1).max(200),
        permissions: z.array(identifierSchema).max(500),
        csrfToken: z.string().trim().min(16).max(4_000),
        expiresAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    z.object({ authenticated: z.literal(false) }).strict(),
  ],
);

export interface PublicApiErrorBody {
  readonly code: string;
  readonly message?: string;
  readonly retryable?: boolean;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly retryAfterSeconds?: number;
}

export const publicApiErrorBodySchema: z.ZodType<PublicApiErrorBody> = z
  .object({
    code: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(500).optional(),
    retryable: z.boolean().optional(),
    requestId: identifierSchema.optional(),
    correlationId: identifierSchema.optional(),
    retryAfterSeconds: z.number().int().min(1).max(86_400).optional(),
  })
  .strict();

export const actionNames = [
  "connector.test",
  "provider.test",
  "source.synchronize",
  "source.fullRescan",
  "dead-letter.retry",
  "job.cancel",
  "job.recover",
  "retention.reap",
  "privacy.purge",
  "connector.activate",
  "connector.disable",
  "provider.activate",
  "provider.disable",
  "diagnostics.export",
  "secret.rotate",
  "secret.revoke",
  "publication.approve",
] as const;

export type AdminActionName = (typeof actionNames)[number];

export interface ActionPreview {
  readonly previewId: string;
  readonly action: AdminActionName;
  readonly confirmation: string;
  readonly impact: string;
  readonly canConfirm: boolean;
  readonly estimatedCost?: {
    readonly amount: string;
    readonly currency: string;
  };
  readonly expiresAt: string;
}

export const actionPreviewSchema: z.ZodType<ActionPreview> = z
  .object({
    previewId: identifierSchema,
    action: z.enum(actionNames),
    confirmation: z.string().trim().min(1).max(500),
    impact: z.string().trim().min(1).max(2_000),
    canConfirm: z.boolean(),
    estimatedCost: z
      .object({
        amount: z.string().trim().min(1).max(80),
        currency: z.string().trim().length(3),
      })
      .strict()
      .optional(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export interface ActionOutcome {
  readonly operationId: string;
  readonly outcome: "accepted" | "completed" | "outcome_unknown";
  readonly message: string;
}

export const actionOutcomeSchema: z.ZodType<ActionOutcome> = z
  .object({
    operationId: identifierSchema,
    outcome: z.enum(["accepted", "completed", "outcome_unknown"]),
    message: z.string().trim().min(1).max(500),
  })
  .strict();
