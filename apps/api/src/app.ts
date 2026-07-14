import Fastify, {
  type FastifyInstance,
  LogController,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";

import type { ApiConfig } from "./config.js";
import type { DatabaseReadinessProbe } from "./database-readiness.js";
import { registerHealthRoutes } from "./health.routes.js";
import type { AppLogger } from "./logger.js";
import {
  type ApiExecutionContextResolver,
  type Pbi012ApiOperations,
  registerPbi012Routes,
} from "./modules/pbi-012/routes.js";
import {
  type Pbi013ApiOperations,
  registerPbi013Routes,
} from "./modules/pbi-013/routes.js";

export interface BuildApiDependencies {
  readonly config: ApiConfig;
  readonly logger: AppLogger;
  readonly readinessProbe: DatabaseReadinessProbe;
  readonly pbi012?: {
    readonly context: ApiExecutionContextResolver;
    readonly operations: Pbi012ApiOperations;
  };
  readonly pbi013?: {
    readonly context: ApiExecutionContextResolver;
    readonly operations: Pbi013ApiOperations;
  };
}

export type ApiInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  AppLogger
>;

export function buildApi({
  config: _config,
  logger,
  readinessProbe,
  pbi012,
  pbi013,
}: BuildApiDependencies): ApiInstance {
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({
      disableRequestLogging: true,
    }),
  });

  registerHealthRoutes(app, readinessProbe, logger);
  if (pbi012 !== undefined) {
    registerPbi012Routes(app, pbi012);
  }
  if (pbi013 !== undefined) {
    registerPbi013Routes(app, pbi013);
  }
  return app;
}
