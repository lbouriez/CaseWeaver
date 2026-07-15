import { describe, expect, it, vi } from "vitest";

import {
  TransitionConfigurationVersion,
  type ConfigurationLifecycleStore,
} from "./configuration-lifecycle.js";
import { IdempotencyConflictError } from "./errors.js";

const command = {
  workspaceId: "workspace-a",
  configurationId: "connector-a",
  resourceType: "connector-instance",
  expectedRevision: 1,
  settings: { b: 2, a: 1 },
  secretReferenceIds: ["secret-b", "secret-a", "secret-a"],
  mutation: {
    operation: "connector.activate",
    keyDigest: "key",
    requestDigest: "request",
  },
};

function store(
  overrides: Partial<ConfigurationLifecycleStore> = {},
): ConfigurationLifecycleStore {
  return {
    createDraft: vi.fn(async () => ({
      configuration: {
        id: "connector-a",
        workspaceId: "workspace-a",
        resourceType: "connector-instance",
        revision: 1,
        lifecycle: "draft" as const,
      },
      version: {
        id: "version-1",
        workspaceId: "workspace-a",
        configurationId: "connector-a",
        version: 1,
        canonicalSettings: "{}",
        secretReferenceIds: [],
      },
    })),
    findMutation: vi.fn(async () => undefined),
    loadVersion: vi.fn(async () => undefined),
    transition: vi.fn(async () => ({
      configuration: {
        id: "connector-a",
        workspaceId: "workspace-a",
        resourceType: "connector-instance",
        revision: 2,
        lifecycle: "active" as const,
        currentVersionId: "version-2",
      },
      version: {
        id: "version-2",
        workspaceId: "workspace-a",
        configurationId: "connector-a",
        version: 2,
        canonicalSettings: '{"a":1,"b":2}',
        secretReferenceIds: ["secret-a", "secret-b"],
      },
    })),
    recordMutation: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("TransitionConfigurationVersion", () => {
  it("canonicalizes, de-duplicates secret reference identities, and audits in its transaction", async () => {
    const persistence = store();
    const transaction = vi.fn(async <T>(callback: () => Promise<T>) =>
      callback(),
    );
    const audit = { append: vi.fn(async () => undefined) };
    const service = new TransitionConfigurationVersion(
      { transaction },
      persistence,
      audit,
    );

    const result = await service.execute(command);

    expect(result.idempotency).toBe("created");
    expect(persistence.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalSettings: '{"a":1,"b":2}',
        secretReferenceIds: ["secret-a", "secret-b"],
      }),
    );
    expect(persistence.recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        result: { requestDigest: "request", resourceId: "version-2" },
      }),
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.configuration.transition",
        targetId: "connector-a",
        afterHash: expect.any(String),
      }),
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("replays an identical idempotency request without writing a second version or audit", async () => {
    const version = {
      id: "version-1",
      workspaceId: "workspace-a",
      configurationId: "connector-a",
      version: 1,
      canonicalSettings: "{}",
      secretReferenceIds: [],
    };
    const persistence = store({
      findMutation: vi.fn(async () => ({
        requestDigest: "request",
        resourceId: "version-1",
      })),
      loadVersion: vi.fn(async () => version),
    });
    const audit = { append: vi.fn(async () => undefined) };
    const service = new TransitionConfigurationVersion(
      { transaction: async (callback) => callback() },
      persistence,
      audit,
    );

    expect((await service.execute(command)).idempotency).toBe("replayed");
    expect(persistence.transition).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key for a different request", async () => {
    const persistence = store({
      findMutation: vi.fn(async () => ({
        requestDigest: "other",
        resourceId: "version-1",
      })),
    });
    const service = new TransitionConfigurationVersion(
      { transaction: async (callback) => callback() },
      persistence,
      { append: async () => undefined },
    );
    await expect(service.execute(command)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(persistence.transition).not.toHaveBeenCalled();
  });
});
