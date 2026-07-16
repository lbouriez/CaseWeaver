import type { FastifyInstance } from "fastify";

export interface WebhookRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface WebhookRuntimeDependencies {
  readonly app: FastifyInstance;
  readonly host: string;
  readonly port: number;
}

export interface WebhookSignalProcess {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  exitCode?: number | string | null;
}

class DefaultWebhookRuntime implements WebhookRuntime {
  private started = false;
  private stopped = false;

  public constructor(
    private readonly dependencies: WebhookRuntimeDependencies,
  ) {}

  public async start(): Promise<void> {
    if (this.started) throw new Error("Webhook runtime is already started.");
    if (this.stopped) throw new Error("Webhook runtime is already stopped.");
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

/** Owns webhook HTTP lifetime only; routing and verification stay injected. */
export function createWebhookRuntime(
  dependencies: WebhookRuntimeDependencies,
): WebhookRuntime {
  return new DefaultWebhookRuntime(dependencies);
}

export function attachWebhookShutdownSignals(
  runtime: WebhookRuntime,
  process: WebhookSignalProcess,
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
