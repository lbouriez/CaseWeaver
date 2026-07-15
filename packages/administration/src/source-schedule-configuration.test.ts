import { describe, expect, it, vi } from "vitest";

import type {
  ConfigurationLifecycleAudit,
  ConfigurationLifecycleStore,
} from "./configuration-lifecycle.js";
import type { SourceScheduleConfigurationProjectionStore } from "./source-schedule-configuration.js";
import {
  ManageKnowledgeScheduleConfiguration,
  ManageKnowledgeSourceConfiguration,
} from "./source-schedule-configuration.js";

const source = {
  sourceId: "source-a",
  connectorRegistrationId: "connector-a",
  knowledgeCollectionId: "collection-a",
  normalizationProfileVersion: "normalization-v1",
  chunkingProfileVersion: "chunking-v1",
  synchronizationPolicy: { triggers: [{ mode: "manual" }] },
  deletionBehavior: "tombstone" as const,
};

const schedule = {
  scheduleId: "schedule-a",
  sourceId: source.sourceId,
  sourceConfigurationVersionId: "source-version-2",
  kind: "synchronize" as const,
  cadence: {
    kind: "interval" as const,
    intervalMs: 60_000,
    jitterMs: 1_000,
    overlapPolicy: "skip" as const,
  },
  nextRunAt: "2026-07-15T12:00:00.000Z",
};

function lifecycleStore(): SourceScheduleConfigurationProjectionStore {
  const base: ConfigurationLifecycleStore = {
    createDraft: vi.fn(async (input) => ({
      configuration: {
        id: input.configurationId,
        workspaceId: input.workspaceId,
        resourceType: input.resourceType,
        revision: 1,
        lifecycle: "draft" as const,
        currentVersionId: `${input.configurationId}-version-1`,
      },
      version: {
        id: `${input.configurationId}-version-1`,
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
        currentVersionId: `${input.configurationId}-version-2`,
      },
      version: {
        id: `${input.configurationId}-version-2`,
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
    ...base,
    writeKnowledgeSource: vi.fn(async () => undefined),
    writeKnowledgeSchedule: vi.fn(async () => undefined),
  };
}

function audit(): ConfigurationLifecycleAudit {
  return { append: vi.fn(async () => undefined) };
}

const transactions = {
  transaction: async <T>(operation: () => Promise<T>): Promise<T> =>
    operation(),
};

describe("source and schedule administration configuration", () => {
  it("creates an inert source projection only with the first immutable draft and audit", async () => {
    const store = lifecycleStore();
    const recorder = audit();
    const result = await new ManageKnowledgeSourceConfiguration(
      transactions,
      store,
      recorder,
    ).create({
      workspaceId: "workspace-a",
      displayName: "Documentation",
      settings: { source },
      source,
      mutation: {
        operation: "knowledgeSource.create",
        keyDigest: "key-a",
        requestDigest: "request-a",
      },
    });

    expect(result).toMatchObject({
      idempotency: "created",
      version: { version: 1 },
    });
    expect(store.writeKnowledgeSource).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      configurationVersionId: "source-a-version-1",
      lifecycle: "disabled",
      source,
    });
    expect(recorder.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.knowledgeSource.draft.created",
        targetType: "knowledge-sources",
        targetId: "source-a",
        permission: "configuration.manage",
      }),
    );
  });

  it("projects an activated source and schedule to their new immutable versions", async () => {
    const store = lifecycleStore();
    const recorder = audit();
    const sourceManager = new ManageKnowledgeSourceConfiguration(
      transactions,
      store,
      recorder,
    );
    const scheduleManager = new ManageKnowledgeScheduleConfiguration(
      transactions,
      store,
      recorder,
    );
    await sourceManager.transition({
      workspaceId: "workspace-a",
      settings: { source, enabled: true },
      source,
      expectedRevision: 1,
      lifecycle: "active",
      mutation: {
        operation: "knowledgeSource.activate",
        keyDigest: "key-b",
        requestDigest: "request-b",
      },
    });
    await scheduleManager.transition({
      workspaceId: "workspace-a",
      settings: { schedule, enabled: true },
      schedule,
      expectedRevision: 1,
      lifecycle: "active",
      mutation: {
        operation: "knowledgeSchedule.activate",
        keyDigest: "key-c",
        requestDigest: "request-c",
      },
    });

    expect(store.writeKnowledgeSource).toHaveBeenCalledWith(
      expect.objectContaining({
        configurationVersionId: "source-a-version-2",
        lifecycle: "enabled",
      }),
    );
    expect(store.writeKnowledgeSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        configurationVersionId: "schedule-a-version-2",
        enabled: true,
        schedule,
      }),
    );
    expect(recorder.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.knowledgeSchedule.configuration.changed",
        targetId: "schedule-a",
      }),
    );
  });

  it("does not rewrite projections for a replayed immutable transition", async () => {
    const store = lifecycleStore();
    vi.mocked(store.findMutation).mockResolvedValue({
      requestDigest: "request-d",
      resourceId: "source-a-version-1",
    });
    vi.mocked(store.loadVersion).mockResolvedValue({
      id: "source-a-version-1",
      workspaceId: "workspace-a",
      configurationId: "source-a",
      version: 1,
      canonicalSettings: "{}",
      secretReferenceIds: [],
    });
    const result = await new ManageKnowledgeSourceConfiguration(
      transactions,
      store,
      audit(),
    ).create({
      workspaceId: "workspace-a",
      displayName: "Documentation",
      settings: { source },
      source,
      mutation: {
        operation: "knowledgeSource.create",
        keyDigest: "key-d",
        requestDigest: "request-d",
      },
    });

    expect(result.idempotency).toBe("replayed");
    expect(store.createDraft).not.toHaveBeenCalled();
    expect(store.writeKnowledgeSource).not.toHaveBeenCalled();
  });

  it("rejects malformed schedule cadence before any durable mutation", async () => {
    const store = lifecycleStore();
    await expect(
      new ManageKnowledgeScheduleConfiguration(
        transactions,
        store,
        audit(),
      ).create({
        workspaceId: "workspace-a",
        displayName: "Bad schedule",
        settings: { schedule },
        schedule: {
          ...schedule,
          cadence: {
            kind: "interval",
            intervalMs: 0,
            overlapPolicy: "skip",
          },
        },
        mutation: {
          operation: "knowledgeSchedule.create",
          keyDigest: "key-e",
          requestDigest: "request-e",
        },
      }),
    ).rejects.toThrow(/cadence/i);
    expect(store.createDraft).not.toHaveBeenCalled();
  });
});
