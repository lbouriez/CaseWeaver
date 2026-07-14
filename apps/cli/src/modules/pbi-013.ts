import type { ExecutionContext } from "@caseweaver/application";
import {
  analysisJobId,
  caseSnapshotId,
  sha256Digest,
  utcInstant,
} from "@caseweaver/domain";
import { z } from "zod";

import type { CliOutput } from "../main.js";

const identifier = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-fA-F0-9]{64}$/u);
const mutationSchema = z
  .object({ idempotencyKeyDigest: digest, requestDigest: digest })
  .strict();

interface Mutation {
  readonly idempotencyKeyDigest: ReturnType<typeof sha256Digest>;
  readonly requestDigest: ReturnType<typeof sha256Digest>;
}

export interface Pbi013CliOperations {
  readonly context: ExecutionContext;
  inspectDeadLetters(
    limit: number,
    context: ExecutionContext,
  ): Promise<unknown>;
  retryDeadLetter(
    jobId: ReturnType<typeof analysisJobId>,
    mutation: Mutation,
    context: ExecutionContext,
  ): Promise<unknown>;
  cancelJob(
    jobId: ReturnType<typeof analysisJobId>,
    mutation: Mutation,
    context: ExecutionContext,
  ): Promise<unknown>;
  recoverExpiredJob(
    jobId: ReturnType<typeof analysisJobId>,
    mutation: Mutation,
    context: ExecutionContext,
  ): Promise<unknown>;
  queryCosts(
    query: {
      readonly analysisJobId?: ReturnType<typeof analysisJobId>;
      readonly connectorInstanceId?: string;
      readonly role?: string;
      readonly startedAfter?: ReturnType<typeof utcInstant>;
      readonly startedBefore?: ReturnType<typeof utcInstant>;
      readonly limit: number;
    },
    context: ExecutionContext,
  ): Promise<unknown>;
  purgeCaseSnapshot(
    id: ReturnType<typeof caseSnapshotId>,
    reason: string,
    mutation: Mutation,
    context: ExecutionContext,
  ): Promise<unknown>;
  queueRetention(
    mutation: Mutation,
    context: ExecutionContext,
    limit: number,
  ): Promise<unknown>;
}

export function isPbi013Command(command: string | undefined): boolean {
  return (
    command === "dead-letters" ||
    command === "retry" ||
    command === "cancel" ||
    command === "recover" ||
    command === "costs" ||
    command === "purge-case" ||
    command === "retention-reap"
  );
}

function parseJson(value: string | undefined): unknown | undefined {
  try {
    return value === undefined ? undefined : JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseMutation(value: unknown): Mutation | undefined {
  const parsed = mutationSchema.safeParse(value);
  return parsed.success
    ? {
        idempotencyKeyDigest: sha256Digest(parsed.data.idempotencyKeyDigest),
        requestDigest: sha256Digest(parsed.data.requestDigest),
      }
    : undefined;
}

/**
 * Context is composed by the local trusted CLI bootstrap. IDs and principals
 * are never accepted from command arguments.
 */
export async function runPbi013Cli(
  arguments_: readonly string[],
  output: CliOutput,
  operations: Pbi013CliOperations,
): Promise<number> {
  const [command, first, second] = arguments_;
  if (command === "dead-letters" && arguments_.length <= 2) {
    const limit = first === undefined ? 50 : Number(first);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      output.error("Dead-letter limit is invalid.");
      return 1;
    }
    output.log(
      JSON.stringify(
        await operations.inspectDeadLetters(limit, operations.context),
      ),
    );
    return 0;
  }
  if (
    (command === "retry" || command === "cancel" || command === "recover") &&
    arguments_.length === 3 &&
    first !== undefined
  ) {
    if (!identifier.safeParse(first).success) {
      output.error("Analysis job ID is invalid.");
      return 1;
    }
    const action = parseMutation(parseJson(second));
    if (action === undefined) {
      output.error("Operational mutation JSON is invalid.");
      return 1;
    }
    const jobId = analysisJobId(first);
    const operation =
      command === "retry"
        ? operations.retryDeadLetter(jobId, action, operations.context)
        : command === "cancel"
          ? operations.cancelJob(jobId, action, operations.context)
          : operations.recoverExpiredJob(jobId, action, operations.context);
    output.log(JSON.stringify(await operation));
    return 0;
  }
  if (command === "costs" && arguments_.length === 2) {
    const input = parseJson(first);
    const parsed = z
      .object({
        analysisJobId: identifier.optional(),
        connectorInstanceId: identifier.optional(),
        role: identifier.optional(),
        startedAfter: z
          .string()
          .datetime({ offset: true })
          .endsWith("Z")
          .optional(),
        startedBefore: z
          .string()
          .datetime({ offset: true })
          .endsWith("Z")
          .optional(),
        limit: z.number().int().min(1).max(1_000).default(100),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success) {
      output.error("Cost query JSON is invalid.");
      return 1;
    }
    output.log(
      JSON.stringify(
        await operations.queryCosts(
          {
            ...(parsed.data.analysisJobId === undefined
              ? {}
              : { analysisJobId: analysisJobId(parsed.data.analysisJobId) }),
            ...(parsed.data.connectorInstanceId === undefined
              ? {}
              : { connectorInstanceId: parsed.data.connectorInstanceId }),
            ...(parsed.data.role === undefined
              ? {}
              : { role: parsed.data.role }),
            ...(parsed.data.startedAfter === undefined
              ? {}
              : { startedAfter: utcInstant(parsed.data.startedAfter) }),
            ...(parsed.data.startedBefore === undefined
              ? {}
              : { startedBefore: utcInstant(parsed.data.startedBefore) }),
            limit: parsed.data.limit,
          },
          operations.context,
        ),
      ),
    );
    return 0;
  }
  if (
    command === "purge-case" &&
    arguments_.length === 4 &&
    first !== undefined
  ) {
    const mutation = parseMutation(parseJson(arguments_[3]));
    if (
      !identifier.safeParse(first).success ||
      second === undefined ||
      mutation === undefined
    ) {
      output.error("Privacy purge arguments are invalid.");
      return 1;
    }
    output.log(
      JSON.stringify(
        await operations.purgeCaseSnapshot(
          caseSnapshotId(first),
          second,
          mutation,
          operations.context,
        ),
      ),
    );
    return 0;
  }
  if (command === "retention-reap" && arguments_.length === 3) {
    const mutation = parseMutation(parseJson(first));
    const limit = Number(second);
    if (
      mutation === undefined ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1_000
    ) {
      output.error("Retention reaper arguments are invalid.");
      return 1;
    }
    output.log(
      JSON.stringify(
        await operations.queueRetention(mutation, operations.context, limit),
      ),
    );
    return 0;
  }
  output.error(
    "Usage: caseweaver dead-letters [limit] | retry|cancel|recover <job-id> <mutation-json> | costs <query-json> | purge-case <snapshot-id> <reason> <mutation-json> | retention-reap <mutation-json> <limit>",
  );
  return 1;
}
