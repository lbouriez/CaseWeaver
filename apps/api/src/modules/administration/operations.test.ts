import { describe, expect, it, vi } from "vitest";

import { AuthSessionServiceError } from "../auth/session-service.js";
import { AdministrationApiOperations } from "./operations.js";

function operations(overrides: Record<string, unknown> = {}) {
  return new AdministrationApiOperations({
    auth: {},
    reads: {},
    resources: {},
    descriptors: {},
    unitOfWork: {},
    auditStore: {},
    authAudits: { record: vi.fn(async () => undefined) },
    auditWorkspaceId: "workspace-1",
    createDraft: vi.fn(),
    ...overrides,
  } as never);
}

describe("AdministrationApiOperations audit boundary", () => {
  it("audits an unauthenticated administrative request before returning its denial", async () => {
    const record = vi.fn(async () => undefined);
    const api = operations({
      auth: {
        resolve: async () => {
          throw new AuthSessionServiceError("auth.session.required");
        },
      },
      authAudits: { record },
    });

    await expect(
      api.resolve({ headers: {}, id: "request-1" }, { mutation: false }),
    ).rejects.toThrow("auth.session.required");
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          action: "auth.session.denied",
          outcome: "denied",
          workspaceId: "workspace-1",
          reasonCode: "session.required",
        }),
      }),
    );
  });

  it("delegates successful auth mutations to the atomic session/audit boundary without a duplicate recorder write", async () => {
    const record = vi.fn(async () => undefined);
    const callback = vi.fn(async () => ({
      redirectTo: "https://admin.example/",
      setCookie: "session=value",
      session: {
        authenticated: true as const,
        principal: { id: "principal-1", displayName: "Operator" },
        activeWorkspace: { id: "workspace-1", name: "Operations" },
        workspaces: [{ id: "workspace-1", name: "Operations" }],
        permissions: [],
        csrfToken: "not-an-audit-value",
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
    }));
    const logout = vi.fn(async () => ({ setCookie: "session=; Max-Age=0" }));
    const switchWorkspace = vi.fn(async () => ({
      setCookie: "session=replacement",
      session: {
        authenticated: true as const,
        principal: { id: "principal-1", displayName: "Operator" },
        activeWorkspace: { id: "workspace-2", name: "Research" },
        workspaces: [{ id: "workspace-2", name: "Research" }],
        permissions: [],
        csrfToken: "not-an-audit-value",
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
    }));
    const api = operations({
      auth: { callback, logout, switchWorkspace },
      authAudits: { record },
    });
    const request = {
      id: "request-1",
      ip: "192.0.2.1",
      headers: {
        cookie: "session=value",
        origin: "https://admin.example",
        "x-csrf-token": "csrf",
        "user-agent": "CaseWeaver Admin",
      },
      query: { code: "code", state: "state" },
    };

    await api.callback(request);
    await api.logout(request);
    await api.switchWorkspace(request, "workspace-2");

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          requestId: "request-1",
          clientAddress: "192.0.2.1",
        }),
      }),
    );
    expect(logout).toHaveBeenCalledWith(
      expect.objectContaining({ audit: expect.anything() }),
    );
    expect(switchWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-2",
        audit: expect.anything(),
      }),
    );
    expect(record).not.toHaveBeenCalled();
  });

  it("retains fail-closed audit recording for denied auth mutations", async () => {
    const record = vi.fn(async () => undefined);
    const api = operations({
      auth: {
        logout: async () => {
          throw new AuthSessionServiceError("auth.csrf.invalid");
        },
      },
      authAudits: { record },
    });

    await expect(api.logout({ headers: {} })).rejects.toThrow(
      "auth.csrf.invalid",
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          action: "auth.logout.denied",
          outcome: "denied",
          reasonCode: "csrf.invalid",
        }),
      }),
    );
  });

  it("writes a server-owned denied audit event when a session lacks a resource permission", async () => {
    const append = vi.fn(async () => undefined);
    const transaction = {};
    const api = operations({
      unitOfWork: {
        transaction: async (operation: (value: unknown) => unknown) =>
          operation(transaction),
      },
      auditStore: { append },
    });
    await expect(
      api.list(
        "connector-instances",
        { limit: 20 },
        {
          principalId: "principal-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          permissions: [],
          requestId: "request-1",
          correlationId: "correlation-1",
          requestMode: "user",
        },
      ),
    ).rejects.toThrow("authorization.denied");
    expect(append).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        action: "admin.connectorInstance.list",
        outcome: "denied",
        reasonCode: "authorization.denied",
      }),
    );
  });

  it("stores an idempotency digest in canonical SHA-256 form rather than a browser token", async () => {
    const append = vi.fn(async () => undefined);
    const api = operations({
      unitOfWork: {
        transaction: async (operation: (value: unknown) => unknown) =>
          operation({}),
      },
      auditStore: { append },
      resources: {
        list: vi.fn(async () => ({
          items: [],
          page: { hasNextPage: false },
        })),
      },
    });
    await api.list(
      "connector-instances",
      { limit: 20 },
      {
        principalId: "principal-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        permissions: ["configuration.read"],
        requestId: "request-1",
        correlationId: "correlation-1",
        idempotencyKey: "browser-idempotency-key",
        requestMode: "user",
      },
    );
    expect(append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotencyKeyDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
  });

  it("derives source and schedule lifecycle context from the session and forwards no projection settings", async () => {
    const sourceTransition = vi.fn(async () => ({
      revision: 2,
      lifecycle: "enabled",
    }));
    const scheduleTransition = vi.fn(async () => ({
      revision: 3,
      lifecycle: "disabled",
    }));
    const api = operations({
      transitionKnowledgeSource: sourceTransition,
      transitionKnowledgeSchedule: scheduleTransition,
    });
    const context = {
      principalId: "principal-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      permissions: ["configuration.manage"],
      requestId: "request-1",
      correlationId: "correlation-1",
      idempotencyKey: "browser-idempotency-key",
      requestMode: "user" as const,
    };

    await expect(
      api.transitionKnowledgeSource(
        { sourceId: "source-1", expectedRevision: 1, lifecycle: "active" },
        context,
      ),
    ).resolves.toMatchObject({
      id: "source-1",
      status: "enabled",
      version: "2",
    });
    await expect(
      api.transitionKnowledgeSchedule(
        {
          scheduleId: "schedule-1",
          expectedRevision: 2,
          lifecycle: "disabled",
        },
        context,
      ),
    ).resolves.toMatchObject({
      id: "schedule-1",
      status: "disabled",
      version: "3",
    });
    expect(sourceTransition).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedRevision: 1,
      lifecycle: "active",
      context,
    });
    expect(scheduleTransition).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scheduleId: "schedule-1",
      expectedRevision: 2,
      lifecycle: "disabled",
      context,
    });
    expect(JSON.stringify(sourceTransition.mock.calls)).not.toMatch(
      /connector|collection|settings|secret|token/iu,
    );
  });

  it("binds provider capability previews and executions to the server session and audit metadata", async () => {
    const preview = vi.fn(async () => ({ canConfirm: true }));
    const run = vi.fn(async () => ({ outcome: "succeeded" }));
    const api = operations({
      providerCapabilityTests: {
        preview: { execute: preview },
        run: { execute: run },
      },
    });
    const context = {
      principalId: "principal-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      permissions: ["configuration.manage"],
      requestId: "request-1",
      correlationId: "correlation-1",
      uiActionId: "ui-action-1",
      traceId: "0123456789abcdef0123456789abcdef",
      clientAddress: "192.0.2.10",
      userAgent: "CaseWeaver Admin",
      idempotencyKey: "browser-idempotency-key",
      requestMode: "user" as const,
    };
    await api.previewProviderCapabilityTest(
      { providerInstanceId: "provider-1", testOperation: "provider.test" },
      context,
    );
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        principalId: "principal-1",
        sessionId: "session-1",
        providerInstanceId: "provider-1",
        testOperation: "provider.test",
        auditMetadata: expect.objectContaining({
          requestId: "request-1",
          correlationId: "correlation-1",
          uiActionId: "ui-action-1",
          traceId: "0123456789abcdef0123456789abcdef",
        }),
      }),
    );
    await api.runProviderCapabilityTest(
      {
        providerInstanceId: "provider-1",
        testOperation: "provider.test",
        confirmationId: "confirmation-1",
      },
      context,
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotency: {
          keyDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        auditMetadata: expect.objectContaining({ clientAddress: "192.0.2.10" }),
      }),
    );
  });

  it("audits a privacy purge preview without persisting its deletion reason", async () => {
    const append = vi.fn(async () => undefined);
    const reason = "Verified data-subject deletion request";
    const api = operations({
      unitOfWork: {
        transaction: async (operation: (value: unknown) => unknown) =>
          operation({}),
      },
      auditStore: { append },
    });

    const result = await api.previewPrivacyPurge(
      { caseSnapshotId: "snapshot-1", reason },
      {
        principalId: "principal-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        permissions: ["privacy.delete"],
        requestId: "request-1",
        correlationId: "correlation-1",
        requestMode: "user",
      },
    );

    expect(JSON.stringify(result)).not.toContain(reason);
    expect(append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "admin.privacy.purge.preview",
        targetId: "snapshot-1",
        permission: "privacy.delete",
        outcome: "succeeded",
      }),
    );
    expect(JSON.stringify(append.mock.calls)).not.toContain(reason);
  });

  it("authorizes, audits, and workspace-scopes immutable configuration inspection", async () => {
    const append = vi.fn(async () => undefined);
    const configurationInspection = vi.fn(async () => ({
      id: "configuration-1",
      resourceType: "connector-instances",
      lifecycle: "active",
      revision: 2,
      updatedAt: "2026-07-15T12:00:00.000Z",
    }));
    const api = operations({
      unitOfWork: {
        transaction: async (operation: (value: unknown) => unknown) =>
          operation({}),
      },
      auditStore: { append },
      resources: { configurationInspection },
    });
    const context = {
      principalId: "principal-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      permissions: ["configuration.read"],
      requestId: "request-1",
      correlationId: "correlation-1",
      requestMode: "user" as const,
    };

    await expect(
      api.configurationInspection("configuration-1", context),
    ).resolves.toMatchObject({ id: "configuration-1" });
    expect(configurationInspection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      configurationId: "configuration-1",
    });
    expect(append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "admin.configuration.inspect",
        targetId: "configuration-1",
        permission: "configuration.read",
        outcome: "succeeded",
      }),
    );
  });

  it("audits a denied history read and prevents the store lookup", async () => {
    const append = vi.fn(async () => undefined);
    const configurationHistory = vi.fn();
    const api = operations({
      unitOfWork: {
        transaction: async (operation: (value: unknown) => unknown) =>
          operation({}),
      },
      auditStore: { append },
      resources: { configurationHistory },
    });

    await expect(
      api.configurationHistory(
        "configuration-1",
        { limit: 25 },
        {
          principalId: "principal-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          permissions: [],
          requestId: "request-1",
          correlationId: "correlation-1",
          requestMode: "user",
        },
      ),
    ).rejects.toThrow("authorization.denied");
    expect(configurationHistory).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "admin.configuration.history.read",
        targetId: "configuration-1",
        outcome: "denied",
        reasonCode: "authorization.denied",
      }),
    );
  });

  it("fails closed when configuration-history audit persistence fails", async () => {
    const configurationHistory = vi.fn();
    const api = operations({
      unitOfWork: {
        transaction: async (operation: (value: unknown) => unknown) =>
          operation({}),
      },
      auditStore: {
        append: vi.fn(async () => {
          throw new Error("audit.persistence.failed");
        }),
      },
      resources: { configurationHistory },
    });

    await expect(
      api.configurationHistory(
        "configuration-1",
        { limit: 25 },
        {
          principalId: "principal-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          permissions: ["configuration.read"],
          requestId: "request-1",
          correlationId: "correlation-1",
          requestMode: "user",
        },
      ),
    ).rejects.toThrow("audit.persistence.failed");
    expect(configurationHistory).not.toHaveBeenCalled();
  });

  it("accepts a diagnostic export through the atomic request/outbox/audit port", async () => {
    const requestAndEnqueueAndRecord = vi.fn(async (input) => ({
      request: input.request,
      replayed: false,
    }));
    const api = operations({
      diagnostics: {
        requests: { requestAndEnqueueAndRecord },
        artifacts: {},
      },
    });
    const result = await api.requestDiagnosticExport({
      principalId: "principal-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      permissions: ["diagnostics.export"],
      requestId: "request-1",
      correlationId: "correlation-1",
      idempotencyKey: "browser-idempotency-key",
      requestMode: "user",
    });

    expect(result).toMatchObject({ status: "requested" });
    expect(requestAndEnqueueAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          type: "diagnostics.export.generate.v1",
          payload: expect.objectContaining({ exportId: expect.any(String) }),
        }),
        audit: expect.objectContaining({
          action: "admin.diagnostics.export.requested",
          permission: "diagnostics.export",
          outcome: "succeeded",
        }),
      }),
    );
    expect(JSON.stringify(requestAndEnqueueAndRecord.mock.calls)).not.toMatch(
      /storage|locator|secret|token/iu,
    );
  });

  it("fails closed before returning a diagnostic stream when its sensitive-read audit cannot persist", async () => {
    const append = vi.fn(async () => {
      throw new Error("audit.persistence.failed");
    });
    const open = vi.fn(async () =>
      (async function* () {
        yield new Uint8Array([1]);
      })(),
    );
    const api = operations({
      unitOfWork: {
        transaction: async (operation: (value: unknown) => unknown) =>
          operation({}),
      },
      auditStore: { append },
      diagnostics: {
        requests: {
          find: vi.fn(async () => ({
            id: "diagnostic-export-1",
            status: "ready",
            artifactLocator: { storageKey: "server-private" },
          })),
        },
        artifacts: { open },
      },
    });

    await expect(
      api.downloadDiagnosticExport("diagnostic-export-1", {
        principalId: "principal-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        permissions: ["diagnostics.export"],
        requestId: "request-1",
        correlationId: "correlation-1",
        requestMode: "user",
      }),
    ).rejects.toThrow("audit.persistence.failed");
    expect(open).toHaveBeenCalledOnce();
  });

  it("advertises only composed configuration workflows and separately declares safe operational commands", async () => {
    const append = vi.fn(async () => undefined);
    const api = operations({
      unitOfWork: {
        transaction: async (operation: (value: unknown) => unknown) =>
          operation({}),
      },
      auditStore: { append },
    });
    const result = await api.configurationSurfaces({
      principalId: "principal-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      permissions: ["configuration.read"],
      requestId: "request-1",
      correlationId: "correlation-1",
      requestMode: "user",
    });
    const surfaces = result.items;
    const connector = surfaces.find(
      (surface) => surface.surface === "connector-instances",
    );
    const source = surfaces.find(
      (surface) => surface.surface === "knowledge-sources",
    );
    const publication = surfaces.find(
      (surface) => surface.surface === "publications",
    );
    const platform = surfaces.find((surface) => surface.surface === "platform");

    expect(connector).toMatchObject({
      mode: "managed",
      workflows: expect.arrayContaining(["create_draft", "inspect_history"]),
      operationalActions: [],
    });
    expect(source).toMatchObject({
      mode: "managed",
      workflows: ["create_draft", "activate", "disable", "inspect_history"],
      operationalActions: ["source.synchronize", "source.fullRescan"],
    });
    expect(publication).toMatchObject({
      mode: "read_only",
      workflows: [],
      operationalActions: ["publication.approve"],
    });
    expect(platform).toMatchObject({
      mode: "read_only",
      reasonCode: "deployment_owned",
      workflows: [],
      operationalActions: [],
    });
    expect(append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "admin.configuration.surface.list",
        permission: "configuration.read",
        outcome: "succeeded",
      }),
    );
  });
});
