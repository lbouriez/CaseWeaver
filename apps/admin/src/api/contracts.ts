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
  "connector-instances",
  "knowledge-sources",
  "schedules",
  "publication-profiles",
  "webhook-endpoints",
  "ai-provider-instances",
  "ai-models",
  "ai-bindings",
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
  "ai-models": { list: "/v1/admin/ai/models", detail: "/v1/admin/ai/models" },
  "ai-bindings": {
    list: "/v1/admin/ai/bindings",
    detail: "/v1/admin/ai/bindings",
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
  readonly settingsSchema: DescriptorSchema;
  readonly uiGroups: readonly DescriptorUiGroup[];
  readonly secretSlots: readonly SecretReferenceSlot[];
}

const configurationDescriptorSchema: z.ZodType<ConfigurationDescriptor> = z
  .object({
    kind: z.enum(["connector", "ai-provider"]),
    type: identifierSchema,
    version: identifierSchema,
    displayName: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000),
    documentationUrl: z.url().optional(),
    settingsSchema: descriptorSchema,
    uiGroups: z.array(descriptorUiGroupSchema).max(30).default([]),
    secretSlots: z.array(secretReferenceSlotSchema).max(30).default([]),
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
  "dead-letter.retry",
  "job.cancel",
  "job.recover",
  "retention.reap",
  "privacy.purge",
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
