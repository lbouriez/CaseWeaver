import { policyForResource } from "@caseweaver/administration";
import type { Permission } from "@caseweaver/security";
import { z } from "zod";

import type { ApiInstance } from "../../app.js";

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const resource = z.enum([
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
]);
export type AdminResource = z.infer<typeof resource>;
const action = z.enum([
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
]);
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().min(1).max(2_000).optional(),
    sort: z.string().min(1).max(80).optional(),
    direction: z.enum(["ASC", "DESC"]).default("DESC"),
  })
  .passthrough();
const draft = z
  .object({
    descriptorType: identifier,
    displayName: z.string().trim().min(1).max(160),
    settings: z.record(z.string().min(1).max(200), z.unknown()),
  })
  .strict();
const sourceDraft = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    connectorInstanceId: identifier,
    collectionId: identifier,
    normalizationProfileId: identifier,
    normalizationProfileVersion: identifier,
    chunkingProfileId: identifier,
    chunkingProfileVersion: identifier,
    embeddingBatchSize: z.number().int().min(1).max(1_000),
    embeddingBudgetPolicyId: identifier,
    synchronizationPolicy: z
      .record(z.string().min(1).max(200), z.unknown())
      .refine((value) => Object.keys(value).length <= 100),
    deletionBehavior: z.enum(["tombstone", "retain"]),
  })
  .strict();
const collectionCreate = z
  .object({
    collectionId: identifier,
    embeddingBindingId: identifier,
    embeddingProfileVersion: identifier,
    dimensions: z.number().int().min(1).max(100_000),
  })
  .strict();
const scheduleCadence = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cron"),
      expression: z.string().trim().min(1).max(500),
      timezone: z.string().trim().min(1).max(100),
      jitterMs: z.number().int().min(0).max(86_400_000).optional(),
      overlapPolicy: z.enum(["skip", "queue"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("interval"),
      intervalMs: z.number().int().min(1).max(86_400_000),
      jitterMs: z.number().int().min(0).max(86_400_000).optional(),
      overlapPolicy: z.enum(["skip", "queue"]),
    })
    .strict(),
]);
const scheduleDraft = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    sourceId: identifier,
    sourceConfigurationVersionId: identifier,
    kind: z.enum(["synchronize", "fullRescan"]),
    cadence: scheduleCadence,
    nextRunAt: z.string().datetime({ offset: true }),
  })
  .strict();
const configurationLifecycleTransition = z
  .object({
    expectedRevision: z.number().int().min(1),
    lifecycle: z.enum(["active", "disabled"]),
  })
  .strict();
const roleAssignment = z
  .object({
    roles: z
      .array(z.enum(["administrator", "operator", "analyst", "viewer"]))
      .min(0)
      .max(4),
    expectedRevision: z.number().int().min(0),
  })
  .strict();
const secretReferenceRegistration = z
  .object({
    reference: z
      .string()
      .trim()
      .min(3)
      .max(512)
      .refine(
        (value) => value.includes(":") && !/\s/u.test(value),
        "Expected an opaque secret-backend reference.",
      ),
  })
  .strict();
const privacyPurge = z
  .object({
    reason: z.string().trim().min(1).max(4_000),
  })
  .strict();
const passwordLogin = z
  .object({
    login: z.string().trim().min(1).max(160),
    password: z.string().min(1).max(1_024),
  })
  .strict();
/** Commands with no browser-supplied fields must reject, rather than ignore, a body. */
const noRequestBody = z.undefined();
const safeConfigurationObject = z
  .record(z.string().min(1).max(120), z.unknown())
  .refine((value) => Object.keys(value).length <= 100)
  .refine((value) => !containsSecretLikeKey(value), {
    message: "Secret values must be registered separately.",
  });
const publicationProfileDraft = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    definition: safeConfigurationObject,
  })
  .strict();
const policyProfileDraft = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    // These profiles are immutable configuration documents. Credential-shaped
    // keys are rejected recursively at the HTTP boundary; profiles have no
    // secret slots and must never become a side channel for secret values.
    settings: safeConfigurationObject,
  })
  .strict();
const webhookEndpointDraft = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    connectorInstanceId: identifier,
    verifiedEventTypes: z.array(identifier).min(1).max(100),
    maximumBodyBytes: z
      .number()
      .int()
      .min(1)
      .max(10 * 1024 * 1024),
    maximumRequestsPerMinute: z.number().int().min(1).max(10_000),
    analysisTriggerId: identifier.optional(),
    settings: safeConfigurationObject,
    secretReferenceRegistrationIds: z.array(identifier).max(30).default([]),
  })
  .strict();
const platformLinks = z
  .object({
    apiPublicBaseUrl: z.string().trim().min(1).max(2_000),
    webhookPublicBaseUrl: z.string().trim().min(1).max(2_000),
    expectedRevision: z.number().int().min(1).optional(),
  })
  .strict();
const aiRole = z.enum([
  "embedding",
  "vision",
  "analysis",
  "repositoryAgent",
  "keywordExtraction",
  "reranker",
  "chat",
]);
const aiCapability = z.enum([
  "vision",
  "structuredOutput",
  "tools",
  "promptCaching",
  "reranking",
  "repositoryAgent",
]);
const aiBindingDraft = z
  .object({
    providerInstanceId: identifier,
    catalogSnapshotId: identifier,
    canonicalModel: z.string().trim().min(1).max(500),
    role: aiRole,
    requiredCapabilities: z.array(aiCapability).max(20).optional(),
    maximumInputTokens: z.number().int().min(1).max(10_000_000).optional(),
    maximumOutputTokens: z.number().int().min(1).max(10_000_000).optional(),
  })
  .strict();
const aiBindingVersionDraft = aiBindingDraft
  .extend({ expectedRevision: z.number().int().min(1) })
  .strict();
const aiRoleDefault = z
  .object({
    bindingVersionId: identifier,
    expectedRevision: z.number().int().min(0),
  })
  .strict();
