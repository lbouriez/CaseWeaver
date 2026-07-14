import type { EnvelopeFor } from "@caseweaver/domain";

export interface RetentionReaperService {
  reap(
    command: EnvelopeFor<"retention.reap.v1">,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface RetentionPurgeService {
  purge(
    command: EnvelopeFor<"retention.purge.v1">,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/**
 * Retention is driven only by durable command envelopes. The injected services
 * own storage deletion and fences; this adapter deliberately performs neither
 * direct SQL nor object-store work itself.
 */
export function createPbi013Handlers(input: {
  readonly reaper: RetentionReaperService;
  readonly purge: RetentionPurgeService;
}) {
  return Object.freeze({
    retention: {
      reap: {
        handle: async (
          command: EnvelopeFor<"retention.reap.v1">,
          signal: AbortSignal,
        ): Promise<void> => {
          await input.reaper.reap(command, signal);
        },
      },
      purge: {
        handle: async (
          command: EnvelopeFor<"retention.purge.v1">,
          signal: AbortSignal,
        ): Promise<void> => {
          await input.purge.purge(command, signal);
        },
      },
    },
  });
}
