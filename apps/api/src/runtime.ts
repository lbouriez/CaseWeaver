import type { ApiInstance } from "./app.js";

export interface ApiRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ApiRuntimeDependencies {
  readonly app: ApiInstance;
  readonly host: string;
  readonly port: number;
}

export interface ApiSignalProcess {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  exitCode?: number | string | null;
}

class DefaultApiRuntime implements ApiRuntime {
  private started = false;
  private stopped = false;

  public constructor(private readonly dependencies: ApiRuntimeDependencies) {}

  public async start(): Promise<void> {
    if (this.started) throw new Error("API runtime is already started.");
    if (this.stopped) throw new Error("API runtime is already stopped.");
    try {
      await this.dependencies.app.listen({
        host: this.dependencies.host,
        port: this.dependencies.port,
      });
      this.started = true;
    } catch (error) {
      await this.dependencies.app.close();
      this.stopped = true;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.dependencies.app.close();
  }
}

/** Creates the API transport lifecycle without owning process termination. */
export function createApiRuntime(
  dependencies: ApiRuntimeDependencies,
): ApiRuntime {
  return new DefaultApiRuntime(dependencies);
}

/**
 * Stops accepting HTTP traffic before the API's on-close resources are released.
 * The handler only changes the exit code after cleanup; it never calls
 * `process.exit`, which would abandon in-flight response and audit work.
 */
export function attachApiShutdownSignals(
  runtime: ApiRuntime,
  process: ApiSignalProcess,
): () => void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void runtime.stop().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
}
