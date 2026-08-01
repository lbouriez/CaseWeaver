/** Minimal query boundary for the scheduler's non-mutating PostgreSQL readiness check. */
export interface SchedulerDatabaseQueryClient {
  query(statement: "SELECT 1"): Promise<unknown>;
}

export interface SchedulerDatabaseReadinessProbe {
  check(): Promise<"ready" | "unavailable">;
}

/**
 * Bounded connectivity probe. It never evaluates schedules, acquires a lease,
 * enqueues a request, or reveals the database failure to a health caller.
 */
export class PostgresSchedulerReadinessProbe
  implements SchedulerDatabaseReadinessProbe
{
  public constructor(
    private readonly database: SchedulerDatabaseQueryClient,
    private readonly timeoutMs: number,
  ) {}

  public async check(): Promise<"ready" | "unavailable"> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.database.query("SELECT 1"),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Scheduler database readiness timed out.")),
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
