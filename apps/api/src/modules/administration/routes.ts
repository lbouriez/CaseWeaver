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
    normalizationProfileVersion: identifier,
    chunkingProfileVersion: identifier,
    synchronizationPolicy: z
      .record(z.string().min(1).max(200), z.unknown())
      .refine((value) => Object.keys(value).length <= 100),
    deletionBehavior: z.enum(["tombstone", "retain"]),
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

export interface AdministrationRouteOperations {
  resolve(
    request: unknown,
    options: { readonly mutation: boolean },
  ): Promise<AdminRequestContext>;
  session(request: unknown): Promise<unknown>;
  login(request: unknown): Promise<{ readonly redirectTo: string }>;
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

function requireIdempotency(
  request: { headers: Record<string, unknown> },
  reply: { status(code: number): { send(value: unknown): unknown } },
): unknown | undefined {
  const value = request.headers["idempotency-key"];
  return typeof value === "string" && value.length >= 16 && value.length <= 200
    ? undefined
    : failure(reply, 400, "idempotency.required");
}

export function registerAdministrationRoutes(
  app: ApiInstance,
  operations: AdministrationRouteOperations,
): void {
  app.get("/v1/auth/login", async (request, reply) => {
    const response = await operations.login(request);
    return reply.redirect(response.redirectTo);
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
    if (requireIdempotency(request, reply) !== undefined) return;
    const response = await operations.logout(request);
    reply.header("set-cookie", response.setCookie);
    return reply.status(204).send();
  });
  app.post("/v1/auth/session/workspace", async (request, reply) => {
    if (requireIdempotency(request, reply) !== undefined) return;
    const body = z
      .object({ workspaceId: identifier })
      .strict()
      .safeParse(request.body);
    if (!body.success) return failure(reply, 400, "request.invalid");
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
    if (!params.success) return failure(reply, 404, "resource.notFound");
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
    if (requireIdempotency(request, reply) !== undefined) return;
    const body = draft.safeParse(request.body);
    if (!body.success) return failure(reply, 400, "request.invalid");
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
  app.post("/v1/admin/knowledge-sources/drafts", async (request, reply) => {
    if (requireIdempotency(request, reply) !== undefined) return;
    const body = sourceDraft.safeParse(request.body);
    if (!body.success) return failure(reply, 400, "request.invalid");
    return operations.createKnowledgeSourceDraft(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post("/v1/admin/schedules/drafts", async (request, reply) => {
    if (requireIdempotency(request, reply) !== undefined) return;
    const body = scheduleDraft.safeParse(request.body);
    if (!body.success) return failure(reply, 400, "request.invalid");
    return operations.createKnowledgeScheduleDraft(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post("/v1/admin/publication-profiles/drafts", async (request, reply) => {
    if (requireIdempotency(request, reply) !== undefined) return;
    const body = publicationProfileDraft.safeParse(request.body);
    if (!body.success) return failure(reply, 400, "request.invalid");
    if (operations.createPublicationProfile === undefined) {
      return failure(reply, 503, "service.unavailable");
    }
    return operations.createPublicationProfile(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post("/v1/admin/webhook-endpoints/drafts", async (request, reply) => {
    if (requireIdempotency(request, reply) !== undefined) return;
    const body = webhookEndpointDraft.safeParse(request.body);
    if (!body.success) return failure(reply, 400, "request.invalid");
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
    if (requireIdempotency(request, reply) !== undefined) return;
    const params = z
      .object({ id: identifier })
      .strict()
      .safeParse(request.params);
    const body = configurationLifecycleTransition.safeParse(request.body);
    if (!params.success || !body.success)
      return failure(reply, 400, "request.invalid");
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
    if (requireIdempotency(request, reply) !== undefined) return;
    const params = z
      .object({ id: identifier })
      .strict()
      .safeParse(request.params);
    const body = configurationLifecycleTransition.safeParse(request.body);
    if (!params.success || !body.success)
      return failure(reply, 400, "request.invalid");
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
    if (requireIdempotency(request, reply) !== undefined) return;
    const body = platformLinks.safeParse(request.body);
    if (!body.success) return failure(reply, 400, "request.invalid");
    if (operations.savePlatformLinks === undefined)
      return failure(reply, 503, "service.unavailable");
    return operations.savePlatformLinks(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post("/v1/admin/ai/bindings/drafts", async (request, reply) => {
    if (requireIdempotency(request, reply) !== undefined) return;
    const body = aiBindingDraft.safeParse(request.body);
    if (!body.success || operations.createAiBindingDraft === undefined)
      return failure(
        reply,
        body.success ? 503 : 400,
        body.success ? "service.unavailable" : "request.invalid",
      );
    return operations.createAiBindingDraft(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post(
    "/v1/admin/ai/bindings/:id/versions/drafts",
    async (request, reply) => {
      if (requireIdempotency(request, reply) !== undefined) return;
      const params = z
        .object({ id: identifier })
        .strict()
        .safeParse(request.params);
      const body = aiBindingVersionDraft.safeParse(request.body);
      if (
        !params.success ||
        !body.success ||
        operations.createAiBindingVersionDraft === undefined
      )
        return failure(
          reply,
          params.success && body.success ? 503 : 400,
          params.success && body.success
            ? "service.unavailable"
            : "request.invalid",
        );
      return operations.createAiBindingVersionDraft(
        { bindingId: params.data.id, ...body.data },
        await operations.resolve(request, { mutation: true }),
      );
    },
  );
  app.post("/v1/admin/ai/bindings/:id/lifecycle", async (request, reply) => {
    if (requireIdempotency(request, reply) !== undefined) return;
    const params = z
      .object({ id: identifier })
      .strict()
      .safeParse(request.params);
    const body = configurationLifecycleTransition.safeParse(request.body);
    if (
      !params.success ||
      !body.success ||
      operations.transitionAiBinding === undefined
    )
      return failure(
        reply,
        params.success && body.success ? 503 : 400,
        params.success && body.success
          ? "service.unavailable"
          : "request.invalid",
      );
    return operations.transitionAiBinding(
      { bindingId: params.data.id, ...body.data },
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.put("/v1/admin/ai/role-defaults/:role", async (request, reply) => {
    if (requireIdempotency(request, reply) !== undefined) return;
    const params = z
      .object({ role: aiRole })
      .strict()
      .safeParse(request.params);
    const body = aiRoleDefault.safeParse(request.body);
    if (
      !params.success ||
      !body.success ||
      operations.setAiRoleDefault === undefined
    )
      return failure(
        reply,
        params.success && body.success ? 503 : 400,
        params.success && body.success
          ? "service.unavailable"
          : "request.invalid",
      );
    return operations.setAiRoleDefault(
      { role: params.data.role, ...body.data },
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post("/v1/admin/ai/pricing-overrides", async (request, reply) => {
    if (requireIdempotency(request, reply) !== undefined) return;
    const body = aiPriceOverride.safeParse(request.body);
    if (!body.success || operations.createAiPriceOverride === undefined)
      return failure(
        reply,
        body.success ? 503 : 400,
        body.success ? "service.unavailable" : "request.invalid",
      );
    return operations.createAiPriceOverride(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.put("/v1/admin/ai/budgets", async (request, reply) => {
    if (requireIdempotency(request, reply) !== undefined) return;
    const body = aiBudget.safeParse(request.body);
    if (!body.success || operations.replaceAiBudget === undefined)
      return failure(
        reply,
        body.success ? 503 : 400,
        body.success ? "service.unavailable" : "request.invalid",
      );
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
      if (!params.success) return failure(reply, 404, "resource.notFound");
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
      if (requireIdempotency(request, reply) !== undefined) return;
      const params = z
        .object({ id: identifier, operation: identifier })
        .strict()
        .safeParse(request.params);
      if (
        !params.success ||
        operations.previewProviderCapabilityTest === undefined
      )
        return failure(
          reply,
          params.success ? 503 : 400,
          params.success ? "service.unavailable" : "request.invalid",
        );
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
      if (requireIdempotency(request, reply) !== undefined) return;
      const params = z
        .object({ id: identifier, operation: identifier })
        .strict()
        .safeParse(request.params);
      const body = z
        .object({ confirmationId: identifier })
        .strict()
        .safeParse(request.body);
      if (
        !params.success ||
        !body.success ||
        operations.runProviderCapabilityTest === undefined
      )
        return failure(
          reply,
          params.success && body.success ? 503 : 400,
          params.success && body.success
            ? "service.unavailable"
            : "request.invalid",
        );
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
  app.put("/v1/admin/role-assignments/:principalId", async (request, reply) => {
    if (requireIdempotency(request, reply) !== undefined) return;
    const params = z
      .object({ principalId: identifier })
      .strict()
      .safeParse(request.params);
    const body = roleAssignment.safeParse(request.body);
    if (!params.success || !body.success)
      return failure(reply, 400, "request.invalid");
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
      if (!params.success) return failure(reply, 404, "resource.notFound");
      return operations.workspacePrincipalRoles(
        params.data.principalId,
        await operations.resolve(request, { mutation: false }),
      );
    },
  );
  app.post("/v1/admin/secret-references", async (request, reply) => {
    if (requireIdempotency(request, reply) !== undefined) return;
    const body = secretReferenceRegistration.safeParse(request.body);
    if (!body.success) return failure(reply, 400, "request.invalid");
    return operations.createSecretReference(
      body.data,
      await operations.resolve(request, { mutation: true }),
    );
  });
  app.post("/v1/admin/diagnostics/exports", async (request, reply) => {
    if (requireIdempotency(request, reply) !== undefined) return;
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
    if (!params.success) return failure(reply, 404, "resource.notFound");
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
      if (!params.success) return failure(reply, 404, "resource.notFound");
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
      if (requireIdempotency(request, reply) !== undefined) return;
      const params = z
        .object({ caseSnapshotId: identifier })
        .strict()
        .safeParse(request.params);
      const body = privacyPurge.safeParse(request.body);
      if (!params.success || !body.success)
        return failure(reply, 400, "request.invalid");
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
    if (requireIdempotency(request, reply) !== undefined) return;
    const body = z
      .object({
        action,
        target: z.object({ resource, id: identifier.optional() }).strict(),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success) return failure(reply, 400, "request.invalid");
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
    if (requireIdempotency(request, reply) !== undefined) return;
    const body = z
      .object({ previewId: identifier })
      .strict()
      .safeParse(request.body);
    if (!body.success) return failure(reply, 400, "request.invalid");
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
      if (!params.success) return failure(reply, 404, "resource.notFound");
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
        return failure(reply, 400, "request.invalid");
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
      if (!params.success) return failure(reply, 404, "resource.notFound");
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
      if (!params.success) return failure(reply, 404, "resource.notFound");
      return operations.detail(
        resourceName,
        params.data.id,
        await operations.resolve(request, { mutation: false }),
      );
    });
    app.get(path, async (request, reply) => {
      const query = listQuery.safeParse(request.query);
      if (!query.success) return failure(reply, 400, "request.invalid");
      return operations.list(
        resourceName,
        query.data,
        await operations.resolve(request, { mutation: false }),
      );
    });
  }

  app.get("/v1/admin/:resource/:id", async (request, reply) => {
    const params = z
      .object({ resource, id: identifier })
      .safeParse(request.params);
    if (!params.success) return failure(reply, 404, "resource.notFound");
    return operations.detail(
      params.data.resource,
      params.data.id,
      await operations.resolve(request, { mutation: false }),
    );
  });
  app.get("/v1/admin/:resource", async (request, reply) => {
    const params = z.object({ resource }).safeParse(request.params);
    const query = listQuery.safeParse(request.query);
    if (!params.success || !query.success)
      return failure(reply, 400, "request.invalid");
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
