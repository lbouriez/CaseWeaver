import { IdempotencyConflictError } from "@caseweaver/administration";
import type { Permission } from "@caseweaver/security";
import { describe, expect, it, vi } from "vitest";

import { buildApi } from "../../app.js";
import type { ApiConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import type {
  AdministrationRouteOperations,
  AdminRequestContext,
} from "./routes.js";

const config: ApiConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  databaseUrl: "postgresql://localhost/caseweaver_test",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  principalId: "principal-1",
  databaseReadinessTimeoutMs: 500,
  allowedAdminOrigins: [],
  trustedProxyCidrs: [],
};

const context: AdminRequestContext = {
  principalId: "principal-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  permissions: ["configuration.manage"] as readonly Permission[],
  requestId: "request-1",
  correlationId: "correlation-1",
  requestMode: "user",
};

function createOperations(): AdministrationRouteOperations {
  return {
    resolve: vi.fn(async () => context),
    session: vi.fn(async () => ({ authenticated: false })),
    login: vi.fn(async () => ({
      redirectTo: "https://issuer.example/authorize",
    })),
    callback: vi.fn(async () => ({ redirectTo: "/" })),
    logout: vi.fn(async () => undefined),
    switchWorkspace: vi.fn(async () => ({ authenticated: false })),
    descriptors: vi.fn(async () => ({ items: [] })),
    list: vi.fn(async () => ({ items: [], page: { hasNextPage: false } })),
    detail: vi.fn(async () => ({ id: "item-1", label: "Item", fields: {} })),
    configurationInspection: vi.fn(async () => ({
      id: "configuration-1",
      lifecycle: "draft",
    })),
    configurationHistory: vi.fn(async () => ({
      items: [],
      page: { hasNextPage: false },
    })),
    configurationVersion: vi.fn(async () => ({ id: "version-1", version: 1 })),
    configurationSurfaces: vi.fn(async () => ({ items: [] })),
    createDraft: vi.fn(async () => ({
      id: "draft-1",
      label: "Draft",
      fields: {},
    })),
    createSecretReference: vi.fn(async () => ({
      id: "credential-1",
      label: "Secret reference credential-1",
      status: "active",
      fields: {},
    })),
    createKnowledgeSourceDraft: vi.fn(async () => ({
      id: "source-1",
      label: "Support knowledge",
      status: "draft",
      version: "1",
      fields: {},
    })),
    createKnowledgeScheduleDraft: vi.fn(async () => ({
      id: "schedule-1",
      label: "Hourly synchronization",
      status: "draft",
      version: "1",
      fields: {},
    })),
    createAiBindingVersionDraft: vi.fn(async () => ({
      id: "binding-1",
      label: "AI binding binding-1",
      status: "draft",
      version: "3",
      fields: {},
    })),
    transitionKnowledgeSource: vi.fn(async () => ({
      id: "source-1",
      label: "Support knowledge",
      status: "enabled",
      version: "2",
      fields: {},
    })),
    transitionKnowledgeSchedule: vi.fn(async () => ({
      id: "schedule-1",
      label: "Hourly synchronization",
      status: "enabled",
      version: "2",
      fields: {},
    })),
    providerCapabilityTestOperations: vi.fn(async () => ({
      items: [
        {
          operation: "provider.test",
          requiresConfirmation: true,
          requiresIdempotencyKey: true,
        },
      ],
    })),
    previewProviderCapabilityTest: vi.fn(async () => ({
      providerInstanceId: "provider-1",
      providerInstanceVersionId: "provider-version-1",
      bindingVersionId: "binding-version-1",
      testOperation: "provider.test",
      pricingStatus: "known",
      canConfirm: true,
      confirmationId: "confirmation-1",
      confirmation: "Run provider capability test",
      impact: "A bounded test will run.",
      estimatedCost: { amount: "0.001", currency: "USD" },
      expiresAt: "2026-07-15T12:05:00.000Z",
    })),
    runProviderCapabilityTest: vi.fn(async () => ({
      id: "capability-test-1",
      providerInstanceId: "provider-1",
      outcome: "succeeded",
      idempotency: "created",
      completedAt: "2026-07-15T12:01:00.000Z",
    })),
    replaceWorkspacePrincipalRoles: vi.fn(async () => ({
      id: "principal-2",
      label: "Roles for principal-2",
      status: "updated",
      version: "3",
      fields: { roles: "analyst" },
    })),
    workspacePrincipalRoles: vi.fn(async () => ({
      principalId: "principal-2",
      roles: ["analyst"],
      revision: 3,
    })),
    previewPrivacyPurge: vi.fn(async () => ({
      previewId: "preview-privacy-1",
      action: "privacy.purge",
      confirmation: "Confirm privacy purge",
      impact: "A governed snapshot will be tombstoned.",
      canConfirm: true,
      expiresAt: "2026-07-15T12:05:00.000Z",
    })),
    previewAction: vi.fn(async () => ({ previewId: "preview-1" })),
    executeAction: vi.fn(async () => ({
      operationId: "operation-1",
      outcome: "accepted",
      message: "Accepted",
    })),
  };
}

