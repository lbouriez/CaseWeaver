import { createHash } from "node:crypto";

import type {
  AnalysisEvidence,
  AnalysisEvidenceStageResult,
  AnalysisExecution,
  RetrievalEvidencePort,
  SnapshotAttachmentReference,
  SnapshotAttachmentReferenceStore,
} from "@caseweaver/analysis";
import { snapshotAttachmentReferenceSchema } from "@caseweaver/analysis";
import type {
  RetrievalAccessScope,
  RetrievalEvidence,
  RetrievalFilterValue,
  RetrievalProfile,
  RetrievalRequest,
  RetrievalSnapshot,
} from "@caseweaver/retrieval";
import type { PrismaClient } from "@prisma/client";

interface AttachmentReferenceRow {
  readonly attachment_id: string;
  readonly attachment_derivative_id: string;
  readonly processor_version: string;
  readonly output_content_hash: string;
  readonly attachment_lifecycle: string | null;
  readonly attachment_retention_state: string | null;
  readonly derivative_status: string | null;
  readonly derivative_retention_state: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new PostgresAnalysisEvidenceAdapterError(
      "analysis.cancelled",
      "Analysis evidence resolution was cancelled.",
      false,
    );
  }
}

function opaqueKnowledgeUrl(evidence: RetrievalEvidence): string {
  const digest = sha256(
    [
      evidence.collectionId,
      evidence.sourceId,
      evidence.sourceRevisionId,
      evidence.chunkId,
    ].join(":"),
  );
  return `https://caseweaver.invalid/knowledge/${digest}`;
}

function retrievalEvidenceId(evidence: RetrievalEvidence): string {
  return `knowledge-${sha256(
    [
      evidence.collectionId,
      evidence.sourceId,
      evidence.sourceRevisionId,
      evidence.chunkId,
    ].join(":"),
  )}`;
}

function analysisEvidenceFromRetrieval(
  evidence: RetrievalEvidence,
): AnalysisEvidence {
  return {
    id: retrievalEvidenceId(evidence),
    kind: "knowledge",
    content: evidence.content,
    contentHash: sha256(evidence.content),
    // The original analysis contract calls this logical provenance field
    // `itemId`; hybrid retrieval exposes the immutable source identifier.
    // Retaining it avoids inventing a mutable lookup during execution.
    itemId: evidence.sourceId,
    revisionId: evidence.sourceRevisionId,
    chunkId: evidence.chunkId,
    // A source URL can carry credentials or signed query parameters. Results
    // retain opaque immutable provenance above and never echo that raw URL.
    sourceUrl: opaqueKnowledgeUrl(evidence),
  };
}

function sameMembers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

/** Stable redacted errors for production analysis evidence adapters. */
export class PostgresAnalysisEvidenceAdapterError extends Error {
  public constructor(
    public readonly code:
      | "analysis.cancelled"
      | "analysis.attachmentEvidenceUnavailable"
      | "analysis.retrievalRuntimeUnavailable"
      | "analysis.retrievalRuntimeMismatch",
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PostgresAnalysisEvidenceAdapterError";
  }
}

/**
 * Reads only append-only snapshot attachment references. The referenced
 * derivative must still be completed and retention-active; an expired or
 * missing captured reference fails closed rather than disappearing from a
 * required analysis. Actual text is opened separately by the PBI-008
 * server-private content reader.
 *
 * The required `case_snapshot_attachment_references` table is deliberately
 * introduced by the integration owner's forward migration. Its schema is
 * documented in the PostgreSQL README rather than guessed from mutable
 * attachment rows.
 */
export class PostgresSnapshotAttachmentReferenceStore
  implements SnapshotAttachmentReferenceStore
{
  public constructor(private readonly client: PrismaClient) {}

  public async listSnapshotAttachmentReferences(input: {
    readonly workspaceId: string;
    readonly caseSnapshotId: string;
    readonly signal: AbortSignal;
  }): Promise<readonly SnapshotAttachmentReference[]> {
    assertActive(input.signal);
    const rows = await this.client.$queryRaw<readonly AttachmentReferenceRow[]>`
      SELECT
        reference.attachment_id,
        reference.attachment_derivative_id,
        reference.processor_version,
        reference.output_content_hash,
        attachment.lifecycle AS attachment_lifecycle,
        attachment.retention_state AS attachment_retention_state,
        derivative.status AS derivative_status,
        derivative.retention_state AS derivative_retention_state
      FROM case_snapshot_attachment_references AS reference
      LEFT JOIN attachments AS attachment
        ON attachment.workspace_id = reference.workspace_id
       AND attachment.id = reference.attachment_id
      LEFT JOIN attachment_derivatives AS derivative
        ON derivative.workspace_id = reference.workspace_id
       AND derivative.id = reference.attachment_derivative_id
       AND derivative.processor_version = reference.processor_version
      WHERE reference.workspace_id = ${input.workspaceId}
        AND reference.case_snapshot_id = ${input.caseSnapshotId}
      ORDER BY reference.ordinal
    `;
    assertActive(input.signal);
    return Object.freeze(
      rows.map((row) => {
        if (
          row.attachment_lifecycle !== "accepted" ||
          row.attachment_retention_state !== "active" ||
          row.derivative_status !== "completed" ||
          row.derivative_retention_state !== "active"
        ) {
          throw new PostgresAnalysisEvidenceAdapterError(
            "analysis.attachmentEvidenceUnavailable",
            "Captured attachment evidence is no longer available.",
            false,
          );
        }
        return snapshotAttachmentReferenceSchema.parse({
          attachmentId: row.attachment_id,
          derivativeId: row.attachment_derivative_id,
          processorVersion: row.processor_version,
          outputContentHash: row.output_content_hash,
        });
      }),
    );
  }
}

