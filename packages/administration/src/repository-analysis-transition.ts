import type {
  TransitionAnalysisRecipeConfigurationCommand,
  TransitionAttachmentPolicyConfigurationCommand,
  TransitionCaseAnalysisScheduleConfigurationCommand,
  TransitionCaseAnalysisTriggerConfigurationCommand,
  TransitionCodeRepositoryConfigurationCommand,
  TransitionRepositoryExecutionPolicyConfigurationCommand,
} from "./repository-analysis-configuration.js";

/**
 * Server-private immutable material needed to create a successor lifecycle
 * version. This is intentionally a port rather than an administration DTO:
 * it can contain write-only settings and opaque credential-registration IDs,
 * and must never cross an HTTP/API/UI/log/audit boundary.
 */
export type RepositoryAnalysisTransitionSnapshot =
  | Readonly<{
      readonly resource: "code-repositories";
      readonly command: Omit<
        TransitionCodeRepositoryConfigurationCommand,
        "expectedRevision" | "lifecycle" | "mutation"
      >;
    }>
  | Readonly<{
      readonly resource: "repository-execution-policies";
      readonly command: Omit<
        TransitionRepositoryExecutionPolicyConfigurationCommand,
        "expectedRevision" | "lifecycle" | "mutation"
      >;
    }>
  | Readonly<{
      readonly resource: "attachment-policies";
      readonly command: Omit<
        TransitionAttachmentPolicyConfigurationCommand,
        "expectedRevision" | "lifecycle" | "mutation"
      >;
    }>
  | Readonly<{
      readonly resource: "analysis-recipes";
      readonly command: Omit<
        TransitionAnalysisRecipeConfigurationCommand,
        "expectedRevision" | "lifecycle" | "mutation"
      >;
    }>
  | Readonly<{
      readonly resource: "case-analysis-triggers";
      readonly command: Omit<
        TransitionCaseAnalysisTriggerConfigurationCommand,
        "expectedRevision" | "lifecycle" | "mutation"
      >;
    }>
  | Readonly<{
      readonly resource: "case-analysis-schedules";
      readonly command: Omit<
        TransitionCaseAnalysisScheduleConfigurationCommand,
        "expectedRevision" | "lifecycle" | "mutation"
      >;
    }>;

/**
 * Reads one workspace-scoped current immutable configuration privately for a
 * lifecycle transition. It must not fall back to another version or return a
 * partial projection.
 */
export interface RepositoryAnalysisTransitionSnapshotStore {
  resolveTransitionSnapshot(input: {
    readonly workspaceId: string;
    readonly resource: RepositoryAnalysisTransitionSnapshot["resource"];
    readonly configurationId: string;
  }): Promise<RepositoryAnalysisTransitionSnapshot | undefined>;
}
