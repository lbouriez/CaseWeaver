import type { AnalysisProfile } from "@caseweaver/analysis";
import { causationId, correlationId, createEnvelope, outboxEnvelopeId, utcInstant, workspaceId } from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import { RuntimeRepositoryAnalysisPreparation } from "./repository-analysis-preparation.js";

const emptyEvidence = Object.freeze([]);
const profile = Object.freeze({
  id: "profile-1",
  version: "profile-version-1",
  analysisBindingVersionId: "analysis-binding-1",
  prompt: {
    template: { version: "prompt-template-1", system: "system", user: "user" },
    schemaVersion: "case-analysis.v1",
    budgets: {
      case: { maximumCharacters: 1_000, maximumTokens: 100 },
      attachments: { maximumCharacters: 1_000, maximumTokens: 100 },
      knowledge: { maximumCharacters: 1_000, maximumTokens: 100 },
      repository: { maximumCharacters: 1_000, maximumTokens: 100 },
    },
  },
  retrieval: {
    policy: "disabled",
    profileId: "retrieval-1",
    profileVersion: "retrieval-version-1",
    collectionIds: ["collection-1"],
    maximumQueryCharacters: 1_000,
  },
  attachments: { policy: "optional" },
  repository: {
    policy: "required",
    repositoryId: "repository-1",
    repositoryVersionId: "repository-version-1",
    executionPolicyId: "policy-1",
    executionPolicyVersionId: "policy-version-1",
    repositoryAgentBindingVersionId: "agent-binding-1",
    maximumContextCharacters: 1_000,
    maximumEvidenceCharacters: 1_000,
  },
  generation: {
    maximumInputTokens: 1_000,
    maximumOutputTokens: 1_000,
    budget: { currency: "USD", hard: true },
  },
  repair: { maximumAttempts: 0, maximumInputCharacters: 1_000 },
} satisfies AnalysisProfile);

const command = createEnvelope({
  id: outboxEnvelopeId("outbox-trigger-1"),
  kind: "command",
  type: "analysis.trigger.v2",
  schemaVersion: 1,
  workspaceId: workspaceId("workspace-1"),
  occurredAt: utcInstant("2026-07-17T20:00:00.000Z"),
  correlationId: correlationId("correlation-1"),
  causationId: causationId("causation-1"),
  payload: {
    triggerRequestId: "request-1",
    triggerId: "trigger-1",
    triggerVersionId: "trigger-version-1",
    connectorRegistrationId: "connector-1",
    connectorConfigurationVersionId: "connector-version-1",
    source: "schedule",
    target: {
      connectorInstanceId: "connector-1",
      resourceType: "case",
      externalId: "case-1",
    },
  },
});

describe("RuntimeRepositoryAnalysisPreparation", () => {
  it("pins a resolved commit under the durable claim before PBI-011 submission", async () => {
    const inputs = {
      claim: vi.fn(async () => ({
        kind: "claimed" as const,
        claim: {
          id: "input-1",
          fence: 1n,
          workspaceId: "workspace-1",
          profile,
          repository: {
            runtimeVersionId: "recipe-version-1",
            repositoryId: "repository-1",
            repositoryVersionId: "repository-version-1",
            executionPolicyId: "policy-1",
            executionPolicyVersionId: "policy-version-1",
            repositoryAgentBindingVersionId: "agent-binding-1",
          },
        },
      })),
      finalize: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    };
    const repositories = {
      resolve: vi.fn(async () => ({
        repositoryId: "repository-1",
        repositoryVersionId: "repository-version-1",
        runtimePinId: "recipe-version-1",
        executionPolicyId: "policy-1",
        executionPolicyVersionId: "policy-version-1",
        repositoryAgentBindingVersionId: "agent-binding-1",
        pinnedCommit: "a".repeat(40),
        resolvedAt: "2026-07-17T20:00:00.000Z",
      })),
    };
    const service = new RuntimeRepositoryAnalysisPreparation(
      inputs as never,
      repositories as never,
    );

    await service.prepare(command, new AbortController().signal);

    expect(repositories.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeVersionId: "recipe-version-1", profile }),
    );
    expect(inputs.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        claim: expect.objectContaining({ id: "input-1", fence: 1n }),
        repositoryRun: expect.objectContaining({ pinnedCommit: "a".repeat(40) }),
      }),
    );
    expect(inputs.fail).not.toHaveBeenCalled();
  });

  it("leaves historical trigger records on their existing submission path", async () => {
    const inputs = {
      claim: vi.fn(async () => ({ kind: "notApplicable" as const })),
      finalize: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    };
    const repositories = { resolve: vi.fn() };
    const service = new RuntimeRepositoryAnalysisPreparation(
      inputs as never,
      repositories as never,
    );

    await service.prepare(command, new AbortController().signal);

    expect(repositories.resolve).not.toHaveBeenCalled();
    expect(inputs.finalize).not.toHaveBeenCalled();
  });
});
