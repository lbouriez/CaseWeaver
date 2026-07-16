import type {
  AiExecutionGateway,
  MeteredAiResult,
} from "@caseweaver/ai-execution";
import {
  analysisResultId,
  causationId,
  createEnvelope,
  outboxEnvelopeId,
  utcInstant,
} from "@caseweaver/domain";
import {
  assertRepairInputBound,
  CASE_ANALYSIS_SCHEMA_VERSION,
  type PromptContextItem,
  PromptContractError,
  parseCaseAnalysisOutput,
  validateAnalysisEvidence,
} from "@caseweaver/prompts";

import {
  type AnalysisClock,
  type AnalysisEvidence,
  type AnalysisEvidenceStageResult,
  type AnalysisExecution,
  type AnalysisExecutionStore,
  type AnalysisIdGenerator,
  type AnalysisProfile,
  type AnalysisPromptBuilderResolver,
  type AnalysisResultRecord,
  type AnalysisStageName,
  type AnalysisStageStatus,
  type AttachmentEvidencePort,
  analysisEvidenceSchema,
  analysisProfileSchema,
  type ImmutableCaseSnapshot,
  immutableCaseSnapshotSchema,
  type RepositoryInvestigationPort,
  type RetrievalEvidencePort,
} from "./contracts.js";

export class AnalysisOrchestrationError extends Error {
  public constructor(
    public readonly code:
      | "analysis.cancelled"
      | "analysis.invalidConfiguration"
      | "analysis.invalidEvidence"
      | "analysis.stageFailed"
      | "analysis.structuredOutput",
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AnalysisOrchestrationError";
  }
}

export interface AnalysisOrchestratorDependencies {
  readonly store: AnalysisExecutionStore;
  readonly attachments: AttachmentEvidencePort;
  readonly retrieval: RetrievalEvidencePort;
  readonly prompts: AnalysisPromptBuilderResolver;
  readonly ai: AiExecutionGateway;
  readonly ids: AnalysisIdGenerator;
  readonly clock: AnalysisClock;
  /**
   * Production composition must supply a server-private, commit-pinned
   * sandbox adapter. Deterministic implementations are test fixtures only.
   */
  readonly repository: RepositoryInvestigationPort;
}

export type AnalysisExecutionOutcome =
  | { readonly kind: "completed"; readonly resultId: string }
  | { readonly kind: "alreadyCompleted"; readonly resultId: string }
  | { readonly kind: "alreadyRunning" }
  | { readonly kind: "notFound" };

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AnalysisOrchestrationError(
      "analysis.cancelled",
      "Analysis execution was cancelled.",
      false,
    );
  }
}

function errorDetails(error: unknown): {
  readonly code: string;
  readonly retryable: boolean;
} {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "retryable" in error &&
    typeof error.code === "string" &&
    typeof error.retryable === "boolean"
  ) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "analysis.stageFailed", retryable: true };
}

function contextualError(
  stage: AnalysisStageName,
  error: unknown,
): AnalysisOrchestrationError {
  const details = errorDetails(error);
  if (error instanceof AnalysisOrchestrationError) return error;
  return new AnalysisOrchestrationError(
    details.code === "prompts.invalidOutput" ||
      details.code === "prompts.invalidEvidence"
      ? "analysis.structuredOutput"
      : "analysis.stageFailed",
    `Analysis ${stage} stage failed.`,
    details.retryable,
  );
}

function freezeStage(
  stage: AnalysisStageName,
  status: AnalysisStageStatus["status"],
  policy?: AnalysisStageStatus["policy"],
  error?: AnalysisStageStatus["error"],
): AnalysisStageStatus {
  return Object.freeze({
    stage,
    status,
    ...(policy === undefined ? {} : { policy }),
    ...(error === undefined ? {} : { error }),
  });
}

function snapshotEvidence(
  snapshot: ImmutableCaseSnapshot,
): readonly AnalysisEvidence[] {
  const summary: AnalysisEvidence = analysisEvidenceSchema.parse({
    id: `snapshot-${snapshot.contentHash}`,
    kind: "caseSnapshot",
    content: `${snapshot.title}\n\n${snapshot.summary}`,
    contentHash: snapshot.contentHash,
    caseSnapshotId: snapshot.id,
    revision: snapshot.revision,
  });
  const messages = snapshot.messages.map((message, index) =>
    analysisEvidenceSchema.parse({
      id: `message-${message.contentHash.slice(0, 48)}-${index}`,
      kind: "caseMessage",
      content: message.content,
      contentHash: message.contentHash,
      caseSnapshotId: snapshot.id,
      messageId: message.id,
    }),
  );
  return Object.freeze([summary, ...messages]);
}

