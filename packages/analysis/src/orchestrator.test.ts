import {
  analysisIdentityId,
  analysisJobId,
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import {
  AnalysisPromptBuilder,
  WhitespacePromptTokenCounter,
} from "@caseweaver/prompts";
import { describe, expect, it } from "vitest";

import type {
  AnalysisEvidence,
  AnalysisExecution,
  AnalysisProfile,
} from "./contracts.js";
import { analysisProfileSchema } from "./contracts.js";
import {
  DeterministicAnalysisAiGateway,
  DeterministicRepositoryInvestigationPort,
  FixedAnalysisClock,
  InMemoryAnalysisExecutionStore,
  SequentialAnalysisIds,
  StaticAnalysisPromptBuilderResolver,
  StaticAttachmentEvidencePort,
  StaticRetrievalEvidencePort,
} from "./fakes.js";
import {
  captureAnalysisRequest,
  createAnalysisRequestIdentity,
  identityInputFor,
} from "./identity.js";
import { AnalysisOrchestrator } from "./orchestrator.js";

const digest = (character: string) => character.repeat(64);
const signal = new AbortController().signal;

const output = JSON.stringify({
  summary: "The documented setting likely explains the incident.",
  probableCauses: [
    { statement: "The setting is disabled.", evidenceIds: ["knowledge-1"] },
  ],
  investigation: [
    { step: "Confirm the setting.", evidenceIds: ["knowledge-1"] },
  ],
  recommendedActions: [
    { statement: "Enable the setting.", evidenceIds: ["knowledge-1"] },
  ],
  evidence: [
    {
      id: "knowledge-1",
      explanation: "The knowledge item defines the setting.",
    },
  ],
  unansweredQuestions: [],
  confidence: "medium",
});

function profile(overrides: Partial<AnalysisProfile> = {}): AnalysisProfile {
  return {
    id: "analysis-profile",
    version: "1",
    analysisBindingVersionId: "analysis-binding-1",
    prompt: {
      template: {
        id: "analysis-prompt",
        version: "1",
        systemInstruction: "Analyze support cases.",
      },
      schemaVersion: "case-analysis.v1",
      budgets: {
        case: { maximumCharacters: 10_000, maximumTokens: 2_000 },
        attachments: { maximumCharacters: 10_000, maximumTokens: 2_000 },
        knowledge: { maximumCharacters: 10_000, maximumTokens: 2_000 },
        repository: { maximumCharacters: 10_000, maximumTokens: 2_000 },
      },
    },
    retrieval: {
      policy: "optional",
      profileId: "retrieval-profile",
      profileVersion: "1",
      collectionIds: ["knowledge"],
      maximumQueryCharacters: 4_000,
    },
    attachments: { policy: "optional" },
    repository: {
      policy: "disabled",
      maximumContextCharacters: 4_000,
      maximumEvidenceCharacters: 4_000,
    },
    generation: {
      maximumInputTokens: 4_000,
      maximumOutputTokens: 1_000,
      budget: { currency: "USD", hard: false },
    },
    repair: { maximumAttempts: 1, maximumInputCharacters: 4_000 },
    ...overrides,
  };
}

function execution(configuredProfile = profile()): AnalysisExecution {
  return {
    workspaceId: "workspace-1",
    analysisJobId: "analysis-job-1",
    analysisIdentityId: "analysis-identity-1",
    analysisAttemptId: "analysis-attempt-1",
    snapshot: {
      id: "snapshot-1",
      revision: "revision-1",
      capturedAt: "2026-07-14T15:00:00.000Z",
      title: "Service cannot connect",
      summary: "The customer cannot connect after the configuration changed.",
      contentHash: digest("a"),
      messages: [
        {
          id: "message-1",
          content: "The configuration changed before connections failed.",
          contentHash: digest("b"),
        },
      ],
    },
    profile: configuredProfile,
  };
}

const knowledgeEvidence: AnalysisEvidence = {
  id: "knowledge-1",
  kind: "knowledge",
  content: "Enable the connection setting for this integration.",
  contentHash: digest("c"),
  itemId: "item-1",
  revisionId: "revision-1",
  chunkId: "chunk-1",
  sourceUrl: "https://docs.example.invalid/connection",
};

function command(jobId = "analysis-job-1") {
  return createEnvelope({
    id: outboxEnvelopeId(`outbox-command-${jobId}`),
    kind: "command",
    type: "analysis.execute.v1",
    schemaVersion: 1,
    workspaceId: workspaceId("workspace-1"),
    occurredAt: utcInstant("2026-07-14T15:00:00.000Z"),
    correlationId: correlationId("correlation-1"),
    causationId: causationId("causation-1"),
    payload: {
      analysisJobId: analysisJobId(jobId),
      analysisIdentityId: analysisIdentityId("analysis-identity-1"),
    },
  });
}

function harness(input: {
  readonly configuredProfile?: AnalysisProfile;
  readonly attachmentFailure?: Error;
  readonly retrievalFailure?: Error;
  readonly retrievalOperationIds?: readonly string[];
  readonly responses?: readonly unknown[];
}) {
  const store = new InMemoryAnalysisExecutionStore();
  store.seed(execution(input.configuredProfile));
  const ai = new DeterministicAnalysisAiGateway(
    input.responses ?? [{ text: output }],
  );
  return {
    store,
    ai,
    orchestrator: new AnalysisOrchestrator({
      store,
      attachments: new StaticAttachmentEvidencePort(
        [],
        input.attachmentFailure,
      ),
      retrieval: new StaticRetrievalEvidencePort(
        [knowledgeEvidence],
        input.retrievalFailure,
        input.retrievalOperationIds,
      ),
      prompts: new StaticAnalysisPromptBuilderResolver(
        new AnalysisPromptBuilder(new WhitespacePromptTokenCounter()),
      ),
      ai,
      ids: new SequentialAnalysisIds(),
      clock: new FixedAnalysisClock(),
      repository: new DeterministicRepositoryInvestigationPort(),
    }),
  };
}

describe("AnalysisOrchestrator", () => {
  it("completes repository-disabled analysis with optional stage failures visible", async () => {
    const test = harness({
      attachmentFailure: new Error("attachment unavailable"),
      retrievalOperationIds: ["retrieval-operation-1"],
    });

    await expect(test.orchestrator.execute(command(), signal)).resolves.toEqual(
      {
        kind: "completed",
        resultId: "analysisResult-1",
      },
    );

    const result = test.store.results.get("analysisResult-1");
    expect(result?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "attachments",
          status: "failed",
          policy: "optional",
        }),
        expect.objectContaining({ stage: "retrieval", status: "completed" }),
        expect.objectContaining({
          stage: "repository",
          status: "skipped",
          policy: "disabled",
        }),
      ]),
    );
    expect(result?.output.recommendedActions[0]?.evidenceIds).toEqual([
      "knowledge-1",
    ]);
    expect(result?.operationIds).toEqual([
      "retrieval-operation-1",
      "operation-1",
    ]);
    expect(test.ai.calls).toHaveLength(1);
    expect(test.ai.calls[0]).toMatchObject({
      kind: "generation",
      role: "analysis",
      bindingVersionId: "analysis-binding-1",
      requiredCapabilities: ["structuredOutput"],
    });
    expect(test.store.events).toHaveLength(1);
    expect(test.store.events[0]?.type).toBe("analysis.completed.v1");
    await expect(test.orchestrator.execute(command(), signal)).resolves.toEqual(
      {
        kind: "alreadyCompleted",
        resultId: "analysisResult-1",
      },
    );
  });

  it("does not complete an analysis when a required stage fails", async () => {
    const test = harness({
      configuredProfile: profile({
        retrieval: { ...profile().retrieval, policy: "required" },
      }),
      retrievalFailure: new Error("retrieval unavailable"),
    });

    await expect(
      test.orchestrator.execute(command(), signal),
    ).rejects.toMatchObject({
      code: "analysis.stageFailed",
    });
    expect(test.store.results).toHaveLength(0);
    expect(test.store.events).toHaveLength(0);
    expect(test.store.failures[0]).toMatchObject({ outcome: "failed" });
  });

  it("persists a terminal cancelled attempt through a fresh non-aborted signal", async () => {
    const store = new InMemoryAnalysisExecutionStore();
    store.seed(execution());
    const controller = new AbortController();
    const orchestrator = new AnalysisOrchestrator({
      store,
      attachments: {
        async resolve() {
          controller.abort();
          throw new Error("attachment processing interrupted");
        },
      },
      retrieval: new StaticRetrievalEvidencePort([knowledgeEvidence]),
      prompts: new StaticAnalysisPromptBuilderResolver(
        new AnalysisPromptBuilder(new WhitespacePromptTokenCounter()),
      ),
      ai: new DeterministicAnalysisAiGateway([{ text: output }]),
      ids: new SequentialAnalysisIds(),
      clock: new FixedAnalysisClock(),
      repository: new DeterministicRepositoryInvestigationPort(),
    });

    await expect(
      orchestrator.execute(command(), controller.signal),
    ).rejects.toMatchObject({
      code: "analysis.cancelled",
    });
    expect(store.failures[0]).toMatchObject({ outcome: "cancelled" });
    expect(store.failureSignalsAborted).toEqual([false]);
  });

  it("performs only the configured bounded repair attempts", async () => {
    const test = harness({
      responses: [{ text: "not-json" }, { text: output }],
    });

    await expect(
      test.orchestrator.execute(command(), signal),
    ).resolves.toMatchObject({
      kind: "completed",
    });
    expect(test.ai.calls).toHaveLength(2);
    expect(test.store.results.get("analysisResult-1")?.operationIds).toEqual([
      "operation-1",
      "operation-2",
    ]);
  });

  it("retains tombstoned snapshot content and records a force rerun separately", async () => {
    const test = harness({
      responses: [{ text: output }, { text: output }],
    });
    const original = execution();
    const tombstoned: AnalysisExecution = {
      ...original,
      snapshot: {
        ...original.snapshot,
        tombstone: {
          actorPrincipalId: "principal-1",
          tombstonedAt: "2026-07-14T15:05:00.000Z",
          reason: "Source case was deleted under retention policy.",
        },
      },
    };
    test.store.seed(tombstoned);

    await expect(
      test.orchestrator.execute(command(), signal),
    ).resolves.toMatchObject({
      kind: "completed",
      resultId: "analysisResult-1",
    });
    const completed = test.store.results.get("analysisResult-1");
    expect(completed?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "caseSnapshot",
          content: `${tombstoned.snapshot.title}\n\n${tombstoned.snapshot.summary}`,
        }),
      ]),
    );

    test.store.seed({
      ...tombstoned,
      analysisJobId: "analysis-job-2",
      analysisAttemptId: "analysis-attempt-2",
    });
    await expect(
      test.orchestrator.execute(command("analysis-job-2"), signal),
    ).resolves.toMatchObject({
      kind: "completed",
      resultId: "analysisResult-3",
    });

    expect(test.store.results).toHaveLength(2);
    expect(test.store.results.get("analysisResult-1")).toBe(completed);
    expect(test.store.results.get("analysisResult-3")).toMatchObject({
      analysisJobId: "analysis-job-2",
      analysisAttemptId: "analysis-attempt-2",
    });
  });
});

