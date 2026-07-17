import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresAttachmentOccurrencePreparationStore } from "./preparation-store.js";

describe("PostgresAttachmentOccurrencePreparationStore input boundaries", () => {
  it("rejects invalid lease configuration before it can create a database claim", () => {
    const pool = { connect: vi.fn() } as unknown as Pool;

    expect(
      () => new PostgresAttachmentOccurrencePreparationStore(pool, 0),
    ).toThrow(/claim lease duration/u);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects unsafe locator input before opening a database connection", async () => {
    const pool = { connect: vi.fn() } as unknown as Pool;
    const store = new PostgresAttachmentOccurrencePreparationStore(pool);

    await expect(
      store.recordOccurrence({
        id: "occurrence-a",
        workspaceId: "workspace-a",
        ownerKind: "caseSnapshot",
        ownerId: "snapshot-a",
        connectorRegistrationId: "connector-a",
        connectorConfigurationVersionId: "connector-a-version-1",
        relation: "inlineImage",
        ordinal: 0,
        attachmentReferenceId: "external-reference-a",
        identityHash: "a".repeat(64),
        required: false,
        privateLocator: {
          ciphertext: "ciphertext\nnot-safe",
          cipherVersion: "v1",
        },
      }),
    ).rejects.toThrow(/locator ciphertext/u);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects non-boolean occurrence and evidence flags before database access", async () => {
    const pool = { connect: vi.fn() } as unknown as Pool;
    const store = new PostgresAttachmentOccurrencePreparationStore(pool);

    await expect(
      store.recordOccurrence({
        id: "occurrence-a",
        workspaceId: "workspace-a",
        ownerKind: "caseSnapshot",
        ownerId: "snapshot-a",
        connectorRegistrationId: "connector-a",
        connectorConfigurationVersionId: "connector-a-version-1",
        relation: "inlineImage",
        ordinal: 0,
        attachmentReferenceId: "external-reference-a",
        identityHash: "a".repeat(64),
        required: "false" as unknown as boolean,
        privateLocator: { ciphertext: "ciphertext", cipherVersion: "v1" },
      }),
    ).rejects.toThrow(/required flag/u);
    await expect(
      store.completePreparation({
        workspaceId: "workspace-a",
        runId: "preparation-a",
        lease: {
          token: "lease-a",
          fencingToken: 1n,
          expiresAt: "2026-07-16T00:00:00.000Z",
        },
        evidence: [
          {
            occurrenceId: "occurrence-a",
            outcome: "failed",
            warningCode: "attachment.unavailable",
            retryable: "false" as unknown as boolean,
          },
        ],
      }),
    ).rejects.toThrow(/retryable flag/u);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
