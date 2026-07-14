import type { ExecutionContext } from "@caseweaver/application";
import {
  analysisJobId,
  caseSnapshotId,
  sha256Digest,
  utcInstant,
} from "@caseweaver/domain";
import { withOpenTelemetrySpan } from "@caseweaver/observability";
import { z } from "zod";

import type { ApiInstance } from "../../app.js";
import type { ApiExecutionContextResolver } from "../pbi-012/routes.js";

const identifier = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-fA-F0-9]{64}$/u);
const utcDateTime = z.string().datetime({ offset: true }).endsWith("Z");
const mutationSchema = z
  .object({ idempotencyKeyDigest: digest, requestDigest: digest })
  .strict();
const jobParametersSchema = z.object({ analysisJobId: identifier }).strict();
const snapshotParametersSchema = z
  .object({ caseSnapshotId: identifier })
  .strict();
const costQuerySchema = z
  .object({
    analysisJobId: identifier.optional(),
    connectorInstanceId: identifier.optional(),
    role: identifier.optional(),
    startedAfter: utcDateTime.optional(),
    startedBefore: utcDateTime.optional(),
    limit: z.coerce.number().int().min(1).max(1_000).default(100),
  })
  .strict();
const retentionRequestSchema = mutationSchema
  .extend({ limit: z.number().int().min(1).max(1_000).default(100) })
  .strict();
const privacyRequestSchema = mutationSchema
  .extend({ reason: z.string().min(1).max(4_000) })
  .strict();

export interface Pbi013ApiOperations {
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
    input: {
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
    snapshotId: ReturnType<typeof caseSnapshotId>,
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

interface Mutation {
  readonly idempotencyKeyDigest: ReturnType<typeof sha256Digest>;
  readonly requestDigest: ReturnType<typeof sha256Digest>;
}

function mutation(value: z.infer<typeof mutationSchema>): Mutation {
  return {
    idempotencyKeyDigest: sha256Digest(value.idempotencyKeyDigest),
    requestDigest: sha256Digest(value.requestDigest),
  };
}

function invalid(reply: {
  status(code: number): { send(value: unknown): unknown };
}) {
  return reply.status(400).send({ code: "request.invalid" });
}

export function registerPbi013Routes(
  app: ApiInstance,
  dependencies: {
    readonly context: ApiExecutionContextResolver;
    readonly operations: Pbi013ApiOperations;
  },
): void {
  app.get("/v1/operations/dead-letters", async (request, reply) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .safeParse(request.query);
    if (!query.success) return invalid(reply);
    return withOpenTelemetrySpan("caseweaver.api.dead_letters", {}, async () =>
      reply.send(
        await dependencies.operations.inspectDeadLetters(
          query.data.limit,
          await dependencies.context.resolve(request),
        ),
      ),
    );
  });

  app.post(
    "/v1/operations/dead-letters/:analysisJobId/retry",
    async (request, reply) => {
      const parameters = jobParametersSchema.safeParse(request.params);
      const body = mutationSchema.safeParse(request.body);
      if (!parameters.success || !body.success) return invalid(reply);
      return withOpenTelemetrySpan(
        "caseweaver.api.dead_letter_retry",
        {},
        async () =>
          reply
            .status(202)
            .send(
              await dependencies.operations.retryDeadLetter(
                analysisJobId(parameters.data.analysisJobId),
                mutation(body.data),
                await dependencies.context.resolve(request),
              ),
            ),
      );
    },
  );

  app.post(
    "/v1/operations/jobs/:analysisJobId/cancel",
    async (request, reply) => {
      const parameters = jobParametersSchema.safeParse(request.params);
      const body = mutationSchema.safeParse(request.body);
      if (!parameters.success || !body.success) return invalid(reply);
      return withOpenTelemetrySpan("caseweaver.api.job_cancel", {}, async () =>
        reply
          .status(202)
          .send(
            await dependencies.operations.cancelJob(
              analysisJobId(parameters.data.analysisJobId),
              mutation(body.data),
              await dependencies.context.resolve(request),
            ),
          ),
      );
    },
  );

  app.post(
    "/v1/operations/jobs/:analysisJobId/recover",
    async (request, reply) => {
      const parameters = jobParametersSchema.safeParse(request.params);
      const body = mutationSchema.safeParse(request.body);
      if (!parameters.success || !body.success) return invalid(reply);
      return withOpenTelemetrySpan("caseweaver.api.job_recover", {}, async () =>
        reply
          .status(202)
          .send(
            await dependencies.operations.recoverExpiredJob(
              analysisJobId(parameters.data.analysisJobId),
              mutation(body.data),
              await dependencies.context.resolve(request),
            ),
          ),
      );
    },
  );

  app.get("/v1/costs", async (request, reply) => {
    const query = costQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(reply);
    return withOpenTelemetrySpan("caseweaver.api.cost_query", {}, async () =>
      reply.send(
        await dependencies.operations.queryCosts(
          {
            ...(query.data.analysisJobId === undefined
              ? {}
              : { analysisJobId: analysisJobId(query.data.analysisJobId) }),
            ...(query.data.connectorInstanceId === undefined
              ? {}
              : { connectorInstanceId: query.data.connectorInstanceId }),
            ...(query.data.role === undefined ? {} : { role: query.data.role }),
            ...(query.data.startedAfter === undefined
              ? {}
              : { startedAfter: utcInstant(query.data.startedAfter) }),
            ...(query.data.startedBefore === undefined
              ? {}
              : { startedBefore: utcInstant(query.data.startedBefore) }),
            limit: query.data.limit,
          },
          await dependencies.context.resolve(request),
        ),
      ),
    );
  });

  app.post(
    "/v1/privacy/case-snapshots/:caseSnapshotId/purge",
    async (request, reply) => {
      const parameters = snapshotParametersSchema.safeParse(request.params);
      const body = privacyRequestSchema.safeParse(request.body);
      if (!parameters.success || !body.success) return invalid(reply);
      return withOpenTelemetrySpan(
        "caseweaver.api.privacy_purge",
        {},
        async () =>
          reply
            .status(202)
            .send(
              await dependencies.operations.purgeCaseSnapshot(
                caseSnapshotId(parameters.data.caseSnapshotId),
                body.data.reason,
                mutation(body.data),
                await dependencies.context.resolve(request),
              ),
            ),
      );
    },
  );

  app.post("/v1/retention/reap", async (request, reply) => {
    const body = retentionRequestSchema.safeParse(request.body);
    if (!body.success) return invalid(reply);
    return withOpenTelemetrySpan(
      "caseweaver.api.retention_reap",
      {},
      async () =>
        reply
          .status(202)
          .send(
            await dependencies.operations.queueRetention(
              mutation(body.data),
              await dependencies.context.resolve(request),
              body.data.limit,
            ),
          ),
    );
  });
}
