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
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

import {
  getPgBossRuntimeOptions,
  PG_BOSS_ENVELOPE_QUEUE,
  PgBossDurableMessageQueue,
} from "./index.js";

function envelope() {
  return createEnvelope({
    id: outboxEnvelopeId("00000000-0000-4000-8000-000000000001"),
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

describe("PgBossDurableMessageQueue", () => {
  it("disables runtime DDL and listener behavior", () => {
    expect(
      getPgBossRuntimeOptions({
        connectionString: "postgresql://caseweaver:caseweaver@localhost/test",
      }),
    ).toMatchObject({
      createSchema: false,
      migrate: false,
      schedule: false,
      schema: "caseweaver_queue",
      useListenNotify: false,
    });
  });

  it("uses the outbox envelope ID with retry and expiry settings", async () => {
    const send = vi.fn(async () => "00000000-0000-4000-8000-000000000001");
    const boss = {
      send,
      cancel: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      work: async () => "worker-1",
    } as unknown as PgBoss;
    const queue = new PgBossDurableMessageQueue(
      {
        connectionString: "postgresql://caseweaver:caseweaver@localhost/test",
        retryLimit: 3,
        retryDelaySeconds: 7,
        expireInSeconds: 42,
      },
      boss,
    );

    await queue.publish(envelope());

    expect(send).toHaveBeenCalledWith(
      PG_BOSS_ENVELOPE_QUEUE,
      expect.any(Object),
      expect.objectContaining({
        expireInSeconds: 42,
        id: "00000000-0000-4000-8000-000000000001",
        retryDelay: 7,
        retryLimit: 3,
      }),
    );
  });
});
