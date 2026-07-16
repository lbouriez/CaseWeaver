import type {
  ApplicationTransaction,
  Clock,
  ResourceLeaseStore,
  UnitOfWork,
} from "@caseweaver/application";
import type {
  AnalysisDestination,
  ExternalReference,
  RenderedPublication,
} from "@caseweaver/connector-sdk";
import type {
  PublicationIntent,
  PublicationIntentId,
  UtcInstant,
  WorkspaceId,
} from "@caseweaver/domain";
import type { CaseAnalysisOutput } from "@caseweaver/prompts";

import type { PublicationProfile } from "./profiles.js";

export interface PublicationRenderer {
  render(input: {
    readonly analysis: CaseAnalysisOutput;
    readonly profile: PublicationProfile;
  }): RenderedPublication;
}

/**
 * The publication layer selects an adapter only from an immutable connector
 * configuration version. Composition owns descriptor registration and private
 * credential resolution; this port never receives settings or secret values.
 */
export interface PublicationDestinationResolver {
  resolve(input: {
    readonly workspaceId: WorkspaceId;
    readonly connectorRegistrationId: string;
    readonly connectorConfigurationVersionId: string;
    readonly signal: AbortSignal;
  }): Promise<AnalysisDestination | undefined>;
}

export interface PublicationCandidate {
  readonly intent: PublicationIntent;
  readonly analysisResultId: string;
  readonly identityHash: string;
  readonly marker: import("@caseweaver/connector-sdk").PublicationMarker;
  readonly analysis: CaseAnalysisOutput;
  readonly profile: PublicationProfile;
  readonly destination: Readonly<{
    readonly connectorRegistrationId: string;
    readonly connectorConfigurationVersionId: string;
  }>;
  readonly target: ExternalReference;
}

export interface PublicationAttempt {
  readonly id: string;
}

/**
 * `prepare` is called after a resource lease is acquired. It locks the
 * durable identity, records an attempt, and transitions the intent to
 * publishing in the same database transaction.
 */
export interface PublicationExecutionStore {
  findCandidate(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly publicationIntentId: PublicationIntentId;
    },
  ): Promise<PublicationCandidate | undefined>;
  prepare(
    transaction: ApplicationTransaction,
    input: {
      readonly candidate: PublicationCandidate;
      readonly identityHash: string;
      readonly marker: string;
      readonly allowOutcomeUnknown: boolean;
      readonly now: UtcInstant;
    },
  ): Promise<PublicationAttempt | undefined>;
  recordPublished(
    transaction: ApplicationTransaction,
    input: {
      readonly candidate: PublicationCandidate;
      readonly attempt: PublicationAttempt;
      readonly receipt: {
        readonly reference: ExternalReference;
        readonly marker: string;
        readonly requestId?: string;
      };
      readonly now: UtcInstant;
    },
  ): Promise<void>;
  recordOutcomeUnknown(
    transaction: ApplicationTransaction,
    input: {
      readonly candidate: PublicationCandidate;
      readonly attempt: PublicationAttempt;
      readonly now: UtcInstant;
    },
  ): Promise<void>;
  recordFailure(
    transaction: ApplicationTransaction,
    input: {
      readonly candidate: PublicationCandidate;
      readonly attempt: PublicationAttempt;
      readonly error: {
        readonly code: string;
        readonly retryable: boolean;
      };
      readonly now: UtcInstant;
    },
  ): Promise<void>;
  findOutcomeUnknown(
    transaction: ApplicationTransaction,
    input: { readonly workspaceId: WorkspaceId; readonly limit: number },
  ): Promise<readonly PublicationIntentId[]>;
}

export interface PublicationExecutionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: PublicationExecutionStore;
  readonly leases: ResourceLeaseStore;
  readonly destinations: PublicationDestinationResolver;
  readonly renderer: PublicationRenderer;
  readonly clock: Clock;
  readonly leaseMs: number;
}