function validateEvidence(
  evidence: readonly AnalysisEvidence[],
): readonly AnalysisEvidence[] {
  const ids = new Set<string>();
  const parsed: AnalysisEvidence[] = [];
  for (const item of evidence) {
    const validated = analysisEvidenceSchema.parse(item);
    if (ids.has(validated.id)) {
      throw new AnalysisOrchestrationError(
        "analysis.invalidEvidence",
        "Analysis evidence identifiers must be unique.",
        false,
      );
    }
    ids.add(validated.id);
    parsed.push(Object.freeze({ ...validated }));
  }
  return Object.freeze(parsed);
}

function promptContext(evidence: readonly AnalysisEvidence[]): {
  readonly case: readonly PromptContextItem[];
  readonly attachments: readonly PromptContextItem[];
  readonly knowledge: readonly PromptContextItem[];
  readonly repository: readonly PromptContextItem[];
} {
  const context = {
    case: [] as PromptContextItem[],
    attachments: [] as PromptContextItem[],
    knowledge: [] as PromptContextItem[],
    repository: [] as PromptContextItem[],
  };
  for (const item of evidence) {
    const promptItem: PromptContextItem = {
      id: item.id,
      kind: item.kind,
      content: item.content,
      contentHash: item.contentHash,
    };
    switch (item.kind) {
      case "caseSnapshot":
      case "caseMessage":
        context.case.push(promptItem);
        break;
      case "attachment":
        context.attachments.push(promptItem);
        break;
      case "knowledge":
        context.knowledge.push(promptItem);
        break;
      case "repository":
        context.repository.push(promptItem);
        break;
    }
  }
  return Object.freeze({
    case: Object.freeze(context.case),
    attachments: Object.freeze(context.attachments),
    knowledge: Object.freeze(context.knowledge),
    repository: Object.freeze(context.repository),
  });
}

function boundedEvidence(
  evidence: readonly AnalysisEvidence[],
  maximumCharacters: number,
): readonly AnalysisEvidence[] {
  const selected: AnalysisEvidence[] = [];
  let characters = 0;
  for (const item of evidence) {
    if (characters + item.content.length > maximumCharacters) continue;
    selected.push(item);
    characters += item.content.length;
  }
  return Object.freeze(selected);
}

function boundedText(value: string, maximumCharacters: number): string {
  return value.slice(0, maximumCharacters);
}

function retrievalQuery(
  snapshot: ImmutableCaseSnapshot,
  profile: AnalysisProfile,
): string {
  const maximum = profile.retrieval.maximumQueryCharacters;
  return boundedText(`${snapshot.title}\n${snapshot.summary}`, maximum);
}

function parsedStageResult(
  value: AnalysisEvidenceStageResult,
): AnalysisEvidenceStageResult {
  const operationIds = new Set<string>();
  for (const operationId of value.operationIds) {
    if (
      typeof operationId !== "string" ||
      operationId.length === 0 ||
      operationId.length > 200 ||
      operationIds.has(operationId)
    ) {
      throw new AnalysisOrchestrationError(
        "analysis.invalidEvidence",
        "Analysis stage returned invalid operation correlation.",
        false,
      );
    }
    operationIds.add(operationId);
  }
  return Object.freeze({
    evidence: validateEvidence(value.evidence),
    operationIds: Object.freeze([...value.operationIds]),
  });
}

export class AnalysisOrchestrator {
  public constructor(
    private readonly dependencies: AnalysisOrchestratorDependencies,
  ) {}

  public async execute(
    command: import("@caseweaver/domain").EnvelopeFor<"analysis.execute.v1">,
    signal: AbortSignal,
  ): Promise<AnalysisExecutionOutcome> {
    throwIfAborted(signal);
    const claimed = await this.dependencies.store.claim(command, signal);
    switch (claimed.kind) {
      case "completed":
        return { kind: "alreadyCompleted", resultId: claimed.resultId };
      case "alreadyRunning":
        return claimed;
      case "notFound":
        return claimed;
      case "claimed":
        return this.runClaimed(command, claimed.execution, signal);
    }
  }

