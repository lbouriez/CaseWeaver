import type { AiExecutionGateway } from "@caseweaver/ai-execution";
import type { RepositoryRuntimeExecutionConfigurationResolver } from "@caseweaver/postgres";
import type {
  RepositoryChangeAuthor,
  RepositoryChangeDraft,
  RepositoryChangePlan,
} from "@caseweaver/repository-changes";

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

/**
 * The only model bridge for repository changes. It uses the existing immutable
 * repository execution policy and routes both architect and author calls through
 * the metered AI gateway.
 */
export class MeteredRepositoryChangeAuthor implements RepositoryChangeAuthor {
  public constructor(
    private readonly ai: AiExecutionGateway,
    private readonly runtime: RepositoryRuntimeExecutionConfigurationResolver,
  ) {}

  public async plan(
    input: Parameters<RepositoryChangeAuthor["plan"]>[0],
    signal: AbortSignal,
  ): Promise<RepositoryChangePlan> {
    const execution = await this.runtime.resolveExecution(
      input.repository.runtimePin,
      signal,
    );
    const result = await this.ai.execute<{
      readonly summary: string;
      readonly documentationImpact: string;
      readonly shouldChange: boolean;
    }>(
      {
        kind: "repositoryChange",
        role: "repositoryAgent",
        bindingVersionId: execution.execution.bindingVersionId,
        attribution: { analysisJobId: input.issue.analysisResultId },
        request: {
          runtimePin: input.repository.runtimePin,
          phase: "architect",
          instruction: bounded(
            [
              "Evaluate this confirmed support-analysis issue and create a small correction plan only when the configured branch contains direct evidence.",
              `Issue summary: ${input.issue.summary}`,
              `Diagnosis: ${input.issue.diagnosis}`,
              "Return shouldChange false when the evidence is insufficient, the correction is broad, or tests/dependencies/CI would need changes.",
            ].join("\n"),
            execution.execution.maximumInstructionCharacters,
          ),
          maximumTurns: Math.min(8, execution.execution.maximumTurns),
          maximumInputTokensPerTurn:
            execution.execution.maximumInputTokensPerTurn,
          maximumOutputTokensPerTurn:
            execution.execution.maximumOutputTokensPerTurn,
        },
        timeoutMs: execution.sandboxLimits.timeoutMs,
        budget: { ...execution.execution.budget },
      },
      { workspaceId: input.repository.runtimePin.workspaceId, signal },
    );
    return Object.freeze({ ...result.value });
  }

  public async author(
    input: Parameters<RepositoryChangeAuthor["author"]>[0],
    signal: AbortSignal,
  ): Promise<RepositoryChangeDraft | "no_change"> {
    const execution = await this.runtime.resolveExecution(
      input.repository.runtimePin,
      signal,
    );
    const result = await this.ai.execute<{
      readonly summary: string;
      readonly documentationImpact: string;
      readonly shouldChange: boolean;
      readonly title?: string;
      readonly description?: string;
      readonly files?: readonly {
        readonly path: string;
        readonly content: string;
      }[];
    }>(
      {
        kind: "repositoryChange",
        role: "repositoryAgent",
        bindingVersionId: execution.execution.bindingVersionId,
        attribution: { analysisJobId: input.issue.analysisResultId },
        request: {
          runtimePin: input.repository.runtimePin,
          phase: "author",
          instruction: bounded(
            [
              "Implement the approved narrow correction as complete replacement contents for the smallest directly evidenced text files.",
              `Issue: ${input.issue.summary}`,
              `Architect plan: ${input.plan.summary}`,
              `Documentation impact: ${input.plan.documentationImpact}`,
              "The draft PR must state that target-repository tests were not run. Do not change CI, dependencies, lockfiles, or generated files.",
            ].join("\n"),
            execution.execution.maximumInstructionCharacters,
          ),
          maximumTurns: Math.min(8, execution.execution.maximumTurns),
          maximumInputTokensPerTurn:
            execution.execution.maximumInputTokensPerTurn,
          maximumOutputTokensPerTurn:
            execution.execution.maximumOutputTokensPerTurn,
        },
        timeoutMs: execution.sandboxLimits.timeoutMs,
        budget: { ...execution.execution.budget },
      },
      { workspaceId: input.repository.runtimePin.workspaceId, signal },
    );
    const value = result.value;
    if (
      !value.shouldChange ||
      value.title === undefined ||
      value.description === undefined ||
      value.files === undefined
    ) {
      return "no_change";
    }
    return Object.freeze({
      title: value.title,
      description: value.description,
      files: Object.freeze(
        value.files.map((file) => Object.freeze({ ...file })),
      ),
    });
  }
}