function createApp(operations = createOperations()) {
  return {
    operations,
    app: buildApi({
      config,
      logger: createLogger(config),
      readinessProbe: { check: async () => "ready" },
      administration: operations,
    }),
  };
}

describe("administration API routes", () => {
  it("uses explicit, bounded list routes and authenticated context", async () => {
    const built = createApp();
    const response = await built.app.inject({
      method: "GET",
      url: "/v1/admin/connector-instances?limit=50",
    });
    expect(response.statusCode).toBe(200);
    expect(built.operations.list).toHaveBeenCalledWith(
      "connector-instances",
      expect.objectContaining({ limit: 50 }),
      context,
    );
    await built.app.close();
  });

  it("uses dedicated immutable configuration inspection routes before generic resources", async () => {
    const built = createApp();
    const inspection = await built.app.inject({
      method: "GET",
      url: "/v1/admin/configurations/configuration-1",
    });
    const history = await built.app.inject({
      method: "GET",
      url: "/v1/admin/configurations/configuration-1/versions?limit=25",
    });
    const version = await built.app.inject({
      method: "GET",
      url: "/v1/admin/configurations/configuration-1/versions/version-1",
    });
    const surfaces = await built.app.inject({
      method: "GET",
      url: "/v1/admin/configuration-surfaces",
    });

    expect(inspection.statusCode).toBe(200);
    expect(history.statusCode).toBe(200);
    expect(version.statusCode).toBe(200);
    expect(surfaces.statusCode).toBe(200);
    expect(built.operations.configurationInspection).toHaveBeenCalledWith(
      "configuration-1",
      context,
    );
    expect(built.operations.configurationHistory).toHaveBeenCalledWith(
      "configuration-1",
      { limit: 25 },
      context,
    );
    expect(built.operations.configurationVersion).toHaveBeenCalledWith(
      "configuration-1",
      "version-1",
      context,
    );
    expect(built.operations.configurationSurfaces).toHaveBeenCalledWith(
      context,
    );
    await built.app.close();
  });

  it("returns server-owned explicit surface state without inventing a workflow", async () => {
    const operations = createOperations();
    operations.configurationSurfaces = vi.fn(async () => ({
      items: [
        {
          surface: "knowledge-sources",
          mode: "read_only",
          reasonCode: "workflow_not_composed",
          reason: "Source definition changes are not available.",
          workflows: [],
          operationalActions: ["source.synchronize", "source.fullRescan"],
        },
        {
          surface: "platform",
          mode: "read_only",
          reasonCode: "deployment_owned",
          reason: "Configured by the deployment.",
          workflows: [],
          operationalActions: [],
        },
      ],
    }));
    const built = createApp(operations);
    const response = await built.app.inject({
      method: "GET",
      url: "/v1/admin/configuration-surfaces",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        expect.objectContaining({
          surface: "knowledge-sources",
          mode: "read_only",
          workflows: [],
          operationalActions: ["source.synchronize", "source.fullRescan"],
        }),
        expect.objectContaining({
          surface: "platform",
          mode: "read_only",
          reasonCode: "deployment_owned",
          workflows: [],
          operationalActions: [],
        }),
      ],
    });
    expect(response.body).not.toMatch(/secret|credential|locator|token|url/iu);
    expect(operations.configurationSurfaces).toHaveBeenCalledWith(context);
    await built.app.close();
  });

  it("requires idempotency for administration mutations", async () => {
    const built = createApp();
    const response = await built.app.inject({
      method: "POST",
      url: "/v1/admin/connector-instances/drafts",
      payload: {
        descriptorType: "git-markdown",
        displayName: "Docs",
        settings: {},
      },
    });
    expect(response.statusCode).toBe(400);
    expect(built.operations.createDraft).not.toHaveBeenCalled();
    await built.app.close();
  });

  it("accepts an opaque secret-backend reference without returning it", async () => {
    const built = createApp();
    const response = await built.app.inject({
      method: "POST",
      url: "/v1/admin/secret-references",
      headers: { "idempotency-key": "a-valid-idempotency-key" },
      payload: { reference: "vault:operator/api" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("reference");
    expect(built.operations.createSecretReference).toHaveBeenCalledWith(
      { reference: "vault:operator/api" },
      context,
    );
    await built.app.close();
  });

  it("creates resource-owned source and schedule drafts through bounded, idempotent routes", async () => {
    const built = createApp();
    const source = await built.app.inject({
      method: "POST",
      url: "/v1/admin/knowledge-sources/drafts",
      headers: { "idempotency-key": "a-valid-idempotency-key" },
      payload: {
        displayName: "Support knowledge",
        connectorInstanceId: "connector-1",
        collectionId: "collection-1",
        normalizationProfileVersion: "normalization-v1",
        chunkingProfileVersion: "chunking-v1",
        synchronizationPolicy: { trigger: "manual" },
        deletionBehavior: "tombstone",
      },
    });
    const schedule = await built.app.inject({
      method: "POST",
      url: "/v1/admin/schedules/drafts",
      headers: { "idempotency-key": "another-valid-idempotency-key" },
      payload: {
        displayName: "Hourly synchronization",
        sourceId: "source-1",
        sourceConfigurationVersionId: "source-version-1",
        kind: "synchronize",
        cadence: {
          kind: "interval",
          intervalMs: 3_600_000,
          overlapPolicy: "skip",
        },
        nextRunAt: "2026-07-15T13:00:00.000Z",
      },
    });

    expect(source.statusCode).toBe(200);
    expect(schedule.statusCode).toBe(200);
    expect(built.operations.createKnowledgeSourceDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorInstanceId: "connector-1",
        collectionId: "collection-1",
        deletionBehavior: "tombstone",
      }),
      context,
    );
    expect(built.operations.createKnowledgeScheduleDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "source-1",
        sourceConfigurationVersionId: "source-version-1",
        cadence: expect.objectContaining({ kind: "interval" }),
      }),
      context,
    );
    expect(`${source.body}${schedule.body}`).not.toMatch(
      /secret|token|locator/iu,
    );
    await built.app.close();
  });

  it("rejects source and schedule drafts before they reach an operation", async () => {
    const built = createApp();
    const source = await built.app.inject({
      method: "POST",
      url: "/v1/admin/knowledge-sources/drafts",
      headers: { "idempotency-key": "a-valid-idempotency-key" },
      payload: { displayName: "Incomplete" },
    });
    const schedule = await built.app.inject({
      method: "POST",
      url: "/v1/admin/schedules/drafts",
      headers: { "idempotency-key": "a-valid-idempotency-key" },
      payload: {
        displayName: "Bad schedule",
        sourceId: "source-1",
        sourceConfigurationVersionId: "source-version-1",
        kind: "synchronize",
        cadence: { kind: "interval", intervalMs: 1, overlapPolicy: "skip" },
        nextRunAt: "not-a-time",
      },
    });
    expect(source.statusCode).toBe(400);
    expect(schedule.statusCode).toBe(400);
    expect(built.operations.createKnowledgeSourceDraft).not.toHaveBeenCalled();
    expect(
      built.operations.createKnowledgeScheduleDraft,
    ).not.toHaveBeenCalled();
    await built.app.close();
  });

  it("transitions source and schedule lifecycles with only an optimistic revision and lifecycle", async () => {
    const built = createApp();
    const source = await built.app.inject({
      method: "POST",
      url: "/v1/admin/knowledge-sources/source-1/lifecycle",
      headers: { "idempotency-key": "a-valid-idempotency-key" },
      payload: { expectedRevision: 1, lifecycle: "active" },
    });
    const schedule = await built.app.inject({
      method: "POST",
      url: "/v1/admin/schedules/schedule-1/lifecycle",
      headers: { "idempotency-key": "another-valid-idempotency-key" },
      payload: { expectedRevision: 1, lifecycle: "disabled" },
    });

    expect(source.statusCode).toBe(200);
    expect(schedule.statusCode).toBe(200);
    expect(built.operations.transitionKnowledgeSource).toHaveBeenCalledWith(
      { sourceId: "source-1", expectedRevision: 1, lifecycle: "active" },
      context,
    );
    expect(built.operations.transitionKnowledgeSchedule).toHaveBeenCalledWith(
      {
        scheduleId: "schedule-1",
        expectedRevision: 1,
        lifecycle: "disabled",
      },
      context,
    );
    expect(`${source.body}${schedule.body}`).not.toMatch(
      /connector|collection|secret|token|settings/iu,
    );
    await built.app.close();
  });

  it("replaces workspace roles using only a target, role set, and aggregate revision", async () => {
    const built = createApp();
    const response = await built.app.inject({
      method: "PUT",
      url: "/v1/admin/role-assignments/principal-2",
      headers: { "idempotency-key": "a-valid-idempotency-key" },
      payload: { roles: ["analyst"], expectedRevision: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(
      built.operations.replaceWorkspacePrincipalRoles,
    ).toHaveBeenCalledWith(
      {
        targetPrincipalId: "principal-2",
        roles: ["analyst"],
        expectedRevision: 2,
      },
      context,
    );
    expect(response.body).not.toMatch(/workspaceId|actor|token|secret/iu);
    await built.app.close();
  });

  it("reads the workspace role revision through a dedicated audited endpoint", async () => {
    const built = createApp();
    const response = await built.app.inject({
      method: "GET",
      url: "/v1/admin/role-assignments/principal-2/assignment",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      principalId: "principal-2",
      roles: ["analyst"],
      revision: 3,
    });
    expect(built.operations.workspacePrincipalRoles).toHaveBeenCalledWith(
      "principal-2",
      context,
    );
    await built.app.close();
  });

  it("accepts, reads, and downloads diagnostic exports through explicit audited routes", async () => {
    const operations = createOperations();
    operations.requestDiagnosticExport = vi.fn(async () => ({
      id: "diagnostic-export-1",
      status: "requested",
      eventCutoffAt: "2026-07-15T12:00:00.000Z",
      expiresAt: "2026-07-15T13:00:00.000Z",
    }));
    operations.diagnosticExportStatus = vi.fn(async () => ({
      id: "diagnostic-export-1",
      status: "ready",
      eventCutoffAt: "2026-07-15T12:00:00.000Z",
      expiresAt: "2026-07-15T13:00:00.000Z",
      generatedAt: "2026-07-15T12:01:00.000Z",
    }));
    operations.downloadDiagnosticExport = vi.fn(async () => ({
      content: (async function* () {
        yield new TextEncoder().encode('{"events":[]}');
      })(),
      fileName: "caseweaver-diagnostics-diagnostic-export-1.json",
    }));
    const built = createApp(operations);
    const accepted = await built.app.inject({
      method: "POST",
      url: "/v1/admin/diagnostics/exports",
      headers: { "idempotency-key": "a-valid-idempotency-key" },
    });
    const status = await built.app.inject({
      method: "GET",
      url: "/v1/admin/diagnostics/exports/diagnostic-export-1",
    });
    const download = await built.app.inject({
      method: "GET",
      url: "/v1/admin/diagnostics/exports/diagnostic-export-1/download",
    });

    expect(accepted.statusCode).toBe(202);
    expect(status.statusCode).toBe(200);
    expect(download.statusCode).toBe(200);
    expect(download.headers["cache-control"]).toBe("no-store");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.body).toBe('{"events":[]}');
    expect(accepted.body).not.toMatch(/locator|storage|url|secret/iu);
    expect(operations.requestDiagnosticExport).toHaveBeenCalledWith(context);
    expect(operations.diagnosticExportStatus).toHaveBeenCalledWith(
      "diagnostic-export-1",
      context,
    );
    expect(operations.downloadDiagnosticExport).toHaveBeenCalledWith(
      "diagnostic-export-1",
      context,
    );
    await built.app.close();
  });

  it("maps frontend descriptor catalog endpoints to provider-neutral catalog kinds", async () => {
    const built = createApp();
    const response = await built.app.inject({
      method: "GET",
      url: "/v1/admin/descriptors/connectors",
    });
    expect(response.statusCode).toBe(200);
    expect(built.operations.descriptors).toHaveBeenCalledWith(
      "connector",
      undefined,
      context,
    );
    await built.app.close();
  });

  it("keeps provider capability tests server-owned, confirmation-bound, and idempotent", async () => {
    const built = createApp();
    const listed = await built.app.inject({
      method: "GET",
      url: "/v1/admin/ai/provider-instances/provider-1/capability-tests",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [
        {
          operation: "provider.test",
          requiresConfirmation: true,
          requiresIdempotencyKey: true,
        },
      ],
    });
    const preview = await built.app.inject({
      method: "POST",
      url: "/v1/admin/ai/provider-instances/provider-1/capability-tests/provider.test/previews",
      headers: { "idempotency-key": "a-valid-idempotency-key" },
    });
    expect(preview.statusCode).toBe(200);
    expect(built.operations.previewProviderCapabilityTest).toHaveBeenCalledWith(
      { providerInstanceId: "provider-1", testOperation: "provider.test" },
      context,
    );
    const execution = await built.app.inject({
      method: "POST",
      url: "/v1/admin/ai/provider-instances/provider-1/capability-tests/provider.test/executions",
      headers: { "idempotency-key": "a-second-valid-idempotency-key" },
      payload: { confirmationId: "confirmation-1" },
    });
    expect(execution.statusCode).toBe(200);
    expect(built.operations.runProviderCapabilityTest).toHaveBeenCalledWith(
      {
        providerInstanceId: "provider-1",
        testOperation: "provider.test",
        confirmationId: "confirmation-1",
      },
      context,
    );
    await built.app.close();
  });

  it("creates an AI binding successor only through its immutable-version endpoint", async () => {
    const built = createApp();
    const response = await built.app.inject({
      method: "POST",
      url: "/v1/admin/ai/bindings/binding-1/versions/drafts",
      headers: { "idempotency-key": "a-valid-idempotency-key" },
      payload: {
        expectedRevision: 2,
        providerInstanceId: "provider-1",
        catalogSnapshotId: "catalog-1",
        canonicalModel: "provider/model-1",
        role: "analysis",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(built.operations.createAiBindingVersionDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: "binding-1",
        expectedRevision: 2,
        providerInstanceId: "provider-1",
      }),
      context,
    );
    await built.app.close();
  });

  it("accepts a bounded privacy reason only at its resource-specific endpoint and never returns it", async () => {
    const built = createApp();
    const reason = "Verified data-subject deletion request";
    const response = await built.app.inject({
      method: "POST",
      url: "/v1/admin/privacy/case-snapshots/snapshot-1/purge",
      headers: { "idempotency-key": "a-valid-idempotency-key" },
      payload: { reason },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(reason);
    expect(built.operations.previewPrivacyPurge).toHaveBeenCalledWith(
      { caseSnapshotId: "snapshot-1", reason },
      context,
    );
    await built.app.close();
  });

  it("rejects a privacy purge without its required reason before invoking operations", async () => {
    const built = createApp();
    const response = await built.app.inject({
      method: "POST",
      url: "/v1/admin/privacy/case-snapshots/snapshot-1/purge",
      headers: { "idempotency-key": "a-valid-idempotency-key" },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(built.operations.previewPrivacyPurge).not.toHaveBeenCalled();
    await built.app.close();
  });

  it("rejects an over-limit privacy reason before it reaches the operation or preview store", async () => {
    const built = createApp();
    const response = await built.app.inject({
      method: "POST",
      url: "/v1/admin/privacy/case-snapshots/snapshot-1/purge",
      headers: { "idempotency-key": "a-valid-idempotency-key" },
      payload: { reason: "x".repeat(4_001) },
    });
    expect(response.statusCode).toBe(400);
    expect(built.operations.previewPrivacyPurge).not.toHaveBeenCalled();
    await built.app.close();
  });

  it("returns credentialed CORS headers only for an explicitly configured UI origin", async () => {
    const operations = createOperations();
    const app = buildApi({
      config: {
        ...config,
        allowedAdminOrigins: ["https://console.example.test"],
      },
      logger: createLogger(config),
      readinessProbe: { check: async () => "ready" },
      administration: operations,
    });
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/admin/connector-instances",
      headers: { origin: "https://console.example.test" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://console.example.test",
    );
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    await app.close();
  });

  it("maps a server-side idempotency conflict to the typed conflict response", async () => {
    const operations = createOperations();
    vi.mocked(operations.createDraft).mockRejectedValue(
      new IdempotencyConflictError(),
    );
    const app = createApp(operations).app;
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/connector-instances/drafts",
      headers: { "idempotency-key": "a-valid-idempotency-key" },
      payload: {
        descriptorType: "git-markdown",
        displayName: "Docs",
        settings: {},
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "administration.conflict" });
    await app.close();
  });
});
