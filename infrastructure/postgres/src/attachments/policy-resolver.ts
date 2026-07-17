import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export interface ResolvedAttachmentPreparationPolicy {
  readonly mode: "disabled" | "optional" | "required";
  /** Immutable attachment-policy configuration version, never a current pointer. */
  readonly policyVersion: string;
  /** Deterministic hash of the exact policy settings used for cache separation. */
  readonly accessPolicyHash: string;
  readonly limits: Readonly<{
    readonly maximumAttachmentCount: number;
    readonly maximumAttachmentBytes: number;
    readonly maximumArchiveEntries: number;
    readonly maximumExpandedArchiveBytes: number;
    readonly maximumArchiveDepth: number;
  }>;
  readonly processorSecurityPolicyVersionId: string;
  readonly visionBindingVersionId: string;
}

/** Deliberately redacted: policy settings and records never reach a worker error. */
export class PostgresAttachmentPolicyUnavailableError extends Error {
  public readonly code = "attachment.policyUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("The immutable attachment policy is unavailable.");
  }
}

function unavailable(): never {
  throw new PostgresAttachmentPolicyUnavailableError();
}

function safeInteger(value: bigint, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) unavailable();
  return parsed;
}

function policyHash(value: object): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export interface AttachmentPolicyVersionRecord {
  readonly id: string;
  readonly configurationVersionId: string;
  readonly processorSecurityPolicyVersionId: string;
  readonly visionBindingVersionId: string;
  readonly maximumAttachmentCount: number;
  readonly maximumAttachmentBytes: bigint;
  readonly maximumArchiveEntries: number;
  readonly maximumExpandedArchiveBytes: bigint;
  readonly maximumArchiveDepth: number;
}

/** One canonical cache/access identity for every source and case consumer. */
export function resolveEnabledAttachmentPolicy(input: {
  readonly mode: "optional" | "required";
  readonly policy: AttachmentPolicyVersionRecord | null;
}): ResolvedAttachmentPreparationPolicy {
  const { policy } = input;
  if (
    policy === null ||
    policy.id !== policy.configurationVersionId ||
    !identifier.test(policy.id) ||
    !identifier.test(policy.configurationVersionId) ||
    !identifier.test(policy.processorSecurityPolicyVersionId) ||
    !identifier.test(policy.visionBindingVersionId) ||
    !Number.isSafeInteger(policy.maximumAttachmentCount) ||
    policy.maximumAttachmentCount < 1 ||
    policy.maximumAttachmentCount > 10_000 ||
    !Number.isSafeInteger(policy.maximumArchiveEntries) ||
    policy.maximumArchiveEntries < 1 ||
    policy.maximumArchiveEntries > 100_000 ||
    !Number.isSafeInteger(policy.maximumArchiveDepth) ||
    policy.maximumArchiveDepth < 0 ||
    policy.maximumArchiveDepth > 32
  ) {
    unavailable();
  }
  const limits = Object.freeze({
    maximumAttachmentCount: policy.maximumAttachmentCount,
    maximumAttachmentBytes: safeInteger(
      policy.maximumAttachmentBytes,
      2 * 1024 * 1024 * 1024,
    ),
    maximumArchiveEntries: policy.maximumArchiveEntries,
    maximumExpandedArchiveBytes: safeInteger(
      policy.maximumExpandedArchiveBytes,
      8 * 1024 * 1024 * 1024,
    ),
    maximumArchiveDepth: policy.maximumArchiveDepth,
  });
  return Object.freeze({
    mode: input.mode,
    policyVersion: policy.configurationVersionId,
    accessPolicyHash: policyHash({
      policyVersion: policy.configurationVersionId,
      processorSecurityPolicyVersionId: policy.processorSecurityPolicyVersionId,
      visionBindingVersionId: policy.visionBindingVersionId,
      limits,
    }),
    limits,
    processorSecurityPolicyVersionId: policy.processorSecurityPolicyVersionId,
    visionBindingVersionId: policy.visionBindingVersionId,
  });
}

function disabledPolicy(recipeVersionId: string): ResolvedAttachmentPreparationPolicy {
  if (!identifier.test(recipeVersionId)) unavailable();
  return Object.freeze({
    mode: "disabled",
    policyVersion: `disabled:${recipeVersionId}`,
    accessPolicyHash: policyHash({ kind: "disabled", recipeVersionId }),
    limits: Object.freeze({
      maximumAttachmentCount: 1,
      maximumAttachmentBytes: 1,
      maximumArchiveEntries: 1,
      maximumExpandedArchiveBytes: 1,
      maximumArchiveDepth: 0,
    }),
    processorSecurityPolicyVersionId: `disabled:${recipeVersionId}`,
    visionBindingVersionId: `disabled:${recipeVersionId}`,
  });
}

