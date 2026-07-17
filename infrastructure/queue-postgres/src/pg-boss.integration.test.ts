import {
  analysisIdentityId,
  analysisJobId,
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { PgBoss } from "pg-boss";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  getPgBossRuntimeOptions,
  PG_BOSS_ENVELOPE_QUEUE,
  PgBossDurableMessageQueue,
  runPgBossMigrations,
} from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("pg-boss integration tests require DATABASE_URL.");
}
if (!new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error(
    "pg-boss integration DATABASE_URL must name a test database.",
  );
}

let queue: PgBossDurableMessageQueue | undefined;
let observer: PgBoss | undefined;

function envelope() {
  return createEnvelope({
    id: outboxEnvelopeId("00000000-0000-4000-8000-000000000002"),
    kind: "command",
    type: "analysis.execute.v1",
    schemaVersion: 1,
    workspaceId: workspaceId("workspace-1"),
    occurredAt: utcInstant("2026-01-01T00:00:00.000Z"),
    correlationId: correlationId("correlation-1"),
    causationId: causationId("cause-1"),
    payload: {
      analysisJobId: analysisJobId("job-1"),
      analysisIdentityId: analysisIdentityId("identity-1"),
    },
  });
}

beforeAll(async () => {
  await runPgBossMigrations({ connectionString: databaseUrl });
});

afterEach(async () => {
  await queue?.stop();
  await observer?.stop();
  queue = undefined;
  observer = undefined;
});

describe("pg-boss durable envelope adapter", () => {
  it("deduplicates stable IDs and cancels the durable queue job", async () => {
    queue = new PgBossDurableMessageQueue({
      connectionString: databaseUrl,
      retryLimit: 2,
      retryDelaySeconds: 1,
      expireInSeconds: 30,
    });
    observer = new PgBoss(
      getPgBossRuntimeOptions({ connectionString: databaseUrl }),
    );
    await queue.start();
    await observer.start();

    const message = envelope();
    await queue.publish(message);
    await queue.publish(message);
    const queued = await observer.getJobById<Envelope>(
      PG_BOSS_ENVELOPE_QUEUE,
      message.id,
    );

    expect(queued?.id).toBe(message.id);
    expect(queued?.retryLimit).toBe(2);
    expect(queued?.expireInSeconds).toBe(30);

    await queue.cancel(message.id);
    const cancelled = await observer.getJobById<Envelope>(
      PG_BOSS_ENVELOPE_QUEUE,
      message.id,
    );
    expect(cancelled?.state).toBe("cancelled");
  });
});
