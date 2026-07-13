import type { DurableMessageQueue } from "@caseweaver/application";
import {
  deserializeEnvelope,
  type Envelope,
  type OutboxEnvelopeId,
} from "@caseweaver/domain";
import { type ConstructorOptions, PgBoss, type SendOptions } from "pg-boss";

export const PG_BOSS_SCHEMA = "caseweaver_queue";
export const PG_BOSS_ENVELOPE_QUEUE = "caseweaver.envelope.v1";
const pgBossJobIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PgBossQueueConfiguration {
  readonly connectionString: string;
  readonly retryLimit?: number;
  readonly retryDelaySeconds?: number;
  readonly expireInSeconds?: number;
}

export interface PgBossWorkerOptions {
  readonly teamSize?: number;
}

export interface EnvelopeConsumer {
  consume(envelope: Envelope, signal: AbortSignal): Promise<void>;
}

function runtimeOptions(
  configuration: PgBossQueueConfiguration,
): ConstructorOptions {
  return {
    connectionString: configuration.connectionString,
    schema: PG_BOSS_SCHEMA,
    migrate: false,
    createSchema: false,
    schedule: false,
    useListenNotify: false,
  };
}

function sendOptions(configuration: PgBossQueueConfiguration): SendOptions {
  const retryLimit = configuration.retryLimit ?? 5;
  const retryDelaySeconds = configuration.retryDelaySeconds ?? 10;
  const expireInSeconds = configuration.expireInSeconds ?? 900;
  if (
    !Number.isInteger(retryLimit) ||
    retryLimit < 0 ||
    !Number.isInteger(retryDelaySeconds) ||
    retryDelaySeconds < 0 ||
    !Number.isInteger(expireInSeconds) ||
    expireInSeconds < 1
  ) {
    throw new RangeError("pg-boss retry and expiry options are invalid.");
  }
  return { retryLimit, retryDelay: retryDelaySeconds, expireInSeconds };
}

export class PgBossDurableMessageQueue implements DurableMessageQueue {
  private readonly options: SendOptions;
  private started = false;

  public constructor(
    configuration: PgBossQueueConfiguration,
    private readonly boss: PgBoss = new PgBoss(runtimeOptions(configuration)),
  ) {
    this.options = sendOptions(configuration);
  }

  public async start(): Promise<void> {
    if (!this.started) {
      await this.boss.start();
      this.started = true;
    }
  }

  public async stop(): Promise<void> {
    if (this.started) {
      await this.boss.stop();
      this.started = false;
    }
  }

  public async publish(envelope: Envelope): Promise<void> {
    if (!pgBossJobIdPattern.test(envelope.id)) {
      throw new Error(
        "pg-boss requires UUID-formatted CaseWeaver envelope IDs.",
      );
    }
    const id = await this.boss.send(PG_BOSS_ENVELOPE_QUEUE, envelope, {
      ...this.options,
      id: envelope.id,
    });
    if (id !== null && id !== envelope.id) {
      throw new Error("pg-boss did not preserve the CaseWeaver envelope ID.");
    }
  }

  public async cancel(envelopeId: OutboxEnvelopeId): Promise<void> {
    await this.boss.cancel(PG_BOSS_ENVELOPE_QUEUE, envelopeId);
  }

  public async work(
    consumer: EnvelopeConsumer,
    options: PgBossWorkerOptions = {},
  ): Promise<string> {
    return this.boss.work(
      PG_BOSS_ENVELOPE_QUEUE,
      { localConcurrency: options.teamSize ?? 1 },
      async (jobs) => {
        for (const job of jobs) {
          await consumer.consume(deserializeEnvelope(job.data), job.signal);
        }
      },
    );
  }
}

/**
 * This is the only path permitted to create or migrate pg-boss objects. Worker
 * runtime construction always disables all pg-boss DDL options.
 */
export async function runPgBossMigrations(
  configuration: Pick<PgBossQueueConfiguration, "connectionString">,
): Promise<void> {
  const boss = new PgBoss({
    connectionString: configuration.connectionString,
    schema: PG_BOSS_SCHEMA,
    migrate: true,
    createSchema: true,
    schedule: false,
    useListenNotify: false,
  });
  try {
    await boss.start();
    await boss.createQueue(PG_BOSS_ENVELOPE_QUEUE);
  } finally {
    await boss.stop();
  }
}

export function getPgBossRuntimeOptions(
  configuration: Pick<PgBossQueueConfiguration, "connectionString">,
): Readonly<ConstructorOptions> {
  return Object.freeze(runtimeOptions(configuration));
}
