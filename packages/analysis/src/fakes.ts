import type {
  AiExecutionContext,
  AiExecutionGateway,
  MeteredAiRequest,
  MeteredAiResult,
} from "@caseweaver/ai-execution";
import type { EnvelopeFor } from "@caseweaver/domain";

import type {
  AnalysisClock,
  AnalysisEvidence,
  AnalysisExecution,
  AnalysisExecutionStore,
  AnalysisIdGenerator,
  AnalysisResultRecord,
  AnalysisStageStatus,
  AttachmentEvidencePort,
  RepositoryInvestigationPort,
  RetrievalEvidencePort,
} from "./contracts.js";

export class FixedAnalysisClock implements AnalysisClock {
  public constructor(private readonly instant = "2026-07-14T15:00:00.000Z") {}

  public now(): string {
    return this.instant;
  }
}

export class SequentialAnalysisIds implements AnalysisIdGenerator {
  private sequence = 0;

  public next(kind: "analysisResult" | "outboxEnvelope"): string {
    this.sequence += 1;
    return `${kind}-${this.sequence}`;
  }
}

export class InMemoryAnalysisExecutionStore implements AnalysisExecutionStore {
  private readonly executions = new Map<string, AnalysisExecution>();
  private readonly running = new Set<string>();
  public readonly results = new Map<string, AnalysisResultRecord>();
  public readonly events: EnvelopeFor<"analysis.completed.v1">[] = [];
  public readonly failures: {
    readonly execution: AnalysisExecution;
    readonly outcome: "failed" | "cancelled";
    readonly stages: readonly AnalysisStageStatus[];
    readonly error: { readonly code: string; readonly retryable: boolean };
  }[] = [];

  public seed(execution: AnalysisExecution): void {
    this.executions.set(execution.analysisJobId, execution);
  }

  public async claim(
    command: EnvelopeFor<"analysis.execute.v1">,
    _signal: AbortSignal,
  ): Promise<
    | { readonly kind: "claimed"; readonly execution: AnalysisExecution }
    | { readonly kind: "completed"; readonly resultId: string }
    | { readonly kind: "alreadyRunning" }
    | { readonly kind: "notFound" }
  > {
    const execution = this.executions.get(command.payload.analysisJobId);
    if (
      execution === undefined ||
      execution.workspaceId !== command.workspaceId ||
      execution.analysisIdentityId !== command.payload.analysisIdentityId
    ) {
      return { kind: "notFound" };
    }
    const completed = [...this.results.values()].find(
      (result) => result.analysisJobId === execution.analysisJobId,
    );
    if (completed !== undefined)
      return { kind: "completed", resultId: completed.id };
    if (this.running.has(execution.analysisJobId))
      return { kind: "alreadyRunning" };
    this.running.add(execution.analysisJobId);
    return { kind: "claimed", execution };
  }

  public async complete(
    input: {
      readonly execution: AnalysisExecution;
      readonly result: AnalysisResultRecord;
      readonly event: EnvelopeFor<"analysis.completed.v1">;
    },
    _signal: AbortSignal,
  ): Promise<void> {
    if (!this.running.delete(input.execution.analysisJobId)) {
      throw new Error("Analysis execution was not claimed.");
    }
    this.results.set(input.result.id, input.result);
    this.events.push(input.event);
  }

  public async fail(
    input: {
      readonly execution: AnalysisExecution;
      readonly outcome: "failed" | "cancelled";
      readonly stages: readonly AnalysisStageStatus[];
      readonly error: { readonly code: string; readonly retryable: boolean };
    },
    _signal: AbortSignal,
  ): Promise<void> {
    this.running.delete(input.execution.analysisJobId);
    this.failures.push(input);
  }
}

export class StaticAttachmentEvidencePort implements AttachmentEvidencePort {
  public constructor(
    private readonly evidence: readonly AnalysisEvidence[],
    private readonly failure?: Error,
    private readonly operationIds: readonly string[] = [],
  ) {}

  public async resolve(): Promise<{
    readonly evidence: readonly AnalysisEvidence[];
    readonly operationIds: readonly string[];
  }> {
    if (this.failure !== undefined) throw this.failure;
    return { evidence: this.evidence, operationIds: this.operationIds };
  }
}

export class StaticRetrievalEvidencePort implements RetrievalEvidencePort {
  public constructor(
    private readonly evidence: readonly AnalysisEvidence[],
    private readonly failure?: Error,
    private readonly operationIds: readonly string[] = [],
  ) {}

  public async retrieve(): Promise<{
    readonly evidence: readonly AnalysisEvidence[];
    readonly operationIds: readonly string[];
  }> {
    if (this.failure !== undefined) throw this.failure;
    return { evidence: this.evidence, operationIds: this.operationIds };
  }
}

export class DeterministicRepositoryInvestigationPort
  implements RepositoryInvestigationPort
{
  public constructor(
    private readonly result: {
      readonly summary: string;
      readonly evidence: readonly AnalysisEvidence[];
      readonly operationIds: readonly string[];
    } = { summary: "", evidence: [], operationIds: [] },
    private readonly failure?: Error,
  ) {}

  public async investigate(): Promise<{
    readonly summary: string;
    readonly evidence: readonly AnalysisEvidence[];
    readonly operationIds: readonly string[];
  }> {
    if (this.failure !== undefined) throw this.failure;
    return this.result;
  }
}

export class DeterministicAnalysisAiGateway implements AiExecutionGateway {
  public readonly calls: MeteredAiRequest[] = [];

  public constructor(private readonly responses: readonly unknown[]) {}

  public async execute<TResult = unknown>(
    request: MeteredAiRequest,
    _context: AiExecutionContext,
  ): Promise<MeteredAiResult<TResult>> {
    this.calls.push(request);
    const response = this.responses[this.calls.length - 1];
    if (response instanceof Error) throw response;
    return {
      operationId: `operation-${this.calls.length}`,
      value: response as TResult,
      calculatedCost: { status: "unknown", components: [] },
    };
  }
}