  private async runClaimed(
    command: import("@caseweaver/domain").EnvelopeFor<"analysis.execute.v1">,
    execution: AnalysisExecution,
    signal: AbortSignal,
  ): Promise<AnalysisExecutionOutcome> {
    const stages: AnalysisStageStatus[] = [];
    const operations: string[] = [];
    try {
      const profile = analysisProfileSchema.parse(execution.profile);
      const snapshot = immutableCaseSnapshotSchema.parse(execution.snapshot);
      const initialEvidence = snapshotEvidence(snapshot);
      const attachments = await this.runOptionalStage(
        "attachments",
        profile.attachments.policy,
        stages,
        signal,
        () => this.dependencies.attachments.resolve({ execution, signal }),
      );
      const retrieval = await this.runOptionalStage(
        "retrieval",
        profile.retrieval.policy,
        stages,
        signal,
        () =>
          this.dependencies.retrieval.retrieve({
            execution,
            query: retrievalQuery(snapshot, profile),
            profileId: profile.retrieval.profileId,
            profileVersion: profile.retrieval.profileVersion,
            collectionIds: profile.retrieval.collectionIds,
            signal,
          }),
      );
      operations.push(...attachments.operationIds, ...retrieval.operationIds);
      const preRepositoryEvidence = validateEvidence([
        ...initialEvidence,
        ...attachments.evidence,
        ...retrieval.evidence,
      ]);
      const repository = await this.runRepositoryStage(
        execution,
        profile,
        snapshot,
        preRepositoryEvidence,
        stages,
        signal,
      );
      const evidence = validateEvidence([
        ...preRepositoryEvidence,
        ...repository.evidence,
      ]);
      operations.push(...repository.operationIds);
      throwIfAborted(signal);
      const promptBuilder = await this.dependencies.prompts.resolve({
        execution,
        signal,
      });
      const prompt = promptBuilder.build({
        template: profile.prompt.template,
        budgets: profile.prompt.budgets,
        context: promptContext(evidence),
      });
      stages.push(freezeStage("prompt", "completed"));
      const selectedIds = new Set(
        prompt.selectedEvidence.map((item) => item.id),
      );
      const selectedEvidence = evidence.filter((item) =>
        selectedIds.has(item.id),
      );
      const generated = await this.generate(
        execution,
        prompt.systemMessage,
        prompt.userMessage,
        profile,
        signal,
      );
      operations.push(generated.operationId);
      stages.push(freezeStage("generation", "completed"));
      const output = await this.validateOrRepair(
        execution,
        generated,
        prompt.systemMessage,
        profile,
        selectedIds,
        signal,
        operations,
      );
      stages.push(freezeStage("validation", "completed"));

      const resultId = analysisResultId(
        this.dependencies.ids.next("analysisResult"),
      );
      const occurredAt = this.dependencies.clock.now();
      const result: AnalysisResultRecord = Object.freeze({
        id: resultId,
        workspaceId: execution.workspaceId,
        analysisJobId: execution.analysisJobId,
        analysisIdentityId: execution.analysisIdentityId,
        analysisAttemptId: execution.analysisAttemptId,
        caseSnapshotId: snapshot.id,
        caseRevision: snapshot.revision,
        analysisProfileId: profile.id,
        analysisProfileVersion: profile.version,
        analysisBindingVersionId: profile.analysisBindingVersionId,
        promptTemplate: Object.freeze({ ...profile.prompt.template }),
        promptHash: prompt.promptHash,
        outputSchemaVersion: CASE_ANALYSIS_SCHEMA_VERSION,
        selectedEvidenceHashes: Object.freeze([
          ...prompt.selectedEvidenceHashes,
        ]),
        evidence: Object.freeze([...selectedEvidence]),
        output,
        stages: Object.freeze([...stages]),
        operationIds: Object.freeze([...operations]),
        createdAt: occurredAt,
      });
      const event = createEnvelope<"analysis.completed.v1">({
        id: outboxEnvelopeId(this.dependencies.ids.next("outboxEnvelope")),
        kind: "domainEvent",
        type: "analysis.completed.v1",
        schemaVersion: 1,
        workspaceId: command.workspaceId,
        occurredAt: utcInstant(occurredAt),
        correlationId: command.correlationId,
        causationId: causationId(command.id),
        payload: {
          analysisJobId: command.payload.analysisJobId,
          analysisResultId: resultId,
        },
      });
      await this.dependencies.store.complete(
        { execution, result, event },
        new AbortController().signal,
      );
      return { kind: "completed", resultId };
    } catch (error) {
      const details = errorDetails(error);
      const outcome =
        signal.aborted || details.code === "analysis.cancelled"
          ? "cancelled"
          : "failed";
      // A cancelled queue lease must not prevent recording the terminal durable
      // attempt. Completion has the same cancellation-proof boundary above.
      await this.dependencies.store.fail(
        {
          execution,
          outcome,
          stages: Object.freeze([...stages]),
          error: details,
        },
        new AbortController().signal,
      );
      throw error;
    }
  }

  private async runOptionalStage(
    stage: "attachments" | "retrieval",
    policy: "required" | "optional" | "disabled",
    stages: AnalysisStageStatus[],
    signal: AbortSignal,
    operation: () => Promise<AnalysisEvidenceStageResult>,
  ): Promise<AnalysisEvidenceStageResult> {
    if (policy === "disabled") {
      stages.push(freezeStage(stage, "skipped", policy));
      return { evidence: [], operationIds: [] };
    }
    try {
      throwIfAborted(signal);
      const result = parsedStageResult(await operation());
      stages.push(freezeStage(stage, "completed", policy));
      return result;
    } catch (error) {
      const failure = contextualError(stage, error);
      stages.push(
        freezeStage(stage, "failed", policy, {
          code: failure.code,
          retryable: failure.retryable,
        }),
      );
      if (policy === "required") throw failure;
      return { evidence: [], operationIds: [] };
    }
  }

