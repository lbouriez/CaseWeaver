import type { Permission } from "@caseweaver/security";

/** Stable, transport-neutral names. HTTP route construction belongs to apps/api. */
export const administrationResources = [
  "overview",
  "secret-references",
  "connector-instances",
  "knowledge-sources",
  "schedules",
  "publication-profiles",
  "webhook-endpoints",
  "ai-provider-instances",
  "ai-catalog-snapshots",
  "ai-models",
  "ai-bindings",
  "ai-role-defaults",
  "ai-pricing-overrides",
  "ai-budgets",
  "collections",
  "retrieval-profiles",
  "prompt-profiles",
  "analysis-profiles",
  "analysis-recipes",
  "code-repositories",
  "repository-execution-policies",
  "attachment-policies",
  "case-analysis-triggers",
  "case-analysis-schedules",
  "analyses",
  "publications",
  "operation-jobs",
  "dead-letters",
  "costs",
  "retention",
  "privacy",
  "diagnostics",
  "audit-events",
  "workspaces",
  "principals",
  "role-assignments",
  "platform",
] as const;

export type AdministrationResource = (typeof administrationResources)[number];

export const administrationActions = [
  "connector.test",
  "connector.activate",
  "connector.disable",
  "provider.test",
  "provider.activate",
  "provider.disable",
  "repository.test",
  "repository.activate",
  "repository.disable",
  "repository-execution-policy.activate",
  "repository-execution-policy.disable",
  "attachment-policy.activate",
  "attachment-policy.disable",
  "analysis-recipe.activate",
  "analysis-recipe.disable",
  "case-analysis-trigger.activate",
  "case-analysis-trigger.disable",
  "case-analysis-schedule.activate",
  "case-analysis-schedule.disable",
  "source.synchronize",
  "source.fullRescan",
  "dead-letter.retry",
  "job.cancel",
  "job.recover",
  "retention.reap",
  "privacy.purge",
  "diagnostics.export",
  "secret.rotate",
  "secret.revoke",
  "publication.approve",
] as const;

export type AdministrationAction = (typeof administrationActions)[number];

export interface CursorPageDto<T> {
  readonly items: readonly T[];
  readonly page: Readonly<{
    readonly hasNextPage: boolean;
    readonly endCursor?: string;
  }>;
}

/** Deliberately small, redacted list representation for the generic operator UI. */
export interface AdministrationListItemDto {
  readonly id: string;
  readonly label: string;
  readonly status?: string;
  readonly version?: string;
  readonly updatedAt?: string;
  readonly summary?: string;
}

export interface AdministrationDetailDto extends AdministrationListItemDto {
  /** Values are scalar and pre-redacted; detailed settings need resource-specific DTOs. */
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AdministrationListQuery {
  readonly limit: number;
  readonly after?: string;
  readonly sort?: string;
  readonly direction: "ASC" | "DESC";
  readonly filters?: Readonly<Record<string, string | number | boolean>>;
}

export interface WorkspaceMembershipDto {
  readonly id: string;
  readonly name: string;
}

export type AdministrationSessionDto =
  | Readonly<{
      readonly authenticated: false;
      /** Deployment-owned sign-in methods; credential values are never exposed. */
      readonly authentication: Readonly<{
        readonly password: boolean;
        readonly oauth: boolean;
      }>;
    }>
  | Readonly<{
      readonly authenticated: true;
      readonly principal: Readonly<{
        readonly id: string;
        readonly displayName: string;
      }>;
      readonly activeWorkspace: WorkspaceMembershipDto;
      readonly workspaces: readonly WorkspaceMembershipDto[];
      readonly permissions: readonly Permission[];
      /** Per-session request token; never persist in browser storage. */
      readonly csrfToken: string;
      readonly expiresAt: string;
    }>;

export interface DescriptorDraftCommand {
  readonly descriptorType: string;
  readonly displayName: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly expectedRevision?: number;
}

/**
 * An opaque locator in the deployment-managed secret backend. This is not a
 * credential value and is never included in an administration response.
 */
export interface SecretReferenceRegistrationCommand {
  readonly reference: string;
}

export interface ActionPreviewDto {
  readonly previewId: string;
  readonly action: AdministrationAction;
  readonly confirmation: string;
  readonly impact: string;
  readonly canConfirm: boolean;
  readonly estimatedCost?: Readonly<{
    readonly amount: string;
    readonly currency: string;
  }>;
  readonly expiresAt: string;
}

export interface ActionOutcomeDto {
  readonly operationId: string;
  readonly outcome: "accepted" | "completed" | "outcome_unknown";
  readonly message: string;
}

export interface AdministrationRequestMetadata {
  readonly requestId: string;
  readonly correlationId: string;
  readonly uiActionId?: string;
  readonly idempotencyKey?: string;
  readonly requestMode: "user" | "passive_poll";
}
