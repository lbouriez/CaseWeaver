import {
  AdministrationError,
  AdministrationUnavailableError,
} from "@caseweaver/administration";
import Fastify, {
  type FastifyInstance,
  LogController,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";
import type { ApiConfig } from "./config.js";
import type { DatabaseReadinessProbe } from "./database-readiness.js";
import type { ApiExecutionContextResolver } from "./execution-context.js";
import { registerHealthRoutes } from "./health.routes.js";
import type { AppLogger } from "./logger.js";
import {
  type AdministrationRouteOperations,
  registerAdministrationRoutes,
} from "./modules/administration/routes.js";
import { AuthSessionServiceError } from "./modules/auth/session-service.js";
import {
  type OperationsApiOperations,
  registerOperationsRoutes,
} from "./modules/operations/routes.js";
import {
  type PublicationApiOperations,
  registerPublicationRoutes,
} from "./modules/publication/routes.js";

export interface BuildApiDependencies {
  readonly config: ApiConfig;
  readonly logger: AppLogger;
  readonly readinessProbe: DatabaseReadinessProbe;
  readonly publication?: {
    readonly context: ApiExecutionContextResolver;
    readonly operations: PublicationApiOperations;
  };
  readonly operations?: {
    readonly context: ApiExecutionContextResolver;
    readonly operations: OperationsApiOperations;
  };
  readonly administration?: AdministrationRouteOperations;
}

export type ApiInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  AppLogger
>;

export function buildApi({
  config,
  logger,
  readinessProbe,
  publication,
  operations,
  administration,
}: BuildApiDependencies): ApiInstance {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: [...config.trustedProxyCidrs],
    logController: new LogController({
      disableRequestLogging: true,
    }),
  });

  // The SPA can be deployed separately from the API, but cookie credentials
  // are never made available to a reflected or wildcard origin. Fastify sees
  // preflight before a route handler, so an allowed browser mutation reaches
  // the same CSRF/session boundary as a same-origin request.
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (
      typeof origin !== "string" ||
      !config.allowedAdminOrigins.includes(origin)
    ) {
      return;
    }
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    reply.header(
      "Access-Control-Allow-Headers",
      "Accept, Content-Type, Idempotency-Key, X-CSRF-Token, X-CaseWeaver-Correlation-ID, X-CaseWeaver-Request-Mode, X-CaseWeaver-UI-Action-ID",
    );
    reply.header("Access-Control-Max-Age", "600");
    reply.header("Vary", "Origin");
    if (request.method === "OPTIONS") return reply.status(204).send();
  });

  registerHealthRoutes(app, readinessProbe, logger);
  app.setErrorHandler((error, _request, reply) => {
    // Transport errors are intentionally opaque: configuration, OIDC, database,
    // and authorization details must not become browser-visible diagnostics.
    const message = error instanceof Error ? error.message : "";
    const administrationCode =
      error instanceof AdministrationError ? error.code : undefined;
    const code =
      error instanceof AdministrationUnavailableError
        ? 503
        : administrationCode === "administration.auditUnavailable"
          ? 503
          : administrationCode === "administration.conflict" ||
              administrationCode === "administration.idempotencyConflict" ||
              administrationCode === "administration.finalAdministrator"
            ? 409
            : administrationCode === "administration.denied"
              ? 403
              : administrationCode === "administration.notFound"
                ? 404
                : error instanceof AuthSessionServiceError &&
                    error.code === "auth.session.required"
                  ? 401
                  : error instanceof AuthSessionServiceError
                    ? 403
                    : message === "authorization.denied"
                      ? 403
                      : message === "resource.notFound"
                        ? 404
                        : 400;
    return reply.status(code).send({
      code:
        code === 503
          ? "service.unavailable"
          : code === 409
            ? "administration.conflict"
            : code === 401
              ? "auth.required"
              : code === 403
                ? "authorization.denied"
                : code === 404
                  ? "resource.notFound"
                  : "request.invalid",
    });
  });
  if (publication !== undefined) {
    registerPublicationRoutes(app, publication);
  }
  if (operations !== undefined) {
    registerOperationsRoutes(app, operations);
  }
  if (administration !== undefined) {
    registerAdministrationRoutes(app, administration);
  }
  return app;
}
