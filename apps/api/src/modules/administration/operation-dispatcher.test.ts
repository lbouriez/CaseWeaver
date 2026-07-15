import type {
  AdministrationActionPreviewStore,
  AdministrationOperationPreflightPort,
  StoredAdministrationActionPreview,
} from "@caseweaver/administration";
import {
  AdministrationDeniedError,
  AdministrationUnavailableError,
} from "@caseweaver/administration";
import { describe, expect, it, vi } from "vitest";

import {
  AdministrationOperationDispatcher,
  type DescriptorConfigurationLifecycle,
  digestIdempotencyKey,
  mapPrivacyPurge,
  mapRoutedOperation,
  type OperationsUseCases,
  type SessionBoundAdminRequestContext,
} from "./operation-dispatcher.js";

const context: SessionBoundAdminRequestContext = {
  principalId: "principal-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  permissions: [
    "operations.retry",
    "analysis.cancel",
    "operations.recover",
    "retention.run",
    "publication.approve",
    "connector.manage",
  ],
  requestId: "request-1",
  correlationId: "correlation-1",
  requestMode: "user",
};

function createDispatcher(
  options: {
    readonly canConfirm?: boolean;
    readonly configurationLifecycle?: DescriptorConfigurationLifecycle;
    readonly requestKnowledgeSourceSynchronization?: OperationsUseCases["requestKnowledgeSourceSynchronization"];
  } = {},
) {
  let stored: StoredAdministrationActionPreview | undefined;
  const previews: AdministrationActionPreviewStore = {
    create: vi.fn(async (preview) => {
      stored = preview;
    }),
    consume: vi.fn(async (input) =>
      stored?.id === input.previewId &&
      stored.workspaceId === input.workspaceId &&
      stored.principalId === input.principalId &&
      stored.sessionId === input.sessionId
        ? stored
        : undefined,
    ),
  };
  const preflight: AdministrationOperationPreflightPort = {
    preview: vi.fn(async () => ({
      confirmation: "Retry failed analysis job",
      impact:
        "A replacement job will be queued if the dead letter is eligible.",
      canConfirm: options.canConfirm ?? true,
    })),
  };
  const useCases: OperationsUseCases = {
    retryDeadLetter: {
      execute: vi.fn(async () => ({
        analysisJobId: "replacement-job-1",
        replayed: false,
      })),
    } as never,
    cancelJob: {
      execute: vi.fn(async () => ({ cancelled: true, replayed: false })),
    } as never,
    recoverJob: {
      execute: vi.fn(async () => ({ recovered: true, replayed: false })),
    } as never,
    queueRetention: {
      execute: vi.fn(async () => ({ queued: 2, replayed: false })),
    } as never,
    approvePublication: {
      execute: vi.fn(async () => ({ approved: true, replayed: false })),
    } as never,
    purgeCaseSnapshot: {
      execute: vi.fn(async () => ({ purged: true, replayed: false })),
    } as never,
    ...(options.requestKnowledgeSourceSynchronization === undefined
      ? {}
      : {
          requestKnowledgeSourceSynchronization:
            options.requestKnowledgeSourceSynchronization,
        }),
  };
  return {
    previews,
    preflight,
    useCases,
    dispatcher: new AdministrationOperationDispatcher({
      previews,
      preflight,
      useCases,
      ...(options.configurationLifecycle === undefined
        ? {}
        : { configurationLifecycle: options.configurationLifecycle }),
      createPreviewId: () => "preview-1",
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    }),
  };
}