describe("analysis request identity", () => {
  it("is canonical and changes when immutable input changes", () => {
    const input = identityInputFor(execution().snapshot, profile());
    const first = createAnalysisRequestIdentity(input);
    const reordered = createAnalysisRequestIdentity({
      ...input,
      collectionIds: ["knowledge", "knowledge"],
    });
    const changedCommit = createAnalysisRequestIdentity({
      ...input,
      repositoryCommit: "a".repeat(40),
    });
    const changedRevision = createAnalysisRequestIdentity({
      ...input,
      caseRevision: "revision-2",
    });

    expect(reordered).toEqual(first);
    expect(changedCommit.identityHash).not.toBe(first.identityHash);
    expect(changedRevision.identityHash).not.toBe(first.identityHash);
  });

  it("captures an immutable snapshot before deriving request identity", async () => {
    const captured = await captureAnalysisRequest(
      {
        capture: async () => execution().snapshot,
      },
      {
        workspaceId: "workspace-1",
        caseReference: "case-1",
        profile: profile(),
        signal,
      },
    );

    expect(captured.snapshot.id).toBe("snapshot-1");
    expect(captured.identity.caseRevision).toBe("revision-1");
  });
});

describe("analysis immutable runtime pins", () => {
  it("rejects an enabled repository stage without an immutable runtime version", () => {
    const configured = profile({
      repository: {
        policy: "required",
        bindingVersionId: "repository-binding-a",
        repositoryId: "repository-a",
        pinnedCommit: "a".repeat(40),
        maximumContextCharacters: 100,
        maximumEvidenceCharacters: 100,
      },
    });

    expect(analysisProfileSchema.safeParse(configured).success).toBe(false);
    expect(
      analysisProfileSchema.safeParse({
        ...configured,
        repository: {
          ...configured.repository,
          runtimeVersionId: "repository-runtime-version-a",
        },
      }).success,
    ).toBe(true);
  });
});
