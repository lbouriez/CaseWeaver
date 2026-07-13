import { Pool } from "pg";

import type { ApiConfig } from "./config.js";

export interface DatabaseReadinessProbe {
  check(): Promise<"ready" | "unavailable">;
}

export interface DatabaseReadinessResource {
  readonly readinessProbe: DatabaseReadinessProbe;
  close(): Promise<void>;
}

export interface DatabaseQueryClient {
  query(statement: "SELECT 1"): Promise<unknown>;
}

export class PostgresDatabaseReadinessProbe implements DatabaseReadinessProbe {
  public constructor(
    private readonly database: DatabaseQueryClient,
    private readonly timeoutMs: number,
  ) {}

  public async check(): Promise<"ready" | "unavailable"> {
    try {
      await this.executeWithTimeout();
      return "ready";
    } catch {
      return "unavailable";
    }
  }

  private async executeWithTimeout(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error("Database readiness check timed out."));
      }, this.timeoutMs);
    });

    try {
      await Promise.race([this.database.query("SELECT 1"), timeoutPromise]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}

export function createDatabaseReadiness(
  config: ApiConfig,
): DatabaseReadinessResource {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: config.databaseReadinessTimeoutMs,
    max: 1,
    query_timeout: config.databaseReadinessTimeoutMs,
  });

  return {
    readinessProbe: new PostgresDatabaseReadinessProbe(
      pool,
      config.databaseReadinessTimeoutMs,
    ),
    close: async () => {
      await pool.end();
    },
  };
}
