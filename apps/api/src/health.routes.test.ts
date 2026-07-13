import { describe, expect, it, vi } from "vitest";

import { buildApi } from "./app.js";
import type { ApiConfig } from "./config.js";
import type { DatabaseReadinessProbe } from "./database-readiness.js";
import { createLogger } from "./logger.js";

const config: ApiConfig = {
  databaseReadinessTimeoutMs: 500,
  databaseUrl: "postgresql://caseweaver:password@localhost:5432/caseweaver",
  host: "127.0.0.1",
  nodeEnv: "test",
  port: 3000,
};

function createApp(readinessProbe: DatabaseReadinessProbe) {
  return buildApi({
    config,
    logger: createLogger(config),
    readinessProbe,
  });
}

describe("health routes", () => {
  it("reports liveness without querying the database", async () => {
    const probe = {
      check: vi.fn<DatabaseReadinessProbe["check"]>(),
    };
    const app = createApp(probe);

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(probe.check).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports ready when the injected probe is ready", async () => {
    const app = createApp({
      check: async () => "ready",
    });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("reports unavailable without exposing a probe failure", async () => {
    const app = createApp({
      check: async () => {
        throw new Error(
          "postgresql://caseweaver:password@database:5432/caseweaver refused",
        );
      },
    });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
    expect(response.body).not.toContain("postgresql://");
    await app.close();
  });
});
