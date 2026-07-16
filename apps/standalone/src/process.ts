export interface StandaloneSignalRuntime {
  stop(): Promise<void>;
}

export interface StandaloneSignalProcess {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  exitCode?: number | string | null;
}

/**
 * Keeps signal handling outside standalone composition so the same runtime can
 * be embedded in tests or another supervised Node process.
 */
export function attachStandaloneShutdownSignals(
  runtime: StandaloneSignalRuntime,
  process: StandaloneSignalProcess,
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
