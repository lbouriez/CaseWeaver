import { describe, expect, it } from "vitest";

import {
  createAttachmentPreparationResult,
  type PreparedAttachmentDerivative,
} from "./index.js";

const policy = {
  mode: "optional",
  policyVersion: "attachment-policy.v1",
  accessPolicyHash: "access-policy.v1",
} as const;

const first: PreparedAttachmentDerivative = {
  occurrenceIdentity: "occurrence-a",
  derivativeIdentity: "derivative-a",
  derivativeContentHash: "content-a",
  searchableText: "visible attachment evidence A",
};

const second: PreparedAttachmentDerivative = {
  occurrenceIdentity: "occurrence-b",
  derivativeIdentity: "derivative-b",
  derivativeContentHash: "content-b",
  searchableText: "visible attachment evidence B",
};

describe("attachment preparation result", () => {
  it("uses a deterministic cache-oriented identity independent of input order", () => {
    const firstOrder = createAttachmentPreparationResult({
      policy,
      derivatives: [first, second],
      warnings: [
        {
          kind: "attachmentPreparationWarning",
          code: "attachment.processing-failed",
          retryable: true,
          occurrenceIdentity: "occurrence-c",
        },
        {
          kind: "attachmentPreparationWarning",
          code: "attachment.unsupported-mime",
          retryable: false,
          occurrenceIdentity: "occurrence-d",
        },
      ],
    });
    const secondOrder = createAttachmentPreparationResult({
      policy,
      derivatives: [second, first],
      warnings: [
        {
          kind: "attachmentPreparationWarning",
          code: "attachment.unsupported-mime",
          retryable: false,
          occurrenceIdentity: "occurrence-d",
        },
        {
          kind: "attachmentPreparationWarning",
          code: "attachment.processing-failed",
          retryable: true,
          occurrenceIdentity: "occurrence-c",
        },
      ],
    });

    expect(secondOrder.outcome.identityHash).toBe(
      firstOrder.outcome.identityHash,
    );
    expect(secondOrder.outcome.selectedDerivatives).toEqual(
      firstOrder.outcome.selectedDerivatives,
    );
    expect(firstOrder.outcome.retryRequired).toBe(true);
    expect(firstOrder.outcome).not.toHaveProperty("searchableText");
    expect(firstOrder.outcome).not.toHaveProperty("derivatives");
  });

  it("changes identity when a cached derivative or pinned policy changes", () => {
    const baseline = createAttachmentPreparationResult({
      policy,
      derivatives: [first],
    });
    const changedDerivative = createAttachmentPreparationResult({
      policy,
      derivatives: [{ ...first, derivativeContentHash: "content-a-v2" }],
    });
    const changedPolicy = createAttachmentPreparationResult({
      policy: { ...policy, accessPolicyHash: "access-policy.v2" },
      derivatives: [first],
    });

    expect(changedDerivative.outcome.identityHash).not.toBe(
      baseline.outcome.identityHash,
    );
    expect(changedPolicy.outcome.identityHash).not.toBe(
      baseline.outcome.identityHash,
    );
  });

  it("keeps optional failures non-terminal but rejects required or disabled inconsistencies", () => {
    const optional = createAttachmentPreparationResult({
      policy,
      warnings: [
        {
          kind: "attachmentPreparationWarning",
          code: "attachment.in-progress",
          retryable: true,
        },
      ],
    });
    const required = createAttachmentPreparationResult({
      policy: { ...policy, mode: "required" },
      warnings: [
        {
          kind: "attachmentPreparationWarning",
          code: "attachment.in-progress",
          retryable: true,
        },
      ],
    });

    expect(optional.outcome).toMatchObject({
      status: "prepared",
      retryRequired: true,
    });
    expect(required.outcome).toMatchObject({
      status: "terminal",
      retryRequired: true,
    });
    expect(() =>
      createAttachmentPreparationResult({
        policy: { ...policy, mode: "disabled" },
        derivatives: [first],
      }),
    ).toThrow("Disabled attachment preparation");
  });
});
