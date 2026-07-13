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

export interface BuildApiDependencies {
  readonly config: ApiConfig;
  readonly logger: AppLogger;
  readonly readinessProbe: DatabaseReadinessProbe;
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
}: BuildApiDependencies): ApiInstance {
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({
      disableRequestLogging: true,
    }),
  });

  registerHealthRoutes(app, readinessProbe, logger);
  return app;
}
