import { describe, expect, it, vi } from "vitest";

import {
  PostgresAttachmentPolicyResolver,
  PostgresAttachmentPolicyUnavailableError,
} from "./policy-resolver.js";

const workspaceId = "workspace-a";
const triggerVersionId = "trigger-version-a";

function client(
  input: {
    readonly mapping?: { readonly analysisRecipeVersionId: string } | null;
    readonly recipe?: {
      readonly id: string;
      readonly attachmentStageMode: string;
      readonly attachmentPolicyVersionId: string | null;
    } | null;
    readonly policy?: object | null;
  } = {},
) {
  return {
    caseAnalysisTriggerRecipeVersion: {
      findUnique: vi.fn(async () =>
        input.mapping === undefined
          ? { analysisRecipeVersionId: "recipe-version-a" }
          : input.mapping,
      ),
    },
    analysisRecipeVersion: {
      findUnique: vi.fn(async () =>
        input.recipe === undefined
          ? {
              id: "recipe-version-a",
              attachmentStageMode: "optional",
              attachmentPolicyVersionId: "attachment-policy-config-version-a",
            }
          : input.recipe,
      ),
    },
    attachmentPolicyVersion: {
      findUnique: vi.fn(async () =>
        input.policy === undefined
          ? {
              id: "attachment-policy-config-version-a",
              configurationVersionId: "attachment-policy-config-version-a",
              processorSecurityPolicyVersionId: "attachment-security-version-a",
              visionBindingVersionId: "vision-binding-version-a",
              maximumAttachmentCount: 8,
              maximumAttachmentBytes: BigInt(4096),
              maximumArchiveEntries: 20,
              maximumExpandedArchiveBytes: BigInt(8192),
              maximumArchiveDepth: 2,
            }
          : input.policy,
      ),
    },
  };
}

describe("PostgresAttachmentPolicyResolver", () => {
  it("resolves only the exact recipe/policy versions retained by a trigger", async () => {
    const database = client();
    const resolver = new PostgresAttachmentPolicyResolver(database as never);

    await expect(
      resolver.resolveForAnalysisTrigger({
        workspaceId,
        analysisTriggerVersionId: triggerVersionId,
      }),
    ).resolves.toMatchObject({
      mode: "optional",
      policyVersion: "attachment-policy-config-version-a",
      limits: {
        maximumAttachmentCount: 8,
        maximumAttachmentBytes: 4096,
      },
      visionBindingVersionId: "vision-binding-version-a",
    });
    expect(
      database.caseAnalysisTriggerRecipeVersion.findUnique,
    ).toHaveBeenCalledWith({
      where: {
        workspaceId_analysisTriggerVersionId: {
          workspaceId,
          analysisTriggerVersionId: triggerVersionId,
        },
      },
      select: { analysisRecipeVersionId: true },
    });
    expect(database.attachmentPolicyVersion.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_id: {
            workspaceId,
            id: "attachment-policy-config-version-a",
          },
        },
      }),
    );
  });

  it("keeps a PBI-020 disabled stage explicit and leaves legacy triggers untouched", async () => {
    const disabled = new PostgresAttachmentPolicyResolver(
      client({
        recipe: {
          id: "recipe-version-a",
          attachmentStageMode: "disabled",
          attachmentPolicyVersionId: null,
        },
      }) as never,
    );
    const legacy = new PostgresAttachmentPolicyResolver(
      client({ mapping: null }) as never,
    );

    await expect(
      disabled.resolveForAnalysisTrigger({
        workspaceId,
        analysisTriggerVersionId: triggerVersionId,
      }),
    ).resolves.toMatchObject({ mode: "disabled" });
    await expect(
      legacy.resolveForAnalysisTrigger({
        workspaceId,
        analysisTriggerVersionId: triggerVersionId,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed on incoherent enabled policy pins", async () => {
    const resolver = new PostgresAttachmentPolicyResolver(
      client({
        recipe: {
          id: "recipe-version-a",
          attachmentStageMode: "required",
          attachmentPolicyVersionId: "attachment-policy-config-version-a",
        },
        policy: null,
      }) as never,
    );

    await expect(
      resolver.resolveForAnalysisTrigger({
        workspaceId,
        analysisTriggerVersionId: triggerVersionId,
      }),
    ).rejects.toBeInstanceOf(PostgresAttachmentPolicyUnavailableError);
  });

  it("resolves an exact source pin only when its persisted policy hash agrees", async () => {
    const database = client();
    const resolver = new PostgresAttachmentPolicyResolver(database as never);
    const expected = await resolver.resolveForAnalysisTrigger({
      workspaceId,
      analysisTriggerVersionId: triggerVersionId,
    });
    if (expected === undefined) throw new Error("Expected fixture policy.");

    await expect(
      resolver.resolvePinnedPolicy({
        workspaceId,
        mode: "optional",
        policyVersion: "attachment-policy-config-version-a",
        accessPolicyHash: expected.accessPolicyHash,
      }),
    ).resolves.toMatchObject({
      policyVersion: "attachment-policy-config-version-a",
      accessPolicyHash: expected.accessPolicyHash,
    });
    await expect(
      resolver.resolvePinnedPolicy({
        workspaceId,
        mode: "optional",
        policyVersion: "attachment-policy-config-version-a",
        accessPolicyHash: "d".repeat(64),
      }),
    ).rejects.toBeInstanceOf(PostgresAttachmentPolicyUnavailableError);
    expect(database.attachmentPolicyVersion.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_configurationVersionId: {
            workspaceId,
            configurationVersionId: "attachment-policy-config-version-a",
          },
        },
      }),
    );
  });
});
