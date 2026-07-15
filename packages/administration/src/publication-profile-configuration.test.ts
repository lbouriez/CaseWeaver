import { describe, expect, it, vi } from "vitest";

import type {
  ConfigurationLifecycleAudit,
  ConfigurationLifecycleStore,
} from "./configuration-lifecycle.js";
import type { PublicationProfileConfigurationProjectionStore } from "./publication-profile-configuration.js";
import {
  ManagePublicationProfileConfiguration,
  PreviewPublicationProfileConfiguration,
} from "./publication-profile-configuration.js";

const profile = { profileId: "publication-profile-a" };
const definition = {
  destination: { connectorInstanceId: "destination-a" },
  renderer: { id: "structured", version: "1", format: "markdown" },
  notices: { disclaimers: [] },
  policy: { mode: "approvalRequired", visibility: "internal" },
  limits: { maximumBodyCharacters: 10_000 },
};

function store(): PublicationProfileConfigurationProjectionStore {
  const lifecycle: ConfigurationLifecycleStore = {
    createDraft: vi.fn(async (input) => ({
      configuration: {
        id: input.configurationId,
        workspaceId: input.workspaceId,
        resourceType: input.resourceType,
        revision: 1,
        lifecycle: "draft" as const,
        currentVersionId: "administration-version-1",
      },
      version: {
        id: "administration-version-1",
        workspaceId: input.workspaceId,
        configurationId: input.configurationId,
        version: 1,
        canonicalSettings: input.canonicalSettings,
        secretReferenceIds: [],
      },
    })),
    findMutation: vi.fn(async () => undefined),
    loadVersion: vi.fn(async () => undefined),
    transition: vi.fn(async (input) => ({
      configuration: {
        id: input.configurationId,
        workspaceId: input.workspaceId,
        resourceType: input.resourceType,
        revision: input.expectedRevision + 1,
        lifecycle: input.lifecycle ?? "active",
        currentVersionId: "administration-version-2",
      },
      version: {
        id: "administration-version-2",
        workspaceId: input.workspaceId,
        configurationId: input.configurationId,
        version: input.expectedRevision + 1,
        canonicalSettings: input.canonicalSettings,
        secretReferenceIds: [],
      },
    })),
    recordMutation: vi.fn(async () => undefined),
  };
  return {
    ...lifecycle,
    writePublicationProfile: vi.fn(async () => undefined),
  };
}

function audit(): ConfigurationLifecycleAudit {
  return { append: vi.fn(async () => undefined) };
}

const transactions = {
  transaction: async <T>(operation: () => Promise<T>): Promise<T> =>
    operation(),
};

describe("publication profile administration configuration", () => {
  it("creates an inert draft with a server-owned first profile version", async () => {
    const persistence = store();
    const recorder = audit();

    await new ManagePublicationProfileConfiguration(
      transactions,
      persistence,
      recorder,
    ).create({
      workspaceId: "workspace-a",
      displayName: "Internal publication",
      definition,
      profile,
      mutation: {
        operation: "publicationProfile.create",
        keyDigest: "key-a",
        requestDigest: "request-a",
      },
    });

    expect(persistence.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        configurationId: profile.profileId,
        resourceType: "publication-profiles",
        canonicalSettings: expect.stringContaining('"version":"1"'),
      }),
    );
    expect(persistence.writePublicationProfile).not.toHaveBeenCalled();
    expect(recorder.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.publicationProfile.draft.created",
        targetType: "publication-profiles",
        targetId: profile.profileId,
      }),
    );
  });

  it("projects an activated immutable profile exactly once and derives its version", async () => {
    const persistence = store();
    await new ManagePublicationProfileConfiguration(
      transactions,
      persistence,
      audit(),
    ).transition({
      workspaceId: "workspace-a",
      definition,
      profile,
      expectedRevision: 1,
      lifecycle: "active",
      mutation: {
        operation: "publicationProfile.activate",
        keyDigest: "key-b",
        requestDigest: "request-b",
      },
    });

    expect(persistence.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalSettings: expect.stringContaining('"version":"2"'),
      }),
    );
    expect(persistence.writePublicationProfile).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      configurationVersionId: "administration-version-2",
      lifecycle: "active",
      profile,
    });
  });

  it("does not re-project an idempotent activation replay", async () => {
    const persistence = store();
    vi.mocked(persistence.findMutation).mockResolvedValue({
      requestDigest: "request-c",
      resourceId: "administration-version-2",
    });
    vi.mocked(persistence.loadVersion).mockResolvedValue({
      id: "administration-version-2",
      workspaceId: "workspace-a",
      configurationId: profile.profileId,
      version: 2,
      canonicalSettings: "{}",
      secretReferenceIds: [],
    });

    const result = await new ManagePublicationProfileConfiguration(
      transactions,
      persistence,
      audit(),
    ).transition({
      workspaceId: "workspace-a",
      definition,
      profile,
      expectedRevision: 1,
      lifecycle: "active",
      mutation: {
        operation: "publicationProfile.activate",
        keyDigest: "key-c",
        requestDigest: "request-c",
      },
    });

    expect(result.idempotency).toBe("replayed");
    expect(persistence.writePublicationProfile).not.toHaveBeenCalled();
  });

  it("rejects browser-selected immutable profile identifiers and versions", async () => {
    const persistence = store();
    await expect(
      new ManagePublicationProfileConfiguration(
        transactions,
        persistence,
        audit(),
      ).create({
        workspaceId: "workspace-a",
        displayName: "Internal publication",
        definition: { ...definition, id: "other-profile" },
        profile,
        mutation: {
          operation: "publicationProfile.create",
          keyDigest: "key-d",
          requestDigest: "request-d",
        },
      }),
    ).rejects.toThrow(/managed by the server/u);
    expect(persistence.createDraft).not.toHaveBeenCalled();
  });

  it("delegates a bounded sensitive preview using only server-owned profile selection context", async () => {
    const previews = {
      renderAndAudit: vi.fn(async () => ({
        profileVersion: "2",
        format: "markdown" as const,
        body: "Preview only",
      })),
    };
    const result = await new PreviewPublicationProfileConfiguration(
      previews,
    ).execute(
      {
        profileId: "publication-profile-a",
        analysisResultId: "analysis-result-a",
      },
      {
        workspaceId: "workspace-a",
        actorPrincipalId: "principal-a",
        requestId: "request-a",
        correlationId: "correlation-a",
      },
    );
    expect(result).toEqual({
      profileVersion: "2",
      format: "markdown",
      body: "Preview only",
    });
    expect(previews.renderAndAudit).toHaveBeenCalledWith({
      command: {
        profileId: "publication-profile-a",
        analysisResultId: "analysis-result-a",
      },
      context: expect.objectContaining({ workspaceId: "workspace-a" }),
    });
  });

  it("rejects an oversized preview returned by a misconfigured outer adapter", async () => {
    await expect(
      new PreviewPublicationProfileConfiguration({
        renderAndAudit: async () => ({
          profileVersion: "2",
          format: "markdown",
          body: "x".repeat(1_000_001),
        }),
      }).execute(
        {
          profileId: "publication-profile-a",
          analysisResultId: "analysis-result-a",
        },
        {
          workspaceId: "workspace-a",
          actorPrincipalId: "principal-a",
          requestId: "request-a",
          correlationId: "correlation-a",
        },
      ),
    ).rejects.toThrow(/response is invalid/u);
  });
});