describe("administration operation dispatcher", () => {
  it("maps only current use-case-backed routes and explicitly rejects incomplete workflows", () => {
    expect(
      mapRoutedOperation({
        action: "dead-letter.retry",
        resource: "dead-letters",
        id: "job-1",
      }),
    ).toMatchObject({
      kind: "supported",
      command: { action: "deadLetter.retry", target: { id: "job-1" } },
    });
    expect(
      mapRoutedOperation({
        action: "privacy.purge",
        resource: "platform",
      }),
    ).toEqual({ kind: "unavailable" });
    expect(
      mapRoutedOperation({
        action: "source.fullRescan",
        resource: "knowledge-sources",
        id: "source-1",
      }),
    ).toMatchObject({
      kind: "supported",
      command: {
        action: "knowledgeSource.fullRescan",
        target: { resource: "knowledgeSource", id: "source-1" },
        parameters: { kind: "fullRescan" },
      },
    });
    expect(
      mapRoutedOperation({
        action: "publication.approve",
        resource: "publications",
        id: "publication-1",
      }),
    ).toMatchObject({
      kind: "supported",
      command: {
        action: "publication.approve",
        target: { resource: "publication", id: "publication-1" },
      },
    });
    expect(
      mapRoutedOperation({
        action: "connector.activate",
        resource: "connector-instances",
        id: "connector-1",
      }),
    ).toMatchObject({
      kind: "supported",
      command: {
        action: "configuration.activate",
        target: { resource: "configuration", id: "connector-1" },
        parameters: { resourceType: "connector-instances" },
      },
    });
    expect(
      mapRoutedOperation({
        action: "connector.test",
        resource: "connector-instances",
        id: "connector-1",
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("transitions a descriptor-backed configuration through the immutable lifecycle port", async () => {
    const configurationLifecycle: DescriptorConfigurationLifecycle = {
      execute: vi.fn(async () => ({ changed: true, lifecycle: "active" })),
    };
    const built = createDispatcher({ configurationLifecycle });
    const mapping = mapRoutedOperation({
      action: "connector.activate",
      resource: "connector-instances",
      id: "connector-1",
    });
    if (mapping.kind !== "supported")
      throw new Error("Expected supported mapping.");
    const preview = await built.dispatcher.preview(mapping.command, {
      ...context,
      permissions: ["configuration.manage"],
    });

    await expect(
      built.dispatcher.execute(
        preview.id,
        digestIdempotencyKey("idempotency-key-123456"),
        { ...context, permissions: ["configuration.manage"] },
      ),
    ).resolves.toMatchObject({
      operationId: "connector-1",
      outcome: "completed",
    });
    expect(configurationLifecycle.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "configuration.activate",
        configurationId: "connector-1",
        resourceType: "connector-instances",
      }),
    );
  });

  it("stores a session-bound, preflight-authoritative preview before real dispatch", async () => {
    const built = createDispatcher();
    const mapping = mapRoutedOperation({
      action: "dead-letter.retry",
      resource: "dead-letters",
      id: "job-1",
    });
    if (mapping.kind !== "supported")
      throw new Error("Expected supported mapping.");

    const preview = await built.dispatcher.preview(mapping.command, context);

    expect(preview).toMatchObject({
      id: "preview-1",
      canConfirm: true,
      expiresAt: "2026-07-15T12:05:00.000Z",
    });
    expect(built.previews.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        workspaceId: "workspace-1",
        principalId: "principal-1",
        command: mapping.command,
      }),
    );

    const result = await built.dispatcher.execute(
      preview.id,
      digestIdempotencyKey("idempotency-key-123456"),
      context,
    );
    expect(result).toEqual({
      operationId: "replacement-job-1",
      outcome: "accepted",
      message: "A replacement analysis job was queued.",
    });
    expect(built.useCases.retryDeadLetter.execute).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
      expect.objectContaining({
        workspaceId: "workspace-1",
        principalId: "principal-1",
      }),
    );
  });

  it("composes publication approval through its existing feature use case", async () => {
    const built = createDispatcher();
    const mapping = mapRoutedOperation({
      action: "publication.approve",
      resource: "publications",
      id: "publication-1",
    });
    if (mapping.kind !== "supported")
      throw new Error("Expected supported mapping.");

    const preview = await built.dispatcher.preview(mapping.command, context);
    await expect(
      built.dispatcher.execute(
        preview.id,
        digestIdempotencyKey("idempotency-key-123456"),
        context,
      ),
    ).resolves.toMatchObject({
      operationId: "publication-1",
      outcome: "accepted",
    });
    expect(built.useCases.approvePublication.execute).toHaveBeenCalledWith(
      "publication-1",
      expect.objectContaining({ workspaceId: "workspace-1" }),
    );
  });

  it("queues a source command through the existing application use case", async () => {
    const requestKnowledgeSourceSynchronization = {
      execute: vi.fn(async () => ({
        status: "queued" as const,
        outboxEnvelopeId: "outbox-source-1",
        configurationVersion: "source-configuration-v3",
        replayed: false,
      })),
    } as never;
    const built = createDispatcher({ requestKnowledgeSourceSynchronization });
    const mapping = mapRoutedOperation({
      action: "source.fullRescan",
      resource: "knowledge-sources",
      id: "source-1",
    });
    if (mapping.kind !== "supported")
      throw new Error("Expected supported mapping.");

    const preview = await built.dispatcher.preview(mapping.command, context);
    await expect(
      built.dispatcher.execute(
        preview.id,
        digestIdempotencyKey("idempotency-key-123456"),
        context,
      ),
    ).resolves.toEqual({
      operationId: "outbox-source-1",
      outcome: "accepted",
      message:
        "The source synchronization was queued with its immutable configuration version.",
    });
    expect(requestKnowledgeSourceSynchronization.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "source-1",
        kind: "fullRescan",
        idempotencyKeyDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
      expect.objectContaining({
        workspaceId: "workspace-1",
        principalId: "principal-1",
      }),
    );
  });

  it("keeps a privacy reason inside the transient command and invokes the existing purge use case", async () => {
    const built = createDispatcher();
    const privacyReason = "Verified data-subject deletion request";
    const mapping = mapPrivacyPurge({
      caseSnapshotId: "snapshot-1",
      reason: privacyReason,
    });
    const privacyContext = { ...context, permissions: ["privacy.delete"] };

    const preview = await built.dispatcher.preview(
      mapping.command,
      privacyContext,
    );
    expect(JSON.stringify(preview)).not.toContain(privacyReason);
    expect(built.previews.create).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          parameters: { reason: privacyReason },
        }),
      }),
    );

    await expect(
      built.dispatcher.execute(
        preview.id,
        digestIdempotencyKey("idempotency-key-123456"),
        { ...privacyContext, sessionId: "session-2" },
      ),
    ).rejects.toBeInstanceOf(AdministrationUnavailableError);
    expect(built.useCases.purgeCaseSnapshot?.execute).not.toHaveBeenCalled();

    await expect(
      built.dispatcher.execute(
        preview.id,
        digestIdempotencyKey("idempotency-key-123456"),
        privacyContext,
      ),
    ).resolves.toEqual({
      operationId: "snapshot-1",
      outcome: "accepted",
      message: "The case snapshot purge was accepted.",
    });
    expect(built.useCases.purgeCaseSnapshot?.execute).toHaveBeenCalledWith(
      "snapshot-1",
      privacyReason,
      expect.objectContaining({
        requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
      expect.objectContaining({ workspaceId: "workspace-1" }),
    );
  });

  it("does not dispatch a preview the feature preflight marked unavailable", async () => {
    const built = createDispatcher({ canConfirm: false });
    const mapping = mapRoutedOperation({
      action: "retention.reap",
      resource: "platform",
    });
    if (mapping.kind !== "supported")
      throw new Error("Expected supported mapping.");
    const preview = await built.dispatcher.preview(mapping.command, context);

    await expect(
      built.dispatcher.execute(
        preview.id,
        digestIdempotencyKey("idempotency-key-123456"),
        context,
      ),
    ).rejects.toBeInstanceOf(AdministrationUnavailableError);
    expect(built.useCases.queueRetention.execute).not.toHaveBeenCalled();
  });

  it("does not preview a command when the trusted session lacks its permission", async () => {
    const built = createDispatcher();
    const mapping = mapRoutedOperation({
      action: "job.recover",
      resource: "operation-jobs",
      id: "job-1",
    });
    if (mapping.kind !== "supported")
      throw new Error("Expected supported mapping.");

    await expect(
      built.dispatcher.preview(mapping.command, {
        ...context,
        permissions: ["operations.inspect"],
      }),
    ).rejects.toBeInstanceOf(AdministrationDeniedError);
    expect(built.preflight.preview).not.toHaveBeenCalled();
    expect(built.previews.create).not.toHaveBeenCalled();
  });

  it("does not let a preview move to another server-side session", async () => {
    const built = createDispatcher();
    const mapping = mapRoutedOperation({
      action: "job.cancel",
      resource: "operation-jobs",
      id: "job-1",
    });
    if (mapping.kind !== "supported")
      throw new Error("Expected supported mapping.");
    const preview = await built.dispatcher.preview(mapping.command, context);

    await expect(
      built.dispatcher.execute(
        preview.id,
        digestIdempotencyKey("idempotency-key-123456"),
        { ...context, sessionId: "session-2" },
      ),
    ).rejects.toBeInstanceOf(AdministrationUnavailableError);
    expect(built.useCases.cancelJob.execute).not.toHaveBeenCalled();
  });

  it("does not coerce a route action onto another resource", () => {
    expect(
      mapRoutedOperation({
        action: "job.cancel",
        resource: "dead-letters",
        id: "job-1",
      }),
    ).toEqual({ kind: "unavailable" });
    expect(digestIdempotencyKey("idempotency-key-123456")).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });
});
