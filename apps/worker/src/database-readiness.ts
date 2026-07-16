/** Minimal query boundary for the worker's non-mutating PostgreSQL readiness check. */
export interface WorkerDatabaseQueryClient {
  query(statement: "SELECT 1"): Promise<unknown>;
}

export interface WorkerDatabaseReadinessProbe {
  check(): Promise<"ready" | "unavailable">;
}

/**
 * Bounded connectivity probe. It performs no migration, queue claim, outbox
 * relay, or application command and deliberately returns no failure detail.
 */
export class PostgresWorkerReadinessProbe
  implements WorkerDatabaseReadinessProbe
{
  public constructor(
    private readonly database: WorkerDatabaseQueryClient,
    private readonly timeoutMs: number,
  ) {}

  public async check(): Promise<"ready" | "unavailable"> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.database.query("SELECT 1"),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Worker database readiness timed out.")),
            this.timeoutMs,
          );
        }),
      ]);
      return "ready";
    } catch {
      return "unavailable";
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
