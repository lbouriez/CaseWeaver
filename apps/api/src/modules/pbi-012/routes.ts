import type {
  ExecutionContext,
  RequestAnalysisWithPublicationCommand,
} from "@caseweaver/application";
import {
  analysisProfileVersionId,
  caseSnapshotId,
  publicationIntentId,
  sha256Digest,
} from "@caseweaver/domain";
import { withOpenTelemetrySpan } from "@caseweaver/observability";
import { z } from "zod";

import type { ApiInstance } from "../../app.js";

const identifier = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-fA-F0-9]{64}$/u);

const requestSchema = z
  .object({
    idempotencyKeyDigest: digest,
    requestDigest: digest,
    identityHash: digest,
    analysisProfileVersionId: identifier,
    caseSnapshotId: identifier,
    publication: z
      .object({
        profileId: identifier,
        profileVersion: identifier,
        target: z
          .object({
            connectorInstanceId: identifier,
            resourceType: identifier,
            externalId: identifier,
          })
          .strict(),
        intentHash: digest,
        dryRun: z.boolean().default(false),
      })
      .strict(),
  })
  .strict();

const approvalParametersSchema = z
  .object({ publicationIntentId: identifier })
  .strict();

export interface ApiExecutionContextResolver {
  /**
   * Authentication is composed outside this module. In particular, route
   * headers and bodies are never converted to a principal here.
   */
  resolve(request: unknown): Promise<ExecutionContext>;
}

export interface Pbi012ApiOperations {
  requestAnalysis(
    command: RequestAnalysisWithPublicationCommand,
    context: ExecutionContext,
  ): Promise<{
    readonly analysisJobId: string;
    readonly publicationIntentId?: string;
    readonly replayed: boolean;
    readonly preview: boolean;
  }>;
  approvePublication(
    intentId: ReturnType<typeof publicationIntentId>,
    context: ExecutionContext,
  ): Promise<{ readonly approved: boolean; readonly replayed: boolean }>;
}

export function registerPbi012Routes(
  app: ApiInstance,
  dependencies: {
    readonly context: ApiExecutionContextResolver;
    readonly operations: Pbi012ApiOperations;
  },
): void {
  app.post("/v1/analysis-publications", async (request, reply) => {
    const body = requestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ code: "request.invalid" });
    }
    return withOpenTelemetrySpan(
      "caseweaver.api.analysis_publication",
      {},
      async () => {
        const context = await dependencies.context.resolve(request);
        const result = await dependencies.operations.requestAnalysis(
          {
            idempotencyKeyDigest: sha256Digest(body.data.idempotencyKeyDigest),
            requestDigest: sha256Digest(body.data.requestDigest),
            identityHash: sha256Digest(body.data.identityHash),
            analysisProfileVersionId: analysisProfileVersionId(
              body.data.analysisProfileVersionId,
            ),
            caseSnapshotId: caseSnapshotId(body.data.caseSnapshotId),
            publication: {
              ...body.data.publication,
              intentHash: sha256Digest(body.data.publication.intentHash),
            },
          },
          context,
        );
        return reply.status(202).send(result);
      },
    );
  });

  app.post(
    "/v1/publication-intents/:publicationIntentId/approval",
    async (request, reply) => {
      const parameters = approvalParametersSchema.safeParse(request.params);
      if (!parameters.success) {
        return reply.status(404).send({ code: "publication.notFound" });
      }
      return withOpenTelemetrySpan(
        "caseweaver.api.publication_approval",
        {},
        async () => {
          const context = await dependencies.context.resolve(request);
          const result = await dependencies.operations.approvePublication(
            publicationIntentId(parameters.data.publicationIntentId),
            context,
          );
          return reply.status(result.approved ? 202 : 404).send(result);
        },
      );
    },
  );
}