const aiPriceComponent = z
  .object({
    kind: z.enum([
      "input",
      "output",
      "cacheRead",
      "cacheCreation",
      "image",
      "audio",
    ]),
    unit: z.enum(["token", "image", "audio"]),
    amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    conditions: safeConfigurationObject.optional(),
  })
  .strict();
const aiPriceOverride = z
  .object({
    overrideId: identifier.optional(),
    scope: z.enum(["workspace", "binding"]),
    provider: identifier,
    canonicalModel: z.string().trim().min(1).max(500),
    bindingVersionId: identifier.optional(),
    effectiveFrom: z.string().datetime({ offset: true }),
    effectiveTo: z.string().datetime({ offset: true }).optional(),
    components: z.array(aiPriceComponent).min(1).max(12),
  })
  .strict();
const aiBudget = z
  .object({
    budgetPolicyId: identifier.optional(),
    scope: z.enum(["operation", "analysis", "day", "workspace"]),
    scopeKey: identifier,
    limitAmount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    hard: z.boolean(),
    expectedRevision: z.number().int().min(0),
  })
  .strict();

export interface AdminRequestContext {
  readonly principalId: string;
  readonly workspaceId: string;
  /** Server-managed session identity; never accepted from browser input. */
  readonly sessionId: string;
  readonly permissions: readonly Permission[];
  readonly requestId: string;
  readonly correlationId: string;
  readonly uiActionId?: string;
  readonly idempotencyKey?: string;
  readonly requestMode: "user" | "passive_poll";
  readonly traceId?: string;
  readonly clientAddress?: string;
  readonly userAgent?: string;
}

/**
 * A route-owned, payload-free audit description for a request rejected before
 * its feature use case can run.  Every field is a server constant selected by
 * the route; invalid parameters, bodies, and idempotency keys never become
 * audit targets or metadata.
 */
export interface InvalidAdministrationRequest {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly permission?: Permission;
  readonly mutation: boolean;
  readonly reasonCode: "request.invalid" | "idempotency.required";
}