/**
 * Resolves attachment limits only from the exact recipe version retained by a
 * PBI-020 trigger. It intentionally does not use current configuration
 * pointers, connector settings, secret locators, or any browser-facing DTO.
 */
export class PostgresAttachmentPolicyResolver {
  public constructor(private readonly client: PrismaClient) {}

  /** `undefined` means a pre-PBI-020 trigger, which retains legacy capture behavior. */
  public async resolveForAnalysisTrigger(input: {
    readonly workspaceId: string;
    readonly analysisTriggerVersionId: string;
  }): Promise<ResolvedAttachmentPreparationPolicy | undefined> {
    if (
      !identifier.test(input.workspaceId) ||
      !identifier.test(input.analysisTriggerVersionId)
    ) {
      unavailable();
    }
    try {
      const mapping = await this.client.caseAnalysisTriggerRecipeVersion.findUnique({
        where: {
          workspaceId_analysisTriggerVersionId: {
            workspaceId: input.workspaceId,
            analysisTriggerVersionId: input.analysisTriggerVersionId,
          },
        },
        select: { analysisRecipeVersionId: true },
      });
      if (mapping === null) return undefined;
      const recipe = await this.client.analysisRecipeVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: mapping.analysisRecipeVersionId,
          },
        },
        select: {
          id: true,
          attachmentStageMode: true,
          attachmentPolicyVersionId: true,
        },
      });
      if (recipe === null || !identifier.test(recipe.id)) unavailable();
      if (recipe.attachmentStageMode === "disabled") {
        if (recipe.attachmentPolicyVersionId !== null) unavailable();
        return disabledPolicy(recipe.id);
      }
      if (
        (recipe.attachmentStageMode !== "optional" &&
          recipe.attachmentStageMode !== "required") ||
        recipe.attachmentPolicyVersionId === null
      ) {
        unavailable();
      }
      const policy = await this.client.attachmentPolicyVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: recipe.attachmentPolicyVersionId,
          },
        },
        select: {
          id: true,
          configurationVersionId: true,
          processorSecurityPolicyVersionId: true,
          visionBindingVersionId: true,
          maximumAttachmentCount: true,
          maximumAttachmentBytes: true,
          maximumArchiveEntries: true,
          maximumExpandedArchiveBytes: true,
          maximumArchiveDepth: true,
        },
      });
      if (policy === null || policy.id !== recipe.attachmentPolicyVersionId) {
        unavailable();
      }
      return resolveEnabledAttachmentPolicy({
        mode: recipe.attachmentStageMode,
        policy,
      });
    } catch (error) {
      if (error instanceof PostgresAttachmentPolicyUnavailableError) throw error;
      unavailable();
    }
  }

  /** Resolves an immutable source-stage policy and verifies its recorded hash. */
  public async resolvePinnedPolicy(input: {
    readonly workspaceId: string;
    readonly mode: "optional" | "required";
    readonly policyVersion: string;
    readonly accessPolicyHash: string;
  }): Promise<ResolvedAttachmentPreparationPolicy> {
    if (
      !identifier.test(input.workspaceId) ||
      !identifier.test(input.policyVersion) ||
      !/^[a-f0-9]{64}$/u.test(input.accessPolicyHash)
    ) {
      unavailable();
    }
    try {
      const policy = await this.client.attachmentPolicyVersion.findUnique({
        where: {
          workspaceId_configurationVersionId: {
            workspaceId: input.workspaceId,
            configurationVersionId: input.policyVersion,
          },
        },
        select: {
          id: true,
          configurationVersionId: true,
          processorSecurityPolicyVersionId: true,
          visionBindingVersionId: true,
          maximumAttachmentCount: true,
          maximumAttachmentBytes: true,
          maximumArchiveEntries: true,
          maximumExpandedArchiveBytes: true,
          maximumArchiveDepth: true,
        },
      });
      const resolved = resolveEnabledAttachmentPolicy({
        mode: input.mode,
        policy,
      });
      if (resolved.accessPolicyHash !== input.accessPolicyHash) unavailable();
      return resolved;
    } catch (error) {
      if (error instanceof PostgresAttachmentPolicyUnavailableError) throw error;
      unavailable();
    }
  }
}
