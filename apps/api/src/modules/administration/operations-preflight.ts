import type { OperationsStore, UnitOfWork } from "@caseweaver/application";
import type { AdministrationOperationPreflightPort } from "@caseweaver/administration";
import { workspaceId } from "@caseweaver/domain";
import type { AdministrationReadStore } from "@caseweaver/postgres";

/** Implemented by the persistence composition with a workspace-scoped lookup.
 * It returns only existence so a preview cannot disclose protected snapshots. */
export interface PrivacyPurgeTargetReader {
  exists(
    input: Readonly<{
      readonly workspaceId: string;
      readonly caseSnapshotId: string;
    }>,
  ): Promise<boolean>;
}

/**
 * Read-only eligibility checks supplied by the feature-owned stores. A preview
 * is advisory and race-safe: the command use case makes the final decision in
 * its own transaction and reports an ineligible result without fabricating work.
 */
export class ExistingOperationsPreflight
  implements AdministrationOperationPreflightPort
{
  public constructor(
    private readonly dependencies: Readonly<{
      readonly unitOfWork: UnitOfWork;
      readonly operations: OperationsStore;
      readonly reads: AdministrationReadStore;
      readonly privacyTargets?: PrivacyPurgeTargetReader;
      readonly now?: () => Date;
    }>,
  ) {}

  public async preview(
    input: Parameters<AdministrationOperationPreflightPort["preview"]>[0],
  ) {
    const command = input.command;
    switch (command.action) {
      case "deadLetter.retry": {
        const id = command.target.id as string;
        const records = await this.dependencies.unitOfWork.transaction(
          (transaction) =>
            this.dependencies.operations.inspectDeadLetters(transaction, {
              workspaceId: workspaceId(input.context.workspaceId),
              limit: 100,
            }),
        );
        const record = records.find((candidate) => candidate.jobId === id);
        return Object.freeze(
          record === undefined
            ? {
                confirmation: "Dead letter is no longer eligible for retry.",
                impact:
                  "No replacement job will be submitted unless a retryable failed job is still present.",
                canConfirm: false,
              }
            : {
                confirmation: "Retry this failed analysis job?",
                impact:
                  "A single replacement analysis job will be queued using the immutable inputs of the failed job.",
                canConfirm: record.retryable,
              },
        );
      }
      case "job.cancel":
      case "job.recover": {
        const id = command.target.id as string;
        const job = await this.dependencies.reads.operationJob({
          workspaceId: input.context.workspaceId,
          id,
        });
        const now = (this.dependencies.now ?? (() => new Date()))().getTime();
        const recoverable =
          job?.state === "running" &&
          job.runningLeaseExpiresAt !== undefined &&
          new Date(job.runningLeaseExpiresAt).getTime() <= now;
        const cancellable = job?.state === "queued" || job?.state === "running";
        const canConfirm =
          command.action === "job.cancel" ? cancellable : recoverable;
        return Object.freeze({
          confirmation:
            command.action === "job.cancel"
              ? "Cancel this analysis job?"
              : "Recover this expired analysis job?",
          impact:
            command.action === "job.cancel"
              ? "Queued or running work will be marked cancelled; completed immutable results are unchanged."
              : "Only a running job with an expired lease can be fenced and returned to the queue.",
          canConfirm,
        });
      }
      case "retention.reap":
        return Object.freeze({
          confirmation: "Queue bounded expired retention work?",
          impact:
            "At most the server-authorized bounded batch will be queued; protected content is neither read nor returned.",
          canConfirm: true,
        });
      case "knowledgeSource.synchronize":
      case "knowledgeSource.fullRescan": {
        const source = await this.dependencies.reads.knowledgeSource({
          workspaceId: input.context.workspaceId,
          id: command.target.id as string,
        });
        const fullRescan = command.action === "knowledgeSource.fullRescan";
        return Object.freeze({
          confirmation: fullRescan
            ? "Queue a bounded full rescan for this knowledge source?"
            : "Queue a synchronization for this knowledge source?",
          impact:
            source?.lifecycle === "enabled"
              ? fullRescan
                ? "The worker will receive the current immutable source configuration. The server enforces a full-rescan cooldown and no connector or model call occurs in this request."
                : "The worker will receive the current immutable source configuration. No connector or model call occurs in this request."
              : "The knowledge source is not available in this workspace.",
          canConfirm: source?.lifecycle === "enabled",
        });
      }
      case "privacy.purge": {
        const exists =
          this.dependencies.privacyTargets === undefined
            ? false
            : await this.dependencies.privacyTargets.exists({
                workspaceId: input.context.workspaceId,
                caseSnapshotId: command.target.id as string,
              });
        return Object.freeze({
          confirmation: "Purge this case snapshot for privacy?",
          impact: exists
            ? "The existing privacy workflow will tombstone governed snapshot content and queue eligible retained objects. The supplied reason is not shown or recorded in audit details."
            : "The case snapshot is unavailable in this workspace, so no purge will be submitted.",
          canConfirm: exists,
        });
      }
      case "publication.approve": {
        const publication = await this.dependencies.reads.publicationIntent({
          workspaceId: input.context.workspaceId,
          id: command.target.id as string,
        });
        const canConfirm = publication?.state === "awaitingApproval";
        return Object.freeze({
          confirmation: "Approve this publication intent?",
          impact: canConfirm
            ? "The existing publication intent will become eligible for delivery. Its immutable profile and analysis references are unchanged."
            : "The publication intent is no longer awaiting approval, so no delivery will be requested.",
          canConfirm,
        });
      }
      case "secret.rotate": {
        const dependencies =
          await this.dependencies.reads.secretReferenceDependencies({
            workspaceId: input.context.workspaceId,
            secretReferenceId: command.target.id as string,
          });
        return Object.freeze({
          confirmation: "Mark this secret reference for rotation?",
          impact:
            dependencies.length === 0
              ? "The server will mark only opaque reference metadata as rotation-required. No secret value is requested, read, logged, or returned."
              : `The server will mark opaque metadata as rotation-required. ${dependencySummary(dependencies)} will require an active replacement before activation. No secret value is requested, read, logged, or returned.`,
          canConfirm: true,
        });
      }
      case "secret.revoke": {
        const dependencies =
          await this.dependencies.reads.secretReferenceDependencies({
            workspaceId: input.context.workspaceId,
            secretReferenceId: command.target.id as string,
          });
        return Object.freeze({
          confirmation: "Revoke this secret reference?",
          impact:
            dependencies.length === 0
              ? "The server will disable the opaque reference for future configuration use. Existing immutable history remains unchanged."
              : `The server will disable the opaque reference for future configuration use. ${dependencySummary(dependencies)} will no longer be activatable until a replacement is configured. Existing immutable history remains unchanged.`,
          canConfirm: true,
        });
      }
      case "configuration.activate":
      case "configuration.disable": {
        const resourceType =
          "resourceType" in command.parameters
            ? command.parameters.resourceType
            : undefined;
        const configuration =
          resourceType === undefined
            ? undefined
            : await this.dependencies.reads.configuration({
                workspaceId: input.context.workspaceId,
                id: command.target.id as string,
              });
        const matches =
          configuration !== undefined &&
          configuration.resourceType === resourceType;
        const lifecycle =
          command.action === "configuration.activate" ? "active" : "disabled";
        return Object.freeze({
          confirmation:
            command.action === "configuration.activate"
              ? "Activate this immutable configuration version?"
              : "Disable this configuration?",
          impact: matches
            ? "The server will create a new immutable lifecycle version. Existing jobs retain their prior configuration reference."
            : "The configuration is no longer available in this workspace.",
          canConfirm: matches && configuration.lifecycle !== lifecycle,
        });
      }
      default:
        return Object.freeze({
          confirmation: "This operation is unavailable.",
          impact: "No operation will be submitted.",
          canConfirm: false,
        });
    }
  }
}

function dependencySummary(
  values: readonly Readonly<{
    configurationId: string;
    resourceType: string;
  }>[],
): string {
  const listed = values
    .slice(0, 5)
    .map((value) => `${value.resourceType}/${value.configurationId}`)
    .join(", ");
  return values.length > 5
    ? `${listed}, and ${values.length - 5} more configuration dependencies`
    : `Dependent configurations: ${listed}`;
}