export interface AdministrationRouteOperations {
  resolve(
    request: unknown,
    options: { readonly mutation: boolean },
  ): Promise<AdminRequestContext>;
  rejectInvalidRequest(
    request: unknown,
    audit: InvalidAdministrationRequest,
  ): Promise<void>;
  rejectInvalidPasswordLogin(request: unknown): Promise<void>;
  session(request: unknown): Promise<unknown>;
  login(request: unknown): Promise<{ readonly redirectTo: string }>;
  passwordLogin(
    request: unknown,
    credentials: z.infer<typeof passwordLogin>,
  ): Promise<{
    readonly setCookie: string;
    readonly session: unknown;
  }>;
  callback(request: unknown): Promise<{ readonly redirectTo: string }>;
  logout(request: unknown): Promise<{ readonly setCookie: string }>;
  switchWorkspace(
    request: unknown,
    workspaceId: string,
  ): Promise<{
    readonly setCookie: string;
    readonly session: unknown;
  }>;
  descriptors(
    kind: "connector" | "ai-provider",
    type?: string,
    context?: AdminRequestContext,
  ): Promise<unknown>;
  list(
    resource: AdminResource,
    query: z.infer<typeof listQuery>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  detail(
    resource: AdminResource,
    id: string,
    context: AdminRequestContext,
  ): Promise<unknown>;
  configurationInspection(
    configurationId: string,
    context: AdminRequestContext,
  ): Promise<unknown>;
  configurationHistory(
    configurationId: string,
    query: Readonly<{ readonly limit?: number; readonly after?: string }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  configurationVersion(
    configurationId: string,
    versionId: string,
    context: AdminRequestContext,
  ): Promise<unknown>;
  configurationSurfaces(context: AdminRequestContext): Promise<unknown>;
  createDraft(
    kind: "connector" | "ai-provider",
    input: z.infer<typeof draft>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  createSecretReference(
    input: z.infer<typeof secretReferenceRegistration>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  createKnowledgeSourceDraft(
    input: z.infer<typeof sourceDraft>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  createKnowledgeCollection?(
    input: z.infer<typeof collectionCreate>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  createKnowledgeScheduleDraft(
    input: z.infer<typeof scheduleDraft>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  transitionKnowledgeSource(
    input: Readonly<{
      readonly sourceId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  transitionKnowledgeSchedule(
    input: Readonly<{
      readonly scheduleId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  replaceWorkspacePrincipalRoles(
    input: Readonly<{
      readonly targetPrincipalId: string;
      readonly roles: readonly (
        | "administrator"
        | "operator"
        | "analyst"
        | "viewer"
      )[];
      readonly expectedRevision: number;
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  workspacePrincipalRoles(
    principalId: string,
    context: AdminRequestContext,
  ): Promise<unknown>;
  createPublicationProfile?(
    input: z.infer<typeof publicationProfileDraft>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  createPolicyProfileDraft?(
    resource: "retrieval-profiles" | "prompt-profiles",
    input: z.infer<typeof policyProfileDraft>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  transitionPolicyProfile?(
    resource: "retrieval-profiles" | "prompt-profiles",
    input: Readonly<{
      readonly profileId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  transitionPublicationProfile?(
    input: Readonly<{
      readonly profileId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  createWebhookEndpoint?(
    input: z.infer<typeof webhookEndpointDraft>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  transitionWebhookEndpoint?(
    input: Readonly<{
      readonly endpointId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  platformLinks?(context: AdminRequestContext): Promise<unknown>;
  savePlatformLinks?(
    input: z.infer<typeof platformLinks>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  createAiBindingDraft?(
    input: z.infer<typeof aiBindingDraft>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  createAiBindingVersionDraft?(
    input: Readonly<{
      readonly bindingId: string;
      readonly expectedRevision: number;
      readonly providerInstanceId: string;
      readonly catalogSnapshotId: string;
      readonly canonicalModel: string;
      readonly requiredCapabilities?: readonly z.infer<typeof aiCapability>[];
      readonly maximumInputTokens?: number;
      readonly maximumOutputTokens?: number;
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  transitionAiBinding?(
    input: Readonly<{
      readonly bindingId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  setAiRoleDefault?(
    input: Readonly<{
      readonly role: z.infer<typeof aiRole>;
      readonly bindingVersionId: string;
      readonly expectedRevision: number;
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  createAiPriceOverride?(
    input: z.infer<typeof aiPriceOverride>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  replaceAiBudget?(
    input: z.infer<typeof aiBudget>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  providerCapabilityTestOperations?(
    providerInstanceId: string,
    context: AdminRequestContext,
  ): Promise<unknown>;
  previewProviderCapabilityTest?(
    input: Readonly<{
      readonly providerInstanceId: string;
      readonly testOperation: string;
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  runProviderCapabilityTest?(
    input: Readonly<{
      readonly providerInstanceId: string;
      readonly testOperation: string;
      readonly confirmationId: string;
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  connectorDraftTestOperations?(
    descriptorType: string,
    context: AdminRequestContext,
  ): Promise<unknown>;
  previewConnectorDraftTest?(
    input: Readonly<{
      readonly descriptorType: string;
      readonly operation: string;
      readonly settings: Readonly<Record<string, unknown>>;
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  runConnectorDraftTest?(
    input: Readonly<{
      readonly descriptorType: string;
      readonly operation: string;
      readonly settings: Readonly<Record<string, unknown>>;
      readonly confirmationId: string;
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  requestDiagnosticExport?(context: AdminRequestContext): Promise<unknown>;
  diagnosticExportStatus?(
    exportId: string,
    context: AdminRequestContext,
  ): Promise<unknown>;
  downloadDiagnosticExport?(
    exportId: string,
    context: AdminRequestContext,
  ): Promise<
    Readonly<{
      readonly content: AsyncIterable<Uint8Array>;
      readonly fileName: string;
    }>
  >;
  previewPrivacyPurge(
    input: Readonly<{
      readonly caseSnapshotId: string;
      readonly reason: string;
    }>,
    context: AdminRequestContext,
  ): Promise<unknown>;
  previewAction(
    input: {
      readonly action: z.infer<typeof action>;
      readonly resource: AdminResource;
      readonly id?: string;
    },
    context: AdminRequestContext,
  ): Promise<unknown>;
  executeAction(
    previewId: string,
    context: AdminRequestContext,
  ): Promise<unknown>;
}

function failure(
  reply: { status(code: number): { send(value: unknown): unknown } },
  code: number,
  reason: string,
) {
  return reply.status(code).send({ code: reason });
}

type FailureReply = {
  status(code: number): { send(value: unknown): unknown };
};

function invalidRequestAudit(
  input: Omit<InvalidAdministrationRequest, "reasonCode">,
  reasonCode: InvalidAdministrationRequest["reasonCode"],
): InvalidAdministrationRequest {
  return Object.freeze({ ...input, reasonCode });
}

function invalidMutationAudit(
  action: string,
  permission: Permission | undefined,
  targetType: string,
  targetId: string,
): Omit<InvalidAdministrationRequest, "reasonCode"> {
  return Object.freeze({
    action,
    permission,
    targetType,
    targetId,
    mutation: true,
  });
}

function invalidReadAudit(
  action: string,
  permission: Permission | undefined,
  targetType: string,
  targetId: string,
): Omit<InvalidAdministrationRequest, "reasonCode"> {
  return Object.freeze({
    action,
    permission,
    targetType,
    targetId,
    mutation: false,
  });
}

async function rejectInvalidRequest(
  operations: AdministrationRouteOperations,
  request: unknown,
  reply: FailureReply,
  audit: InvalidAdministrationRequest,
  responseReason = "request.invalid",
): Promise<unknown> {
  await operations.rejectInvalidRequest(request, audit);
  return failure(reply, 400, responseReason);
}

async function rejectInvalidPasswordLogin(
  operations: AdministrationRouteOperations,
  request: unknown,
  reply: FailureReply,
): Promise<unknown> {
  await operations.rejectInvalidPasswordLogin(request);
  return failure(reply, 400, "request.invalid");
}

async function requireIdempotency(
  operations: AdministrationRouteOperations,
  request: { headers: Record<string, unknown> },
  reply: FailureReply,
  audit: Omit<InvalidAdministrationRequest, "reasonCode">,
): Promise<boolean> {
  const value = request.headers["idempotency-key"];
  if (typeof value === "string" && value.length >= 16 && value.length <= 200) {
    return true;
  }
  await rejectInvalidRequest(
    operations,
    request,
    reply,
    invalidRequestAudit(audit, "idempotency.required"),
    "idempotency.required",
  );
  return false;
}

export function registerAdministrationRoutes(
  app: ApiInstance,
  operations: AdministrationRouteOperations,
): void {
  app.get("/v1/auth/login", async (request, reply) => {
    const response = await operations.login(request);
    return reply.redirect(response.redirectTo);
  });
  app.post("/v1/auth/login/password", async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"];
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 16 ||
      idempotencyKey.length > 200
    ) {
      return rejectInvalidPasswordLogin(operations, request, reply);
    }
    const body = passwordLogin.safeParse(request.body);
    if (!body.success)
      return rejectInvalidPasswordLogin(operations, request, reply);
    const response = await operations.passwordLogin(request, body.data);
    reply.header("set-cookie", response.setCookie);
    return response.session;
  });
  app.get("/v1/auth/callback", async (request, reply) => {
    const response = await operations.callback(request);
    if ("setCookie" in response && typeof response.setCookie === "string") {
      reply.header("set-cookie", response.setCookie);
    }
    return reply.redirect(response.redirectTo);
  });
  app.get("/v1/auth/session", async (request) => operations.session(request));

  app.post("/v1/auth/logout", async (request, reply) => {
    const audit = invalidMutationAudit(
      "auth.logout.invalid",
      undefined,
      "auth-session",
      "current",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    if (!noRequestBody.safeParse(request.body).success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    const response = await operations.logout(request);
    reply.header("set-cookie", response.setCookie);
    return reply.status(204).send();
  });
  app.post("/v1/auth/session/workspace", async (request, reply) => {
    const audit = invalidMutationAudit(
      "auth.workspace.switch.invalid",
      undefined,
      "workspace",
      "invalid",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = z
      .object({ workspaceId: identifier })
      .strict()
      .safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    const response = await operations.switchWorkspace(
      request,
      body.data.workspaceId,
    );
    reply.header("set-cookie", response.setCookie);
    return response.session;
  });

  const descriptorList = async (
    kind: "connector" | "ai-provider",
    request: unknown,
  ) => {
    const context = await operations.resolve(request, { mutation: false });
    return operations.descriptors(kind, undefined, context);
  };
  const descriptorDetail = async (
    kind: "connector" | "ai-provider",
    request: { readonly params: unknown },
    reply: { status(code: number): { send(value: unknown): unknown } },
  ) => {
    const params = z.object({ type: identifier }).safeParse(request.params);
    if (!params.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(
          invalidReadAudit(
            `admin.descriptor.${kind}.read`,
            "configuration.read",
            "configuration_descriptor",
            "invalid",
          ),
          "request.invalid",
        ),
      );
    const context = await operations.resolve(request, { mutation: false });
    return operations.descriptors(kind, params.data.type, context);
  };
  app.get("/v1/admin/descriptors/connectors", async (request) =>
    descriptorList("connector", request),
  );
  app.get("/v1/admin/descriptors/connectors/:type", async (request, reply) =>
    descriptorDetail("connector", request, reply),
  );
  app.get("/v1/admin/descriptors/ai-providers", async (request) =>
    descriptorList("ai-provider", request),
  );
  app.get("/v1/admin/descriptors/ai-providers/:type", async (request, reply) =>
    descriptorDetail("ai-provider", request, reply),
  );

  const createDraft = async (
    kind: "connector" | "ai-provider",
    request: { headers: Record<string, unknown>; body: unknown },
    reply: { status(code: number): { send(value: unknown): unknown } },
  ) => {
    const resourceType =
      kind === "connector" ? "connector-instances" : "ai-provider-instances";
    const audit = invalidMutationAudit(
      "admin.configuration.draft.create.invalid",
      "configuration.manage",
      resourceType,
      "new",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = draft.safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    return operations.createDraft(
      kind,
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  };
  app.post("/v1/admin/connector-instances/drafts", async (request, reply) =>
    createDraft("connector", request, reply),
  );
  app.post("/v1/admin/ai/provider-instances/drafts", async (request, reply) =>
    createDraft("ai-provider", request, reply),
  );
  app.post("/v1/admin/collections", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.collection.create.invalid",
      "configuration.manage",
      "knowledge_collection",
      "new",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = collectionCreate.safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    if (operations.createKnowledgeCollection === undefined)
      return failure(reply, 503, "service.unavailable");
    return operations.createKnowledgeCollection(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post("/v1/admin/knowledge-sources/drafts", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.knowledgeSource.draft.create.invalid",
      "configuration.manage",
      "knowledge_source",
      "new",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = sourceDraft.safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    return operations.createKnowledgeSourceDraft(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post("/v1/admin/schedules/drafts", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.knowledgeSchedule.draft.create.invalid",
      "configuration.manage",
      "knowledge_schedule",
      "new",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = scheduleDraft.safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    return operations.createKnowledgeScheduleDraft(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post("/v1/admin/publication-profiles/drafts", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.publicationProfile.draft.create.invalid",
      "configuration.manage",
      "publication_profile",
      "new",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = publicationProfileDraft.safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    if (operations.createPublicationProfile === undefined) {
      return failure(reply, 503, "service.unavailable");
    }
    return operations.createPublicationProfile(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  const createPolicyProfileDraft = async (
    policyResource: "retrieval-profiles" | "prompt-profiles",
    request: { headers: Record<string, unknown>; body: unknown },
    reply: { status(code: number): { send(value: unknown): unknown } },
  ) => {
    const audit = invalidMutationAudit(
      "admin.policyProfile.draft.create.invalid",
      "configuration.manage",
      policyResource,
      "new",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = policyProfileDraft.safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    if (operations.createPolicyProfileDraft === undefined) {
      return failure(reply, 503, "service.unavailable");
    }
    return operations.createPolicyProfileDraft(
      policyResource,
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  };
  app.post("/v1/admin/retrieval-profiles/drafts", async (request, reply) =>
    createPolicyProfileDraft("retrieval-profiles", request, reply),
  );
  app.post("/v1/admin/prompt-profiles/drafts", async (request, reply) =>
    createPolicyProfileDraft("prompt-profiles", request, reply),
  );
  app.post("/v1/admin/webhook-endpoints/drafts", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.webhookEndpoint.draft.create.invalid",
      "configuration.manage",
      "webhook_endpoint",
      "new",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = webhookEndpointDraft.safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    if (operations.createWebhookEndpoint === undefined) {
      return failure(reply, 503, "service.unavailable");
    }
    return operations.createWebhookEndpoint(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  const transitionSourceSchedule = async (
    kind: "source" | "schedule",
    request: {
      readonly headers: Record<string, unknown>;
      readonly body: unknown;
      readonly params: unknown;
    },
    reply: { status(code: number): { send(value: unknown): unknown } },
  ) => {
    const audit = invalidMutationAudit(
      kind === "source"
        ? "admin.knowledgeSource.lifecycle.invalid"
        : "admin.knowledgeSchedule.lifecycle.invalid",
      "configuration.manage",
      kind === "source" ? "knowledge_source" : "knowledge_schedule",
      "invalid",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const params = z
      .object({ id: identifier })
      .strict()
      .safeParse(request.params);
    const body = configurationLifecycleTransition.safeParse(request.body);
    if (!params.success || !body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    const context = await operations.resolve(request, { mutation: true });
    return kind === "source"
      ? operations.transitionKnowledgeSource(
          {
            sourceId: params.data.id,
            expectedRevision: body.data.expectedRevision,
            lifecycle: body.data.lifecycle,
          },
          context,
        )
      : operations.transitionKnowledgeSchedule(
          {
            scheduleId: params.data.id,
            expectedRevision: body.data.expectedRevision,
            lifecycle: body.data.lifecycle,
          },
          context,
        );
  };
  app.post(
    "/v1/admin/knowledge-sources/:id/lifecycle",
    async (request, reply) =>
      transitionSourceSchedule("source", request, reply),
  );
  const transitionPolicyProfile = async (
    policyResource: "retrieval-profiles" | "prompt-profiles",
    request: {
      readonly headers: Record<string, unknown>;
      readonly body: unknown;
      readonly params: unknown;
    },
    reply: { status(code: number): { send(value: unknown): unknown } },
  ) => {
    const audit = invalidMutationAudit(
      "admin.policyProfile.lifecycle.invalid",
      "configuration.manage",
      policyResource,
      "invalid",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const params = z
      .object({ id: identifier })
      .strict()
      .safeParse(request.params);
    const body = configurationLifecycleTransition.safeParse(request.body);
    if (!params.success || !body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    if (operations.transitionPolicyProfile === undefined) {
      return failure(reply, 503, "service.unavailable");
    }
    return operations.transitionPolicyProfile(
      policyResource,
      { profileId: params.data.id, ...body.data },
      await operations.resolve(request, { mutation: true }),
    );
  };
  app.post(
    "/v1/admin/retrieval-profiles/:id/lifecycle",
    async (request, reply) =>
      transitionPolicyProfile("retrieval-profiles", request, reply),
  );
  app.post("/v1/admin/prompt-profiles/:id/lifecycle", async (request, reply) =>
    transitionPolicyProfile("prompt-profiles", request, reply),
  );
  app.post("/v1/admin/schedules/:id/lifecycle", async (request, reply) =>
    transitionSourceSchedule("schedule", request, reply),
  );
  const transitionPublicationOrWebhook = async (
    kind: "publication" | "webhook",
    request: {
      readonly headers: Record<string, unknown>;
      readonly body: unknown;
      readonly params: unknown;
    },
    reply: { status(code: number): { send(value: unknown): unknown } },
  ) => {
    const audit = invalidMutationAudit(
      kind === "publication"
        ? "admin.publicationProfile.lifecycle.invalid"
        : "admin.webhookEndpoint.lifecycle.invalid",
      "configuration.manage",
      kind === "publication" ? "publication_profile" : "webhook_endpoint",
      "invalid",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const params = z
      .object({ id: identifier })
      .strict()
      .safeParse(request.params);
    const body = configurationLifecycleTransition.safeParse(request.body);
    if (!params.success || !body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    const context = await operations.resolve(request, { mutation: true });
    if (kind === "publication") {
      if (operations.transitionPublicationProfile === undefined) {
        return failure(reply, 503, "service.unavailable");
      }
      return operations.transitionPublicationProfile(
        { profileId: params.data.id, ...body.data },
        context,
      );
    }
    if (operations.transitionWebhookEndpoint === undefined) {
      return failure(reply, 503, "service.unavailable");
    }
    return operations.transitionWebhookEndpoint(
      { endpointId: params.data.id, ...body.data },
      context,
    );
  };
  app.post(
    "/v1/admin/publication-profiles/:id/lifecycle",
    async (request, reply) =>
      transitionPublicationOrWebhook("publication", request, reply),
  );
  app.post(
    "/v1/admin/webhook-endpoints/:id/lifecycle",
    async (request, reply) =>
      transitionPublicationOrWebhook("webhook", request, reply),
  );
  app.get("/v1/admin/platform/links", async (request, reply) => {
    if (operations.platformLinks === undefined)
      return failure(reply, 503, "service.unavailable");
    return operations.platformLinks(
      await operations.resolve(request, { mutation: false }),
    );
  });
  app.put("/v1/admin/platform/links", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.platformLink.write.invalid",
      "configuration.manage",
      "platform_links",
      "current",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = platformLinks.safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    if (operations.savePlatformLinks === undefined)
      return failure(reply, 503, "service.unavailable");
    return operations.savePlatformLinks(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post("/v1/admin/ai/bindings/drafts", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.aiBinding.draft.create.invalid",
      "configuration.manage",
      "ai_binding",
      "new",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = aiBindingDraft.safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    if (operations.createAiBindingDraft === undefined)
      return failure(reply, 503, "service.unavailable");
    return operations.createAiBindingDraft(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post(
    "/v1/admin/ai/bindings/:id/versions/drafts",
    async (request, reply) => {
      const audit = invalidMutationAudit(
        "admin.aiBinding.version.draft.create.invalid",
        "configuration.manage",
        "ai_binding",
        "invalid",
      );
      if (!(await requireIdempotency(operations, request, reply, audit)))
        return;
      const params = z
        .object({ id: identifier })
        .strict()
        .safeParse(request.params);
      const body = aiBindingVersionDraft.safeParse(request.body);
      if (!params.success || !body.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(audit, "request.invalid"),
        );
      if (operations.createAiBindingVersionDraft === undefined)
        return failure(reply, 503, "service.unavailable");
      return operations.createAiBindingVersionDraft(
        { bindingId: params.data.id, ...body.data },
        await operations.resolve(request, { mutation: true }),
      );
    },
  );
  app.post("/v1/admin/ai/bindings/:id/lifecycle", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.aiBinding.lifecycle.invalid",
      "configuration.manage",
      "ai_binding",
      "invalid",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const params = z
      .object({ id: identifier })
      .strict()
      .safeParse(request.params);
    const body = configurationLifecycleTransition.safeParse(request.body);
    if (!params.success || !body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    if (operations.transitionAiBinding === undefined)
      return failure(reply, 503, "service.unavailable");
    return operations.transitionAiBinding(
      { bindingId: params.data.id, ...body.data },
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.put("/v1/admin/ai/role-defaults/:role", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.aiRoleDefault.set.invalid",
      "configuration.manage",
      "ai_role_default",
      "invalid",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const params = z
      .object({ role: aiRole })
      .strict()
      .safeParse(request.params);
    const body = aiRoleDefault.safeParse(request.body);
    if (!params.success || !body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    if (operations.setAiRoleDefault === undefined)
      return failure(reply, 503, "service.unavailable");
    return operations.setAiRoleDefault(
      { role: params.data.role, ...body.data },
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post("/v1/admin/ai/pricing-overrides", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.aiPriceOverride.create.invalid",
      "configuration.manage",
      "ai_price_override",
      "new",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = aiPriceOverride.safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    if (operations.createAiPriceOverride === undefined)
      return failure(reply, 503, "service.unavailable");
    return operations.createAiPriceOverride(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.put("/v1/admin/ai/budgets", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.aiBudgetPolicy.replace.invalid",
      "configuration.manage",
      "ai_budget_policy",
      "new",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = aiBudget.safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    if (operations.replaceAiBudget === undefined)
      return failure(reply, 503, "service.unavailable");
    return operations.replaceAiBudget(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.get(
    "/v1/admin/ai/provider-instances/:id/capability-tests",
    async (request, reply) => {
      const params = z
        .object({ id: identifier })
        .strict()
        .safeParse(request.params);
      if (!params.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(
            invalidReadAudit(
              "admin.provider.capabilityTest.operations.read",
              "configuration.read",
              "ai_provider_instance",
              "invalid",
            ),
            "request.invalid",
          ),
        );
      if (operations.providerCapabilityTestOperations === undefined)
        return failure(reply, 503, "service.unavailable");
      return operations.providerCapabilityTestOperations(
        params.data.id,
        await operations.resolve(request, { mutation: false }),
      );
    },
  );
  app.post(
    "/v1/admin/ai/provider-instances/:id/capability-tests/:operation/previews",
    async (request, reply) => {
      const audit = invalidMutationAudit(
        "admin.provider.capabilityTest.preview.invalid",
        "configuration.manage",
        "ai_provider_instance",
        "invalid",
      );
      if (!(await requireIdempotency(operations, request, reply, audit)))
        return;
      if (!noRequestBody.safeParse(request.body).success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(audit, "request.invalid"),
        );
      const params = z
        .object({ id: identifier, operation: identifier })
        .strict()
        .safeParse(request.params);
      if (!params.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(audit, "request.invalid"),
        );
      if (operations.previewProviderCapabilityTest === undefined)
        return failure(reply, 503, "service.unavailable");
      return operations.previewProviderCapabilityTest(
        {
          providerInstanceId: params.data.id,
          testOperation: params.data.operation,
        },
        await operations.resolve(request, { mutation: true }),
      );
    },
  );
  app.post(
    "/v1/admin/ai/provider-instances/:id/capability-tests/:operation/executions",
    async (request, reply) => {
      const audit = invalidMutationAudit(
        "admin.provider.capabilityTest.execute.invalid",
        "configuration.manage",
        "ai_provider_instance",
        "invalid",
      );
      if (!(await requireIdempotency(operations, request, reply, audit)))
        return;
      const params = z
        .object({ id: identifier, operation: identifier })
        .strict()
        .safeParse(request.params);
      const body = z
        .object({ confirmationId: identifier })
        .strict()
        .safeParse(request.body);
      if (!params.success || !body.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(audit, "request.invalid"),
        );
      if (operations.runProviderCapabilityTest === undefined)
        return failure(reply, 503, "service.unavailable");
      return operations.runProviderCapabilityTest(
        {
          providerInstanceId: params.data.id,
          testOperation: params.data.operation,
          confirmationId: body.data.confirmationId,
        },
        await operations.resolve(request, { mutation: true }),
      );
    },
  );
  app.get(
    "/v1/admin/connector-descriptors/:type/draft-tests",
    async (request, reply) => {
      const params = z
        .object({ type: identifier })
        .strict()
        .safeParse(request.params);
      if (!params.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(
            invalidReadAudit(
              "admin.connectorDraftTest.operations.read",
              "configuration.read",
              "connector_descriptor",
              "invalid",
            ),
            "request.invalid",
          ),
        );
      if (operations.connectorDraftTestOperations === undefined)
        return failure(reply, 503, "service.unavailable");
      return operations.connectorDraftTestOperations(
        params.data.type,
        await operations.resolve(request, { mutation: false }),
      );
    },
  );
  app.post(
    "/v1/admin/connector-descriptors/:type/draft-tests/:operation/previews",
    async (request, reply) => {
      const audit = invalidMutationAudit(
        "admin.connectorDraftTest.preview.invalid",
        "connector.manage",
        "connector_descriptor",
        "invalid",
      );
      if (!(await requireIdempotency(operations, request, reply, audit)))
        return;
      const params = z
        .object({ type: identifier, operation: identifier })
        .strict()
        .safeParse(request.params);
      const body = z
        .object({ settings: draft.shape.settings })
        .strict()
        .safeParse(request.body);
      if (!params.success || !body.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(audit, "request.invalid"),
        );
      if (operations.previewConnectorDraftTest === undefined)
        return failure(reply, 503, "service.unavailable");
      return operations.previewConnectorDraftTest(
        {
          descriptorType: params.data.type,
          operation: params.data.operation,
          settings: body.data.settings,
        },
        await operations.resolve(request, { mutation: true }),
      );
    },
  );
  app.post(
    "/v1/admin/connector-descriptors/:type/draft-tests/:operation/executions",
    async (request, reply) => {
      const audit = invalidMutationAudit(
        "admin.connectorDraftTest.execute.invalid",
        "connector.manage",
        "connector_descriptor",
        "invalid",
      );
      if (!(await requireIdempotency(operations, request, reply, audit)))
        return;
      const params = z
        .object({ type: identifier, operation: identifier })
        .strict()
        .safeParse(request.params);
      const body = z
        .object({ settings: draft.shape.settings, confirmationId: identifier })
        .strict()
        .safeParse(request.body);
      if (!params.success || !body.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(audit, "request.invalid"),
        );
      if (operations.runConnectorDraftTest === undefined)
        return failure(reply, 503, "service.unavailable");
      return operations.runConnectorDraftTest(
        {
          descriptorType: params.data.type,
          operation: params.data.operation,
          settings: body.data.settings,
          confirmationId: body.data.confirmationId,
        },
        await operations.resolve(request, { mutation: true }),
      );
    },
  );
  app.put("/v1/admin/role-assignments/:principalId", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.roleAssignment.replace.invalid",
      "identity.manage",
      "workspace_role_assignment",
      "invalid",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const params = z
      .object({ principalId: identifier })
      .strict()
      .safeParse(request.params);
    const body = roleAssignment.safeParse(request.body);
    if (!params.success || !body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    return operations.replaceWorkspacePrincipalRoles(
      { targetPrincipalId: params.data.principalId, ...body.data },
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.get(
    "/v1/admin/role-assignments/:principalId/assignment",
    async (request, reply) => {
      const params = z
        .object({ principalId: identifier })
        .strict()
        .safeParse(request.params);
      if (!params.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(
            invalidReadAudit(
              "admin.roleAssignment.inspect",
              "identity.manage",
              "workspace_role_assignment",
              "invalid",
            ),
            "request.invalid",
          ),
        );
      return operations.workspacePrincipalRoles(
        params.data.principalId,
        await operations.resolve(request, { mutation: false }),
      );
    },
  );
  app.post("/v1/admin/secret-references", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.secretReference.create.invalid",
      "credential.manage",
      "secret_reference",
      "new",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = secretReferenceRegistration.safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    return operations.createSecretReference(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post("/v1/admin/diagnostics/exports", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.diagnostics.export.request.invalid",
      "diagnostics.export",
      "diagnostic_export",
      "new",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    if (!noRequestBody.safeParse(request.body).success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    if (operations.requestDiagnosticExport === undefined) {
      return failure(reply, 503, "service.unavailable");
    }
    return reply
      .status(202)
      .send(
        await operations.requestDiagnosticExport(
          await operations.resolve(request, { mutation: true }),
        ),
      );
  });
  app.get("/v1/admin/diagnostics/exports/:exportId", async (request, reply) => {
    const params = z
      .object({ exportId: identifier })
      .strict()
      .safeParse(request.params);
    if (!params.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(
          invalidReadAudit(
            "admin.diagnostics.export.status.read",
            "diagnostics.export",
            "diagnostic_export",
            "invalid",
          ),
          "request.invalid",
        ),
      );
    if (operations.diagnosticExportStatus === undefined) {
      return failure(reply, 503, "service.unavailable");
    }
    return operations.diagnosticExportStatus(
      params.data.exportId,
      await operations.resolve(request, { mutation: false }),
    );
  });
  app.get(
    "/v1/admin/diagnostics/exports/:exportId/download",
    async (request, reply) => {
      const params = z
        .object({ exportId: identifier })
        .strict()
        .safeParse(request.params);
      if (!params.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(
            invalidReadAudit(
              "admin.diagnostics.export.download",
              "diagnostics.export",
              "diagnostic_export",
              "invalid",
            ),
            "request.invalid",
          ),
        );
      if (operations.downloadDiagnosticExport === undefined) {
        return failure(reply, 503, "service.unavailable");
      }
      const result = await operations.downloadDiagnosticExport(
        params.data.exportId,
        await operations.resolve(request, { mutation: false }),
      );
      reply.header("cache-control", "no-store");
      reply.header(
        "content-disposition",
        `attachment; filename="${result.fileName}"`,
      );
      reply.header("content-type", "application/json; charset=utf-8");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(Readable.from(result.content));
    },
  );
  app.post(
    "/v1/admin/privacy/case-snapshots/:caseSnapshotId/purge",
    async (request, reply) => {
      const audit = invalidMutationAudit(
        "admin.privacy.purge.preview.invalid",
        "privacy.delete",
        "case_snapshot",
        "invalid",
      );
      if (!(await requireIdempotency(operations, request, reply, audit)))
        return;
      const params = z
        .object({ caseSnapshotId: identifier })
        .strict()
        .safeParse(request.params);
      const body = privacyPurge.safeParse(request.body);
      if (!params.success || !body.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(audit, "request.invalid"),
        );
      return operations.previewPrivacyPurge(
        {
          caseSnapshotId: params.data.caseSnapshotId,
          reason: body.data.reason,
        },
        await operations.resolve(request, { mutation: true }),
      );
    },
  );
  app.post("/v1/admin/action-previews", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.action.preview.invalid",
      undefined,
      "administration_action",
      "invalid",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = z
      .object({
        action,
        target: z.object({ resource, id: identifier.optional() }).strict(),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    return operations.previewAction(
      {
        action: body.data.action,
        resource: body.data.target.resource,
        ...(body.data.target.id === undefined
          ? {}
          : { id: body.data.target.id }),
      },
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post("/v1/admin/actions/execute", async (request, reply) => {
    const audit = invalidMutationAudit(
      "admin.action.execute.invalid",
      undefined,
      "administration_action_preview",
      "invalid",
    );
    if (!(await requireIdempotency(operations, request, reply, audit))) return;
    const body = z
      .object({ previewId: identifier })
      .strict()
      .safeParse(request.body);
    if (!body.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(audit, "request.invalid"),
      );
    return operations.executeAction(
      body.data.previewId,
      await operations.resolve(request, { mutation: true }),
    );
  });

  app.get("/v1/admin/configuration-surfaces", async (request) =>
    operations.configurationSurfaces(
      await operations.resolve(request, { mutation: false }),
    ),
  );
  app.get(
    "/v1/admin/configurations/:configurationId",
    async (request, reply) => {
      const params = z
        .object({ configurationId: identifier })
        .strict()
        .safeParse(request.params);
      if (!params.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(
            invalidReadAudit(
              "admin.configuration.inspect",
              "configuration.read",
              "configuration",
              "invalid",
            ),
            "request.invalid",
          ),
        );
      return operations.configurationInspection(
        params.data.configurationId,
        await operations.resolve(request, { mutation: false }),
      );
    },
  );
  app.get(
    "/v1/admin/configurations/:configurationId/versions",
    async (request, reply) => {
      const params = z
        .object({ configurationId: identifier })
        .strict()
        .safeParse(request.params);
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(25),
          after: identifier.optional(),
        })
        .strict()
        .safeParse(request.query);
      if (!params.success || !query.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(
            invalidReadAudit(
              "admin.configuration.history.read",
              "configuration.read",
              "configuration",
              "invalid",
            ),
            "request.invalid",
          ),
        );
      return operations.configurationHistory(
        params.data.configurationId,
        query.data,
        await operations.resolve(request, { mutation: false }),
      );
    },
  );
  app.get(
    "/v1/admin/configurations/:configurationId/versions/:versionId",
    async (request, reply) => {
      const params = z
        .object({ configurationId: identifier, versionId: identifier })
        .strict()
        .safeParse(request.params);
      if (!params.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(
            invalidReadAudit(
              "admin.configuration.version.read",
              "configuration.read",
              "configuration_version",
              "invalid",
            ),
            "request.invalid",
          ),
        );
      return operations.configurationVersion(
        params.data.configurationId,
        params.data.versionId,
        await operations.resolve(request, { mutation: false }),
      );
    },
  );

  // These are deliberately explicit: the browser client has a fixed allow-list
  // and no route is synthesized from a user supplied resource name.
  const nestedResources: ReadonlyArray<readonly [string, AdminResource]> = [
    ["/v1/admin/ai/provider-instances", "ai-provider-instances"],
    ["/v1/admin/ai/catalog-snapshots", "ai-catalog-snapshots"],
    ["/v1/admin/ai/models", "ai-models"],
    ["/v1/admin/ai/bindings", "ai-bindings"],
    ["/v1/admin/ai/role-defaults", "ai-role-defaults"],
    ["/v1/admin/ai/pricing-overrides", "ai-pricing-overrides"],
    ["/v1/admin/ai/budgets", "ai-budgets"],
    ["/v1/admin/operations/jobs", "operation-jobs"],
    ["/v1/admin/operations/dead-letters", "dead-letters"],
  ];
  for (const [path, resourceName] of nestedResources) {
    app.get(`${path}/:id`, async (request, reply) => {
      const params = z.object({ id: identifier }).safeParse(request.params);
      if (!params.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(
            invalidReadAudit(
              `admin.${resourceName}.detail.invalid`,
              policyForResource(resourceName).permission,
              "administration_resource",
              "invalid",
            ),
            "request.invalid",
          ),
        );
      return operations.detail(
        resourceName,
        params.data.id,
        await operations.resolve(request, { mutation: false }),
      );
    });
    app.get(path, async (request, reply) => {
      const query = listQuery.safeParse(request.query);
      if (!query.success)
        return rejectInvalidRequest(
          operations,
          request,
          reply,
          invalidRequestAudit(
            invalidReadAudit(
              `admin.${resourceName}.list.invalid`,
              policyForResource(resourceName).permission,
              "administration_resource",
              resourceName,
            ),
            "request.invalid",
          ),
        );
      return operations.list(
        resourceName,
        query.data,
        await operations.resolve(request, { mutation: false }),
      );
    });
  }

  app.get("/v1/admin/:resource/:id", async (request, reply) => {
    const resourceParams = z.object({ resource }).safeParse(request.params);
    if (!resourceParams.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(
          invalidReadAudit(
            "admin.resource.detail.invalid",
            undefined,
            "administration_resource",
            "invalid",
          ),
          "request.invalid",
        ),
      );
    const idParams = z.object({ id: identifier }).safeParse(request.params);
    if (!idParams.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(
          invalidReadAudit(
            `admin.${resourceParams.data.resource}.detail.invalid`,
            policyForResource(resourceParams.data.resource).permission,
            "administration_resource",
            "invalid",
          ),
          "request.invalid",
        ),
      );
    return operations.detail(
      resourceParams.data.resource,
      idParams.data.id,
      await operations.resolve(request, { mutation: false }),
    );
  });
  app.get("/v1/admin/:resource", async (request, reply) => {
    const params = z.object({ resource }).safeParse(request.params);
    if (!params.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(
          invalidReadAudit(
            "admin.resource.list.invalid",
            undefined,
            "administration_resource",
            "invalid",
          ),
          "request.invalid",
        ),
      );
    const query = listQuery.safeParse(request.query);
    if (!query.success)
      return rejectInvalidRequest(
        operations,
        request,
        reply,
        invalidRequestAudit(
          invalidReadAudit(
            `admin.${params.data.resource}.list.invalid`,
            policyForResource(params.data.resource).permission,
            "administration_resource",
            params.data.resource,
          ),
          "request.invalid",
        ),
      );
    return operations.list(
      params.data.resource,
      query.data,
      await operations.resolve(request, { mutation: false }),
    );
  });
}

function containsSecretLikeKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSecretLikeKey);
  return Object.entries(value).some(
    ([key, nested]) =>
      /(secret|token|password|credential|authorization|api[-_]?key)/iu.test(
        key,
      ) || containsSecretLikeKey(nested),
  );
}

import { Readable } from "node:stream";