export interface AnalysisRetrievalRuntime {
  readonly profile: RetrievalProfile;
  readonly access: RetrievalAccessScope;
  readonly metadataFilters?: Readonly<
    Record<string, readonly RetrievalFilterValue[]>
  >;
}

/**
 * Resolves the complete frozen retrieval runtime from the analysis profile
 * version. It must not query a current administration configuration.
 */
export interface AnalysisRetrievalRuntimeResolver {
  resolve(input: {
    readonly execution: AnalysisExecution;
    readonly profileId: string;
    readonly profileVersion: string;
    readonly collectionIds: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<AnalysisRetrievalRuntime>;
}

export interface PersistedRetrievalService {
  retrieve(request: RetrievalRequest): Promise<RetrievalSnapshot>;
}

/**
 * Creates a retrieval service after the exact immutable runtime profile has
 * been read. Hosts use this to resolve the tokenizer for every retained
 * binding before a provider call; there is deliberately no current/default
 * model path.
 */
export interface PersistedRetrievalServiceFactory {
  create(input: {
    readonly runtime: AnalysisRetrievalRuntime;
    readonly execution: AnalysisExecution;
    readonly signal: AbortSignal;
  }): Promise<PersistedRetrievalService>;
}

export interface AnalysisRetrievalEvidenceAdapterDependencies {
  readonly retrieval: PersistedRetrievalServiceFactory;
  readonly runtime: AnalysisRetrievalRuntimeResolver;
  readonly clock: { now(): string };
}

/**
 * Production bridge from the hybrid-retrieval feature to analysis. Its
 * injected `RetrievalService` must use the Postgres search/snapshot ports and
 * the exclusive AI-execution gateway; this adapter contains no provider call.
 */
export class PostgresAnalysisRetrievalEvidencePort
  implements RetrievalEvidencePort
{
  public constructor(
    private readonly dependencies: AnalysisRetrievalEvidenceAdapterDependencies,
  ) {}

  public async retrieve(input: {
    readonly execution: AnalysisExecution;
    readonly query: string;
    readonly profileId: string;
    readonly profileVersion: string;
    readonly collectionIds: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<AnalysisEvidenceStageResult> {
    assertActive(input.signal);
    let runtime: AnalysisRetrievalRuntime;
    try {
      runtime = await this.dependencies.runtime.resolve({
        execution: input.execution,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        collectionIds: input.collectionIds,
        signal: input.signal,
      });
    } catch (error) {
      if (error instanceof PostgresAnalysisEvidenceAdapterError) throw error;
      assertActive(input.signal);
      throw new PostgresAnalysisEvidenceAdapterError(
        "analysis.retrievalRuntimeUnavailable",
        "The immutable retrieval runtime is not available.",
        typeof error === "object" &&
          error !== null &&
          "retryable" in error &&
          error.retryable === true,
      );
    }
    assertActive(input.signal);
    if (
      runtime.profile.id !== input.profileId ||
      runtime.profile.version !== input.profileVersion ||
      !sameMembers(
        runtime.profile.collections.map((collection) => collection.id),
        input.collectionIds,
      )
    ) {
      throw new PostgresAnalysisEvidenceAdapterError(
        "analysis.retrievalRuntimeMismatch",
        "The resolved retrieval runtime does not match the immutable analysis profile.",
        false,
      );
    }

    const retrieval = await this.dependencies.retrieval.create({
      runtime,
      execution: input.execution,
      signal: input.signal,
    });
    assertActive(input.signal);
    const snapshot = await retrieval.retrieve({
      workspaceId: input.execution.workspaceId,
      query: input.query,
      profile: runtime.profile,
      access: runtime.access,
      ...(runtime.metadataFilters === undefined
        ? {}
        : { metadataFilters: runtime.metadataFilters }),
      snapshot: {
        id: `analysis-retrieval-${sha256(
          `${input.execution.analysisJobId}:${input.execution.analysisAttemptId}`,
        )}`,
        analysisId: input.execution.analysisIdentityId,
        capturedAt: this.dependencies.clock.now(),
      },
      attribution: { analysisJobId: input.execution.analysisJobId },
      signal: input.signal,
    });
    assertActive(input.signal);
    const operationIds = [
      ...Object.entries(snapshot.queryEmbeddingOperationIds)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, operationId]) => operationId),
      ...(snapshot.rerankerOperationId === undefined
        ? []
        : [snapshot.rerankerOperationId]),
    ];
    if (new Set(operationIds).size !== operationIds.length) {
      throw new PostgresAnalysisEvidenceAdapterError(
        "analysis.retrievalRuntimeMismatch",
        "The retrieval snapshot contains duplicate operation correlation.",
        false,
      );
    }
    return Object.freeze({
      evidence: Object.freeze(
        snapshot.evidence.map(analysisEvidenceFromRetrieval),
      ),
      operationIds: Object.freeze(operationIds),
    });
  }
}
