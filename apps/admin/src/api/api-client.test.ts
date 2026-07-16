import { describe, expect, it, vi } from "vitest";

import { CaseWeaverApiClient } from "./api-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CaseWeaverApiClient", () => {
  it("uses the browser fetch global through a receiver-safe wrapper", async () => {
    const browserFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        authenticated: false,
        authentication: { password: true, oauth: false },
      }),
    );
    vi.stubGlobal("fetch", browserFetch);
    try {
      const client = new CaseWeaverApiClient({
        apiBaseUrl: "https://api.example.test",
        uiTitle: "Control",
      });
      await expect(client.session()).resolves.toEqual({
        authenticated: false,
        authentication: { password: true, oauth: false },
      });
      expect(browserFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses cookie credentials, action correlation, and a fixed session endpoint", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        authenticated: true,
        principal: { id: "principal-1", displayName: "A. Operator" },
        activeWorkspace: { id: "workspace-1", name: "Operations" },
        workspaces: [{ id: "workspace-1", name: "Operations" }],
        permissions: ["configuration.read"],
        csrfToken: "a-valid-csrf-token",
        expiresAt: "2026-07-14T20:00:00.000Z",
      }),
    );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation, createActionId: () => "action-1" },
    );

    await client.session();

    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL("https://api.example.test/v1/auth/session"),
      expect.objectContaining({
        credentials: "include",
        headers: expect.any(Headers),
      }),
    );
    const init = fetchImplementation.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("X-CaseWeaver-UI-Action-ID")).toBe(
      "action-1",
    );
    expect(new Headers(init?.headers).get("X-CaseWeaver-Request-Mode")).toBe(
      "user",
    );
  });

  it("submits a password only to the dedicated session endpoint and retains no browser credential", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        authenticated: true,
        principal: {
          id: "local-password-administrator",
          displayName: "Local administrator",
        },
        activeWorkspace: { id: "workspace-1", name: "Operations" },
        workspaces: [{ id: "workspace-1", name: "Operations" }],
        permissions: ["configuration.read"],
        csrfToken: "a-valid-csrf-token",
        expiresAt: "2026-07-14T20:00:00.000Z",
      }),
    );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation, createActionId: () => "password-login-action" },
    );

    await expect(
      client.passwordLogin({ login: "admin", password: "admin" }),
    ).resolves.toMatchObject({ authenticated: true });

    expect(fetchImplementation.mock.calls[0]?.[0]).toEqual(
      new URL("https://api.example.test/v1/auth/login/password"),
    );
    const request = fetchImplementation.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("Idempotency-Key")).toBe(
      "password-login-action",
    );
    expect(localStorage.length).toBe(0);
  });

  it("sends the session CSRF token and idempotency header for workspace changes", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          principal: { id: "principal-1", displayName: "A. Operator" },
          activeWorkspace: { id: "workspace-1", name: "Operations" },
          workspaces: [{ id: "workspace-1", name: "Operations" }],
          permissions: ["configuration.read"],
          csrfToken: "a-valid-csrf-token",
          expiresAt: "2026-07-14T20:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          principal: { id: "principal-1", displayName: "A. Operator" },
          activeWorkspace: { id: "workspace-2", name: "Staging" },
          workspaces: [{ id: "workspace-2", name: "Staging" }],
          permissions: ["configuration.read"],
          csrfToken: "another-valid-csrf-token",
          expiresAt: "2026-07-14T20:00:00.000Z",
        }),
      );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation, createActionId: () => "action-2" },
    );

    await client.session();
    await client.switchWorkspace("workspace-2");

    const init = fetchImplementation.mock.calls[1]?.[1];
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe(
      "a-valid-csrf-token",
    );
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("action-2");
  });

  it("does not declare an empty logout POST as JSON", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: false,
          authentication: { password: true, oauth: false },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation, createActionId: () => "action-logout-1" },
    );

    await client.session();
    await client.logout();

    const init = fetchImplementation.mock.calls[1]?.[1];
    expect(new Headers(init?.headers).get("Content-Type")).toBeNull();
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
      "action-logout-1",
    );
  });

  it("only exposes resource-specific request methods and marks polling explicitly", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      jsonResponse({ items: [], page: { hasNextPage: false } }),
    );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test/control", uiTitle: "Control" },
      { fetchImplementation },
    );

    await client.list("dead-letters", {}, { mode: "passive_poll" });

    expect(Object.hasOwn(client, "requestJson")).toBe(false);
    expect(Object.hasOwn(client, "request")).toBe(false);
    expect(fetchImplementation.mock.calls[0]?.[0]).toEqual(
      new URL(
        "https://api.example.test/control/v1/admin/operations/dead-letters",
      ),
    );
    const init = fetchImplementation.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("X-CaseWeaver-Request-Mode")).toBe(
      "passive_poll",
    );
  });

  it("maps missing planned endpoints to a visible unavailable failure", async () => {
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      {
        fetchImplementation: async () =>
          jsonResponse({ code: "route.missing" }, 404),
      },
    );

    await expect(client.list("connector-instances")).rejects.toMatchObject({
      kind: "unavailable",
      code: "route.missing",
    });
  });

  it("accepts the backend JSON Schema additionalProperties safety flag for dynamic descriptors", async () => {
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      {
        fetchImplementation: async () =>
          jsonResponse({
            items: [
              {
                kind: "connector",
                type: "fixture-source",
                version: "1",
                displayName: "Fixture source",
                description: "Backend-only descriptor.",
                connectorCapabilities: ["knowledgeSource"],
                aiCapabilities: [],
                supportedWireApis: [],
                supportedWebhookEventTypes: [],
                settingsSchema: {
                  type: "object",
                  properties: {
                    endpoint: { type: "string", title: "Endpoint" },
                  },
                  required: ["endpoint"],
                  additionalProperties: false,
                },
                uiGroups: [
                  {
                    id: "connection",
                    title: "Connection",
                    fields: ["endpoint"],
                    advanced: false,
                  },
                ],
                secretSlots: [],
                supportsConfigurationMigration: false,
                supportedTestOperations: [],
              },
            ],
          }),
      },
    );

    await expect(client.listDescriptors("connector")).resolves.toEqual([
      expect.objectContaining({
        type: "fixture-source",
        settingsSchema: expect.objectContaining({
          additionalProperties: false,
        }),
      }),
    ]);
  });

  it("submits resource-specific source and source-version-pinned schedule drafts without client secrets", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "source-1",
          label: "Support knowledge",
          status: "draft",
          version: "1",
          fields: {},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "schedule-1",
          label: "Hourly sync",
          status: "draft",
          version: "1",
          fields: {},
        }),
      );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation },
    );

    await client.createKnowledgeSourceDraft({
      displayName: "Support knowledge",
      connectorInstanceId: "connector-1",
      collectionId: "collection-1",
      normalizationProfileId: "text-normalization",
      normalizationProfileVersion: "normalization-v1",
      chunkingProfileId: "text-chunking",
      chunkingProfileVersion: "chunking-v1",
      embeddingBatchSize: 16,
      embeddingBudgetPolicyId: "budget-1",
      synchronizationPolicy: { trigger: "manual" },
      deletionBehavior: "tombstone",
    });
    await client.createKnowledgeScheduleDraft({
      displayName: "Hourly sync",
      sourceId: "source-1",
      sourceConfigurationVersionId: "source-version-1",
      kind: "synchronize",
      cadence: {
        kind: "interval",
        intervalMs: 3_600_000,
        overlapPolicy: "skip",
      },
      nextRunAt: "2026-07-15T13:00:00.000Z",
    });

    expect(fetchImplementation.mock.calls[0]?.[0]).toEqual(
      new URL("https://api.example.test/v1/admin/knowledge-sources/drafts"),
    );
    expect(fetchImplementation.mock.calls[1]?.[0]).toEqual(
      new URL("https://api.example.test/v1/admin/schedules/drafts"),
    );
    expect(JSON.stringify(fetchImplementation.mock.calls)).not.toMatch(
      /secret|token|password|locator/iu,
    );
  });

  it("uses exact provider-neutral policy-profile draft endpoints", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "retrieval-profile-1",
          label: "Support evidence",
          status: "draft",
          version: "1",
          fields: {},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "prompt-profile-1",
          label: "Triage prompt",
          status: "draft",
          version: "1",
          fields: {},
        }),
      );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation },
    );

    await client.createPolicyProfileDraft("retrieval-profiles", {
      displayName: "Support evidence",
      settings: { maximumEvidence: 12 },
    });
    await client.createPolicyProfileDraft("prompt-profiles", {
      displayName: "Triage prompt",
      settings: { sections: ["summary", "evidence"] },
    });

    expect(fetchImplementation.mock.calls.map((call) => call[0])).toEqual([
      new URL("https://api.example.test/v1/admin/retrieval-profiles/drafts"),
      new URL("https://api.example.test/v1/admin/prompt-profiles/drafts"),
    ]);
    expect(
      JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)),
    ).toEqual({
      displayName: "Support evidence",
      settings: { maximumEvidence: 12 },
    });
    expect(JSON.stringify(fetchImplementation.mock.calls)).not.toMatch(
      /secret|token|password|locator/iu,
    );
  });

  it("fails closed instead of deriving a policy draft route from an invalid resource", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation },
    );

    await expect(
      client.createPolicyProfileDraft("unknown-profile" as never, {
        displayName: "Invalid",
        settings: {},
      }),
    ).rejects.toMatchObject({
      kind: "invalid",
      code: "client.invalidPolicyProfileResource",
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("transitions source and schedule lifecycles without submitting their connector, collection, or settings", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "source-1",
          label: "Support knowledge",
          status: "enabled",
          version: "2",
          fields: {},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "schedule-1",
          label: "Hourly synchronization",
          status: "disabled",
          version: "2",
          fields: {},
        }),
      );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation },
    );

    await client.transitionKnowledgeSource("source-1", {
      expectedRevision: 1,
      lifecycle: "active",
    });
    await client.transitionKnowledgeSchedule("schedule-1", {
      expectedRevision: 1,
      lifecycle: "disabled",
    });

    expect(fetchImplementation.mock.calls[0]?.[0]).toEqual(
      new URL(
        "https://api.example.test/v1/admin/knowledge-sources/source-1/lifecycle",
      ),
    );
    expect(fetchImplementation.mock.calls[1]?.[0]).toEqual(
      new URL(
        "https://api.example.test/v1/admin/schedules/schedule-1/lifecycle",
      ),
    );
    expect(JSON.stringify(fetchImplementation.mock.calls)).not.toMatch(
      /connector|collection|settings|secret|token|password|locator/iu,
    );
  });

  it("reads a role revision and replaces only a code-owned role set", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          principalId: "principal-1",
          roles: ["operator"],
          revision: 4,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "principal-1",
          label: "Roles for principal-1",
          status: "updated",
          version: "5",
          fields: { roles: "analyst, operator" },
        }),
      );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation },
    );

    await expect(
      client.workspaceRoleAssignment("principal-1"),
    ).resolves.toEqual({
      principalId: "principal-1",
      roles: ["operator"],
      revision: 4,
    });
    await client.replaceWorkspaceRoles("principal-1", {
      roles: ["operator", "analyst"],
      expectedRevision: 4,
    });
    expect(fetchImplementation.mock.calls[0]?.[0]).toEqual(
      new URL(
        "https://api.example.test/v1/admin/role-assignments/principal-1/assignment",
      ),
    );
    expect(fetchImplementation.mock.calls[1]?.[0]).toEqual(
      new URL("https://api.example.test/v1/admin/role-assignments/principal-1"),
    );
    expect(JSON.stringify(fetchImplementation.mock.calls)).not.toMatch(
      /secret|token|workspaceId|actor/iu,
    );
  });

  it("reads immutable configuration metadata without accepting configuration settings or secret references", async () => {
    const hash = "a".repeat(64);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "configuration-1",
          resourceType: "connector-instances",
          lifecycle: "active",
          revision: 2,
          updatedAt: "2026-07-15T12:00:00.000Z",
          currentVersionId: "version-2",
          currentVersion: {
            id: "version-2",
            version: 2,
            createdAt: "2026-07-15T12:00:00.000Z",
            canonicalSettingsSha256: hash,
            secretReferenceCount: 1,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: "version-2",
              version: 2,
              createdAt: "2026-07-15T12:00:00.000Z",
              canonicalSettingsSha256: hash,
              secretReferenceCount: 1,
            },
          ],
          page: { hasNextPage: false },
        }),
      );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation },
    );

    const inspection = await client.configurationInspection("configuration-1");
    const history = await client.configurationHistory("configuration-1", {
      limit: 25,
    });

    expect(JSON.stringify({ inspection, history })).not.toMatch(
      /"settings"|secretReferenceIds|vault|token/u,
    );
    expect(fetchImplementation.mock.calls[0]?.[0]).toEqual(
      new URL(
        "https://api.example.test/v1/admin/configurations/configuration-1",
      ),
    );
    expect(fetchImplementation.mock.calls[1]?.[0]).toEqual(
      new URL(
        "https://api.example.test/v1/admin/configurations/configuration-1/versions?limit=25",
      ),
    );
  });

  it("rejects unexpected settings, secret references, and artifact locators in inspection/history responses", async () => {
    const hash = "a".repeat(64);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "configuration-1",
          resourceType: "connector-instances",
          lifecycle: "active",
          revision: 1,
          updatedAt: "2026-07-15T12:00:00.000Z",
          settings: { token: "must-not-reach-browser" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: "version-1",
              version: 1,
              createdAt: "2026-07-15T12:00:00.000Z",
              canonicalSettingsSha256: hash,
              secretReferenceCount: 1,
              secretReferenceIds: ["credential-1"],
              signedDownloadUrl: "https://storage.example/private",
            },
          ],
          page: { hasNextPage: false },
        }),
      );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation },
    );

    await expect(
      client.configurationInspection("configuration-1"),
    ).rejects.toMatchObject({ code: "response.invalid" });
    await expect(
      client.configurationHistory("configuration-1"),
    ).rejects.toMatchObject({ code: "response.invalid" });
  });

  it("rejects malformed configuration-surface modes before the UI can enable a form", async () => {
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      {
        fetchImplementation: async () =>
          jsonResponse({
            items: [
              {
                surface: "connector-instances",
                mode: "manage_everything",
                workflows: ["create_draft", "activate"],
                operationalActions: [],
              },
            ],
          }),
      },
    );

    await expect(client.configurationSurfaces()).rejects.toMatchObject({
      code: "response.invalid",
    });
  });

  it("uses typed publication, webhook, and public-link endpoints without sending secret values or locators", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "publication-1",
          label: "Release note",
          status: "draft",
          version: "1",
          fields: {},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "webhook-1",
          label: "Case events",
          status: "draft",
          version: "1",
          fields: {},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workspaceId: "workspace-1",
          configurationId: "platform-links:workspace-1",
          configurationVersionId: "platform-version-2",
          revision: 2,
          lifecycle: "active",
          settings: {
            apiPublicBaseUrl: "https://api.example.test/v1",
            webhookPublicBaseUrl: "https://hooks.example.test/ingress",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "platform-links",
          label: "Public links",
          status: "active",
          version: "3",
          fields: {},
        }),
      );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation },
    );

    await client.createPublicationProfileDraft({
      displayName: "Release note",
      definition: { analysisDestination: "destination-1" },
    });
    await client.createWebhookEndpointDraft({
      displayName: "Case events",
      connectorInstanceId: "connector-1",
      verifiedEventTypes: ["caseChanged"],
      maximumBodyBytes: 131_072,
      maximumRequestsPerMinute: 120,
      settings: { filter: "case-updated" },
      secretReferenceRegistrationIds: ["registration-1"],
    });
    await expect(client.platformLinks()).resolves.toMatchObject({
      revision: 2,
      settings: { apiPublicBaseUrl: "https://api.example.test/v1" },
    });
    await client.savePlatformLinks({
      apiPublicBaseUrl: "https://api.example.test/v1",
      webhookPublicBaseUrl: "https://hooks.example.test/ingress",
      expectedRevision: 2,
    });

    expect(fetchImplementation.mock.calls.map((call) => call[0])).toEqual([
      new URL("https://api.example.test/v1/admin/publication-profiles/drafts"),
      new URL("https://api.example.test/v1/admin/webhook-endpoints/drafts"),
      new URL("https://api.example.test/v1/admin/platform/links"),
      new URL("https://api.example.test/v1/admin/platform/links"),
    ]);
    const webhookBody = String(fetchImplementation.mock.calls[1]?.[1]?.body);
    expect(JSON.parse(webhookBody)).toMatchObject({
      connectorInstanceId: "connector-1",
      secretReferenceRegistrationIds: ["registration-1"],
    });
    expect(webhookBody).not.toMatch(
      /vault:|secret[-_ ]?value|password|token/iu,
    );
    expect(String(fetchImplementation.mock.calls[3]?.[1]?.body)).toContain(
      '"expectedRevision":2',
    );
  });
});
