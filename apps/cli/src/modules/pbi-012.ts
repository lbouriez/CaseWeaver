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
import { z } from "zod";

import type { CliOutput } from "../main.js";

const identifier = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-fA-F0-9]{64}$/u);

const analysisCommandSchema = z
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

export interface Pbi012CliOperations {
  readonly context: ExecutionContext;
  requestAnalysis(
    command: RequestAnalysisWithPublicationCommand,
    context: ExecutionContext,
  ): Promise<unknown>;
  approvePublication(
    intentId: ReturnType<typeof publicationIntentId>,
    context: ExecutionContext,
  ): Promise<unknown>;
}

/**
 * The command context is injected by trusted local composition; workspace and
 * principal values are not accepted as CLI arguments.
 */
export async function runPbi012Cli(
  arguments_: readonly string[],
  output: CliOutput,
  operations: Pbi012CliOperations,
): Promise<number> {
  if (arguments_[0] === "analyze" && arguments_.length === 2) {
    let input: unknown;
    try {
      input = JSON.parse(arguments_[1] ?? "");
    } catch {
      output.error("Analysis request JSON is invalid.");
      return 1;
    }
    const parsed = analysisCommandSchema.safeParse(input);
    if (!parsed.success) {
      output.error("Analysis request JSON is invalid.");
      return 1;
    }
    const command: RequestAnalysisWithPublicationCommand = {
      idempotencyKeyDigest: sha256Digest(parsed.data.idempotencyKeyDigest),
      requestDigest: sha256Digest(parsed.data.requestDigest),
      identityHash: sha256Digest(parsed.data.identityHash),
      analysisProfileVersionId: analysisProfileVersionId(
        parsed.data.analysisProfileVersionId,
      ),
      caseSnapshotId: caseSnapshotId(parsed.data.caseSnapshotId),
      publication: {
        ...parsed.data.publication,
        intentHash: sha256Digest(parsed.data.publication.intentHash),
      },
    };
    output.log(
      JSON.stringify(
        await operations.requestAnalysis(command, operations.context),
      ),
    );
    return 0;
  }
  if (arguments_[0] === "approve" && arguments_.length === 2) {
    const id = arguments_[1];
    if (id === undefined || !identifier.safeParse(id).success) {
      output.error("Publication intent ID is invalid.");
      return 1;
    }
    output.log(
      JSON.stringify(
        await operations.approvePublication(
          publicationIntentId(id),
          operations.context,
        ),
      ),
    );
    return 0;
  }
  output.error(
    "Usage: caseweaver analyze <request-json> | approve <publication-intent-id>",
  );
  return 1;
}
