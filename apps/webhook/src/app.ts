import {
  type WebhookEndpoint,
  type WebhookIngress,
  WebhookTranslationError,
  WebhookVerificationError,
} from "@caseweaver/webhooks";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

const endpointParametersSchema = z
  .object({
    endpointId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict();

export interface WebhookEndpointResolver {
  resolve(
    endpointId: string,
  ): Promise<WebhookEndpoint | ResolvedWebhookEndpoint | undefined>;
}

/**
 * Trusted routing policy resolved from the opaque endpoint ID.  The public
 * transport deliberately sees neither connector settings nor secret-reference
 * identities; it receives only the already-selected adapter and bounded
 * admission policy.
 */
export interface ResolvedWebhookEndpoint {
  readonly endpoint: WebhookEndpoint;
  readonly maximumBodyBytes?: number;
  readonly admit?: () => Promise<Readonly<{ readonly allowed: boolean }>>;
}

export interface BuildWebhookAppDependencies {
  readonly ingress: WebhookIngress;
  readonly endpointResolver: WebhookEndpointResolver;
  readonly maximumBodyBytes: number;
  /** Optional, already-bounded server-side readiness probe. */
  readonly readinessProbe?: {
    check(): Promise<"ready" | "unavailable">;
  };
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Readonly<Record<string, readonly string[]>> {
  const normalized: Record<string, readonly string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[name] =
      typeof value === "string"
        ? Object.freeze([value])
        : Object.freeze([...value]);
  }
  return Object.freeze(normalized);
}

function requestAbortSignal(request: {
  readonly raw: {
    once(event: "aborted", listener: () => void): unknown;
  };
}): AbortSignal {
  const controller = new AbortController();
  request.raw.once("aborted", () => {
    controller.abort(new Error("Webhook client disconnected."));
  });
  return controller.signal;
}

/**
 * Public transport only: it captures a Buffer without JSON parsing and delegates the
 * opaque endpoint, raw bytes, and headers to the verified-event boundary.
 */
export function buildWebhookApp({
  ingress,
  endpointResolver,
  maximumBodyBytes,
  readinessProbe,
}: BuildWebhookAppDependencies): FastifyInstance {
  if (!Number.isInteger(maximumBodyBytes) || maximumBodyBytes < 1) {
    throw new RangeError(
      "Webhook maximum body size must be a positive integer.",
    );
  }

  const app = Fastify({ bodyLimit: maximumBodyBytes, logger: false });
  app.get("/health/live", async (_request, reply) =>
    reply.status(200).send({ status: "ok" }),
  );
  app.get("/health/ready", async (_request, reply) => {
    try {
      if (
        readinessProbe === undefined ||
        (await readinessProbe.check()) === "ready"
      ) {
        return reply.status(200).send({ status: "ok" });
      }
    } catch {
      // Readiness failures are deliberately opaque on the public transport.
    }
    return reply.status(503).send({ status: "unavailable" });
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 413
        ? 413
        : 503;
    return reply
      .status(status)
      .send({ status: status === 413 ? "payload_too_large" : "unavailable" });
  });
  app.removeContentTypeParser("application/json");
  app.removeContentTypeParser("text/plain");
  const parseRawBody = (
    _request: unknown,
    body: Buffer,
    done: (error: Error | null, value?: Buffer) => void,
  ): void => done(null, body);
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    parseRawBody,
  );
  app.addContentTypeParser("text/plain", { parseAs: "buffer" }, parseRawBody);
  app.addContentTypeParser("*", { parseAs: "buffer" }, parseRawBody);

  app.post("/webhooks/:endpointId", async (request, reply) => {
    const parameters = endpointParametersSchema.safeParse(request.params);
    if (!parameters.success) {
      return reply.status(404).send({ status: "not_found" });
    }

    const resolved = normalizeEndpoint(
      await endpointResolver.resolve(parameters.data.endpointId),
    );
    if (
      resolved === undefined ||
      resolved.endpoint.id !== parameters.data.endpointId
    ) {
      return reply.status(404).send({ status: "not_found" });
    }

    if (
      resolved.maximumBodyBytes !== undefined &&
      (request.body as Uint8Array).byteLength > resolved.maximumBodyBytes
    ) {
      return reply.status(413).send({ status: "payload_too_large" });
    }

    if (resolved.admit !== undefined) {
      const admission = await resolved.admit();
      if (!admission.allowed) {
        return reply.status(429).send({ status: "rate_limited" });
      }
    }

    try {
      const acceptance = await ingress.accept(resolved.endpoint, {
        method: request.method,
        headers: normalizeHeaders(request.raw.headers),
        body: request.body as Uint8Array,
        signal: requestAbortSignal(request),
      });

      if (acceptance.status === "idempotencyConflict") {
        return reply.status(409).send({ status: "conflict" });
      }
      return reply.status(202).send({ status: acceptance.status });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        return reply.status(401).send({ status: "unauthorized" });
      }
      if (error instanceof WebhookTranslationError) {
        return reply.status(422).send({ status: "unprocessable" });
      }
      throw error;
    }
  });

  return app;
}

function normalizeEndpoint(
  value: WebhookEndpoint | ResolvedWebhookEndpoint | undefined,
): ResolvedWebhookEndpoint | undefined {
  if (value === undefined) return undefined;
  if ("endpoint" in value) return value;
  return Object.freeze({ endpoint: value });
}
