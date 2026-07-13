import type { ApiInstance } from "./app.js";
import type { DatabaseReadinessProbe } from "./database-readiness.js";
import type { AppLogger } from "./logger.js";

export function registerHealthRoutes(
  app: ApiInstance,
  readinessProbe: DatabaseReadinessProbe,
  logger: AppLogger,
): void {
  app.get("/health/live", async (_request, reply) => {
    return reply.status(200).send({ status: "ok" });
  });

  app.get("/health/ready", async (_request, reply) => {
    let status: "ready" | "unavailable" = "unavailable";

    try {
      status = await readinessProbe.check();
    } catch {}

    if (status === "ready") {
      return reply.status(200).send({ status: "ok" });
    }

    logger.warn(
      { readiness: { status: "unavailable" } },
      "Database is unavailable for readiness checks.",
    );
    return reply.status(503).send({ status: "unavailable" });
  });
}
