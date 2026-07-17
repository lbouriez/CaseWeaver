import type { CapturedCaseSnapshot } from "@caseweaver/application";
import {
  type NormalizedCase,
  versionedOpaqueValue,
} from "@caseweaver/connector-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  AttachmentPreparingCaseSnapshotProjector,
  type CaseAttachmentPreparationRuntime,
} from "./case-capture-projector.js";

const signal = new AbortController().signal;
const request = {
  id: "request-a",
  workspaceId: "workspace-a",
  triggerVersionId: "trigger-version-a",
  connectorRegistrationId: "connector-a",
  connectorConfigurationVersionId: "connector-version-a",
  target: {
    connectorInstanceId: "connector-a",
    resourceType: "case",
    externalId: "case-a",
  },
} as never;

const normalizedCase: NormalizedCase = {
  reference: request.target,
  subject: "A support request",
  messages: [],
  attachments: [],
  externalRevision: versionedOpaqueValue("test", "revision-a"),
};

const snapshot: CapturedCaseSnapshot = {
  revision: "a".repeat(64) as never,
  capturedAt: "2026-07-17T00:00:00.000Z" as never,
  title: "A support request",
  summary: "A support request",
  contentHash: "b".repeat(64) as never,
  messages: [],
  attachmentReferences: [
    {
      connectorRegistrationId: "connector-a",
      resourceType: "attachment",
      externalId: "private-reference-never-retained-by-pbi20",
    },
  ],
};

const runtime: CaseAttachmentPreparationRuntime = {
  policy: {
    mode: "optional",
    policyVersion: "attachment-policy-version-a",
    accessPolicyHash: "c".repeat(64),
  },
};

describe("AttachmentPreparingCaseSnapshotProjector", () => {
  it("pins a stable attempt and clears legacy mutable attachment references", async () => {
    const project = vi.fn(async () => snapshot);
    const prepare = vi.fn(async () => ({
      outcome: { status: "prepared" },
      attemptId: "attempt-a",
    }));
    const wrapper = new AttachmentPreparingCaseSnapshotProjector(
      { project },
      { resolve: vi.fn(async () => runtime) },
      { create: vi.fn(() => ({ prepare })) },
    );

    const result = await wrapper.project({ request, normalizedCase, signal });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        caseCaptureId: "request-a",
        connectorConfigurationVersionId: "connector-version-a",
        policy: runtime.policy,
      }),
    );
    expect(project).toHaveBeenCalledAfter(prepare);
    expect(result).toMatchObject({
      attachmentPreparationAttemptId: "attempt-a",
    });
    expect(result.attachmentReferences).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private-reference");
  });

  it("retains the legacy projector unchanged only when the trigger has no PBI-020 recipe", async () => {
    const project = vi.fn(async () => snapshot);
    const wrapper = new AttachmentPreparingCaseSnapshotProjector(
      { project },
      { resolve: vi.fn(async () => undefined) },
      { create: vi.fn() },
    );

    await expect(
      wrapper.project({ request, normalizedCase, signal }),
    ).resolves.toBe(snapshot);
  });

  it("clears attachment references without invoking a source for an exact disabled recipe", async () => {
    const project = vi.fn(async () => snapshot);
    const wrapper = new AttachmentPreparingCaseSnapshotProjector(
      { project },
      {
        resolve: vi.fn(async () => ({
          policy: { ...runtime.policy, mode: "disabled" as const },
        })),
      },
      { create: vi.fn() },
    );

    const result = await wrapper.project({ request, normalizedCase, signal });
    expect(result.attachmentReferences).toBeUndefined();
  });

  it("redacts immutable attachment runtime lookup failures before capture", async () => {
    const wrapper = new AttachmentPreparingCaseSnapshotProjector(
      { project: vi.fn(async () => snapshot) },
      {
        resolve: vi.fn(async () => {
          throw new Error("vault:private-policy");
        }),
      },
      { create: vi.fn() },
    );

    await expect(
      wrapper.project({ request, normalizedCase, signal }),
    ).rejects.toMatchObject({
      code: "analysis.trigger.attachmentPreparationUnavailable",
      retryable: false,
    });
  });
});
