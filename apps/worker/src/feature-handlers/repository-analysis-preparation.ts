import type { AnalysisTriggerSubmissionPreparation } from "@caseweaver/application";
import {
  type ClaimedRepositoryAnalysisExecutionInput,
  PostgresRepositoryAnalysisExecutionInputStore,
} from "@caseweaver/postgres";

import { RepositoryAnalysisRunPinResolver } from "../modules/analysis/repository-analysis-run-pin.js";

function safeFailure(error: unknown): {
  readonly code: string;
  readonly retryable: boolean;
} {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "retryable" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9.]{2,199}$/u.test(error.code) &&
    typeof error.retryable === "boolean"
  ) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "analysis.executionInputPreparationFailed", retryable: true };
}

/**
 * Outer worker composition for a retained PBI-020 recipe. It resolves a full
 * repository commit before PBI-011 computes identity, while the PostgreSQL
 * store owns leases/fences and retains only safe immutable pins. A trigger
 * without a PBI-020 recipe deliberately falls through to the legacy flow.
 */
export class RuntimeRepositoryAnalysisPreparation
  implements AnalysisTriggerSubmissionPreparation
{
  public constructor(
    private readonly inputs: PostgresRepositoryAnalysisExecutionInputStore,
    private readonly repositories: RepositoryAnalysisRunPinResolver,
  ) {}

  public async prepare(
    command: Parameters<AnalysisTriggerSubmissionPreparation["prepare"]>[0],
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw signal.reason;
    const claimed = await this.inputs.claim(command);
    if (claimed.kind !== "claimed") return;
    await this.finalizeClaim(claimed.claim, signal);
  }

  private async finalizeClaim(
    claim: ClaimedRepositoryAnalysisExecutionInput,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (signal.aborted) throw signal.reason;
      const repositoryRun =
        claim.repository === undefined
          ? undefined
          : await this.repositories.resolve({
              workspaceId: claim.workspaceId,
              profile: claim.profile,
              runtimeVersionId: claim.repository.runtimeVersionId,
              signal,
            });
      if (signal.aborted) throw signal.reason;
      await this.inputs.finalize({ claim, ...(repositoryRun === undefined ? {} : { repositoryRun }) });
    } catch (error) {
      if (!signal.aborted) {
        await this.inputs.fail({ claim, error: safeFailure(error) });
      }
      throw error;
    }
  }
}