  private async runRepositoryStage(
    execution: AnalysisExecution,
    profile: AnalysisProfile,
    snapshot: ImmutableCaseSnapshot,
    evidence: readonly AnalysisEvidence[],
    stages: AnalysisStageStatus[],
    signal: AbortSignal,
  ): Promise<AnalysisEvidenceStageResult> {
    const policy = profile.repository.policy;
    if (policy === "disabled") {
      stages.push(freezeStage("repository", "skipped", policy));
      return { evidence: [], operationIds: [] };
    }
    const repository = profile.repository;
    try {
      throwIfAborted(signal);
      const result = await this.dependencies.repository.investigate({
        execution,
        runtimeVersionId: repository.runtimeVersionId ?? "",
        bindingVersionId: repository.bindingVersionId ?? "",
        repositoryId: repository.repositoryId ?? "",
        pinnedCommit: repository.pinnedCommit ?? "",
        caseSummary: boundedText(
          snapshot.summary,
          repository.maximumContextCharacters,
        ),
        evidence: boundedEvidence(
          evidence,
          repository.maximumEvidenceCharacters,
        ),
        signal,
      });
      const parsed = parsedStageResult(result);
      const resultEvidence = parsed.evidence.filter(
        (item) =>
          item.kind === "repository" &&
          item.repositoryId === repository.repositoryId &&
          item.commit.toLowerCase() === repository.pinnedCommit?.toLowerCase(),
      );
      if (resultEvidence.length !== result.evidence.length) {
        throw new AnalysisOrchestrationError(
          "analysis.invalidEvidence",
          "Repository investigation returned evidence outside the configured pinned repository.",
          false,
        );
      }
      stages.push(freezeStage("repository", "completed", policy));
      return { evidence: resultEvidence, operationIds: parsed.operationIds };
    } catch (error) {
      const failure = contextualError("repository", error);
      stages.push(
        freezeStage("repository", "failed", policy, {
          code: failure.code,
          retryable: failure.retryable,
        }),
      );
      if (policy === "required") throw failure;
      return { evidence: [], operationIds: [] };
    }
  }

  private async generate(
    execution: AnalysisExecution,
    systemMessage: string,
    userMessage: string,
    profile: ReturnType<typeof analysisProfileSchema.parse>,
    signal: AbortSignal,
  ): Promise<MeteredAiResult<{ readonly text: string }>> {
    throwIfAborted(signal);
    return this.dependencies.ai.execute<{ readonly text: string }>(
      {
        kind: "generation",
        role: "analysis",
        bindingVersionId: profile.analysisBindingVersionId,
        analysisId: execution.analysisIdentityId,
        attribution: { analysisJobId: execution.analysisJobId },
        requiredCapabilities: ["structuredOutput"],
        maximumInputTokens: profile.generation.maximumInputTokens,
        maximumOutputTokens: profile.generation.maximumOutputTokens,
        ...(profile.generation.timeoutMs === undefined
          ? {}
          : { timeoutMs: profile.generation.timeoutMs }),
        budget: profile.generation.budget,
        request: {
          messages: [
            { role: "system", content: systemMessage },
            { role: "user", content: userMessage },
          ],
          maxOutputTokens: profile.generation.maximumOutputTokens,
          responseFormat: "jsonObject",
        },
      },
      { workspaceId: execution.workspaceId, signal },
    );
  }

  private async validateOrRepair(
    execution: AnalysisExecution,
    generated: MeteredAiResult<{ readonly text: string }>,
    systemMessage: string,
    profile: ReturnType<typeof analysisProfileSchema.parse>,
    evidenceIds: ReadonlySet<string>,
    signal: AbortSignal,
    operations: string[],
  ): Promise<import("@caseweaver/prompts").CaseAnalysisOutput> {
    let response = generated.value.text;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return validateAnalysisEvidence(
          parseCaseAnalysisOutput(response),
          evidenceIds,
        );
      } catch (error) {
        if (
          !(error instanceof PromptContractError) ||
          attempt >= profile.repair.maximumAttempts
        ) {
          throw contextualError("validation", error);
        }
        const repairInput = assertRepairInputBound(
          response,
          profile.repair.maximumInputCharacters,
        );
        const repaired = await this.generate(
          execution,
          systemMessage,
          [
            "Repair the following invalid analysis output.",
            "Return only a JSON object matching the original required schema.",
            `Invalid output data: ${JSON.stringify(repairInput)}`,
          ].join("\n\n"),
          profile,
          signal,
        );
        operations.push(repaired.operationId);
        response = repaired.value.text;
      }
    }
  }
}
