import {
  type AttachmentPreparationPolicy,
  createAttachmentPreparationResult,
} from "@caseweaver/attachments";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresAttachmentPreparationAttemptInProgressError,
  PostgresAttachmentPreparationAttemptOwnershipError,
  PostgresAttachmentPreparationAttemptStore,
} from "./preparation-attempt-store.js";

const workspaceId = "workspace-a";
const planIdentity = "b".repeat(64);
const accessPolicyHash = "a".repeat(64);
const derivativeContentHash = "c".repeat(64);
const policy: AttachmentPreparationPolicy = Object.freeze({
  mode: "optional",
  policyVersion: "attachment-policy-v1",
  accessPolicyHash,
});
const occurrence = Object.freeze({
  identity: "occurrence-a",
  ownerIdentity: "owner-a",
  sourceOrdinal: 7,
  ordinal: 0,
  attachmentId: "attachment-a",
  relation: "inline-image",
  required: false,
});

function result(input: { readonly retryable?: boolean } = {}) {
  return createAttachmentPreparationResult({
    policy,
    ...(input.retryable === true
      ? {
          warnings: [
            {
              kind: "attachmentPreparationWarning" as const,
              code: "attachment.processing-in-progress",
              retryable: true,
              occurrenceIdentity: occurrence.identity,
            },
          ],
        }
      : {
          derivatives: [
            {
              occurrenceIdentity: occurrence.identity,
              derivativeIdentity: "derivative-cache-a",
              derivativeContentHash,
              searchableText: "private derivative text must never be persisted",
            },
          ],
        }),
  });
}

function attemptRow(
  input: {
    readonly id?: string;
    readonly state?: "claimed" | "completed";
    readonly fence?: string | null;
    readonly retryOfAttemptId?: string | null;
    readonly retryRequired?: boolean;
    readonly storedResult?: ReturnType<typeof result>;
    readonly leaseExpiresAt?: Date | null;
  } = {},
) {
  const state = input.state ?? "claimed";
  const storedResult = input.storedResult;
  return {
    id: input.id ?? "attempt-a",
    workspace_id: workspaceId,
    subject_kind: "caseCapture",
    subject_id: "case-capture-a",
    plan_identity_hash: planIdentity,
    policy_mode: policy.mode,
    policy_version: policy.policyVersion,
    access_policy_hash: policy.accessPolicyHash,
    attempt_sequence: input.id === "attempt-b" ? 2 : 1,
    retry_of_attempt_id: input.retryOfAttemptId ?? null,
    state,
    fence: state === "claimed" ? (input.fence ?? "fence-a") : null,
    lease_expires_at:
      state === "claimed"
        ? (input.leaseExpiresAt ?? new Date("2030-01-01T00:00:00.000Z"))
        : null,
    result_identity_hash:
      state === "completed"
        ? (storedResult?.outcome.identityHash ?? null)
        : null,
    result: state === "completed" ? (storedResult?.outcome ?? null) : null,
    retry_required:
      state === "completed"
        ? (storedResult?.outcome.retryRequired ?? false)
        : (input.retryRequired ?? false),
    created_at: new Date("2026-07-17T00:00:00.000Z"),
    completed_at:
      state === "completed" ? new Date("2026-07-17T00:01:00.000Z") : null,
  };
}

function mockedPool(
  responses: readonly Readonly<{
    readonly expect: string;
    readonly rows?: readonly unknown[];
  }>[],
) {
  const pending = [...responses];
  const query = vi.fn(async (statement: string) => {
    const next = pending.shift();
    expect(next, `unexpected query: ${statement}`).toBeDefined();
    expect(statement).toContain(next?.expect ?? "");
    return { rows: next?.rows ?? [] };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { pool, query, release, pending };
}

function claimInput() {
  return {
    subject: {
      workspaceId,
      kind: "caseCapture" as const,
      id: "case-capture-a",
    },
    policy,
    planIdentity,
    occurrences: [occurrence],
    signal: new AbortController().signal,
  };
}

describe("PostgresAttachmentPreparationAttemptStore", () => {
  it("returns only completed ready evidence for the exact stable subject", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            occurrence_identity: "occurrence-a",
            attachment_id: "attachment-a",
            derivative_id: "derivative-a",
            derivative_identity: "derivative-cache-a",
            derivative_content_hash: derivativeContentHash,
          },
        ],
      })),
    } as unknown as Pool;
    const store = new PostgresAttachmentPreparationAttemptStore(pool);

    await expect(
      store.completedDerivativeEvidence({
        workspaceId,
        attemptId: "attempt-a",
        subject: { kind: "caseCapture", id: "case-capture-a" },
      }),
    ).resolves.toEqual([
      {
        occurrenceIdentity: "occurrence-a",
        attachmentId: "attachment-a",
        derivativeId: "derivative-a",
        derivativeIdentity: "derivative-cache-a",
        derivativeContentHash,
      },
    ]);
    const [statement, values] = (pool.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, readonly unknown[]];
    expect(statement).toContain("attempt.subject_kind = $3");
    expect(statement).toContain("attempt.state = 'completed'");
    expect(statement).toContain("evidence.outcome = 'ready'");
    expect(values).toEqual([
      workspaceId,
      "attempt-a",
      "caseCapture",
      "case-capture-a",
    ]);
  });

  it("claims a new stable attempt with database-time lease and registers immutable occurrences", async () => {
    const row = attemptRow();
    const database = mockedPool([
      { expect: "BEGIN" },
      { expect: "pg_advisory_xact_lock" },
      { expect: "ORDER BY attempt_sequence DESC", rows: [] },
      { expect: "INSERT INTO attachment_preparation_attempts", rows: [row] },
      { expect: "INSERT INTO attachment_preparation_attempt_occurrences" },
      { expect: "COMMIT" },
    ]);
    const store = new PostgresAttachmentPreparationAttemptStore(database.pool, {
      nextId: vi
        .fn()
        .mockReturnValueOnce("attempt-a")
        .mockReturnValueOnce("fence-a"),
    });

    await expect(store.claim(claimInput())).resolves.toEqual({
      kind: "claimed",
      attempt: { id: "attempt-a", fence: "fence-a", planIdentity },
    });

    expect(database.pending).toHaveLength(0);
    const statements = database.query.mock.calls
      .map(([statement]) => statement)
      .join("\n");
    expect(statements).toContain("statement_timestamp()");
    expect(statements).toContain("attachment_preparation_attempt_occurrences");
    expect(statements).not.toContain("NOW()");
    expect(
      database.query.mock.calls.flatMap(([, values]) => values ?? []),
    ).toEqual(
      expect.arrayContaining([
        occurrence.ownerIdentity,
        occurrence.sourceOrdinal,
      ]),
    );
    expect(database.release).toHaveBeenCalledOnce();
  });

  it("returns only the safe terminal outcome from a non-retryable completed attempt", async () => {
    const stored = result();
    const database = mockedPool([
      { expect: "BEGIN" },
      { expect: "pg_advisory_xact_lock" },
      {
        expect: "ORDER BY attempt_sequence DESC",
        rows: [attemptRow({ state: "completed", storedResult: stored })],
      },
      { expect: "COMMIT" },
    ]);
    const store = new PostgresAttachmentPreparationAttemptStore(database.pool);

    await expect(store.claim(claimInput())).resolves.toEqual({
      kind: "completed",
      attempt: { id: "attempt-a", planIdentity },
      result: { outcome: stored.outcome, derivatives: [] },
    });

    expect(database.pending).toHaveLength(0);
    const values = database.query.mock.calls.flatMap(
      ([, values]) => values ?? [],
    );
    expect(JSON.stringify(values)).not.toContain("private derivative text");
  });

  it("chains a new immutable attempt after a terminal retry-required result", async () => {
    const stored = result({ retryable: true });
    const database = mockedPool([
      { expect: "BEGIN" },
      { expect: "pg_advisory_xact_lock" },
      {
        expect: "ORDER BY attempt_sequence DESC",
        rows: [
          attemptRow({
            id: "attempt-a",
            state: "completed",
            storedResult: stored,
          }),
        ],
      },
      {
        expect: "INSERT INTO attachment_preparation_attempts",
        rows: [
          attemptRow({
            id: "attempt-b",
            fence: "fence-b",
            retryOfAttemptId: "attempt-a",
          }),
        ],
      },
      { expect: "INSERT INTO attachment_preparation_attempt_occurrences" },
      { expect: "COMMIT" },
    ]);
    const nextId = vi
      .fn()
      .mockReturnValueOnce("attempt-b")
      .mockReturnValueOnce("fence-b");
    const store = new PostgresAttachmentPreparationAttemptStore(database.pool, {
      nextId,
    });

    await expect(store.claim(claimInput())).resolves.toEqual({
      kind: "claimed",
      attempt: {
        id: "attempt-b",
        fence: "fence-b",
        planIdentity,
        retryOfAttemptId: "attempt-a",
      },
    });

    const insert = database.query.mock.calls.find(([statement]) =>
      statement.includes("INSERT INTO attachment_preparation_attempts"),
    );
    expect(insert?.[1]).toContain("attempt-a");
    expect(insert?.[1]).toContain(2);
  });

  it("fails safely and retryably while another database-time claim is live", async () => {
    const database = mockedPool([
      { expect: "BEGIN" },
      { expect: "pg_advisory_xact_lock" },
      { expect: "ORDER BY attempt_sequence DESC", rows: [attemptRow()] },
      { expect: "UPDATE attachment_preparation_attempts", rows: [] },
      { expect: "COMMIT" },
    ]);
    const store = new PostgresAttachmentPreparationAttemptStore(database.pool);

    await expect(store.claim(claimInput())).rejects.toBeInstanceOf(
      PostgresAttachmentPreparationAttemptInProgressError,
    );

    expect(database.pending).toHaveLength(0);
    expect(
      database.query.mock.calls.map(([statement]) => statement),
    ).not.toContain("ROLLBACK");
  });

  it("finalizes safe evidence atomically without persisting text or storage handles", async () => {
    const current = attemptRow();
    const original = result();
    const prepared = {
      outcome: {
        ...original.outcome,
        unsafeDebugPayload: "must not enter the immutable result JSON",
      } as unknown as typeof original.outcome,
      derivatives: original.derivatives,
    };
    const database = mockedPool([
      { expect: "BEGIN" },
      { expect: "FROM attachment_preparation_attempts", rows: [current] },
      {
        expect: "FROM attachment_preparation_attempt_occurrences",
        rows: [
          {
            occurrence_identity: occurrence.identity,
            owner_identity: occurrence.ownerIdentity,
            source_ordinal: occurrence.sourceOrdinal,
            ordinal: occurrence.ordinal,
            attachment_id: occurrence.attachmentId,
            relation: occurrence.relation,
            required: occurrence.required,
          },
        ],
      },
      {
        expect: "INSERT INTO attachment_preparation_attempt_evidence",
        rows: [{ id: "attempt-a" }],
      },
      {
        expect: "UPDATE attachment_preparation_attempts",
        rows: [{ id: "attempt-a" }],
      },
      { expect: "COMMIT" },
    ]);
    const store = new PostgresAttachmentPreparationAttemptStore(database.pool);

    await expect(
      store.finalize({
        attempt: { id: "attempt-a", fence: "fence-a", planIdentity },
        result: prepared,
        evidence: [
          {
            occurrence,
            derivative: {
              id: "derivative-a",
              identity: {
                workspaceId,
                accessPolicyHash,
                contentSha256: "d".repeat(64),
                processor: "vision",
                processorVersion: "vision-v1",
                securityPolicyVersion: "security-v1",
                normalizationVersion: "normalization-v1",
                key: "derivative-cache-a",
              },
              status: "completed",
              output: {
                workspaceId,
                storageBackendId: "private-storage-backend",
                key: "very-private-storage-key",
              },
              mimeType: "text/plain",
              outputContentHash: derivativeContentHash,
              outputByteLength: 42,
            },
          },
        ],
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();

    expect(database.pending).toHaveLength(0);
    const serializedValues = JSON.stringify(
      database.query.mock.calls.flatMap(([, values]) => values ?? []),
    );
    expect(serializedValues).not.toContain("private derivative text");
    expect(serializedValues).not.toContain("unsafeDebugPayload");
    expect(serializedValues).not.toContain(
      "must not enter the immutable result JSON",
    );
    expect(serializedValues).not.toContain("private-storage-backend");
    expect(serializedValues).not.toContain("very-private-storage-key");
    expect(
      database.query.mock.calls.map(([statement]) => statement).join("\n"),
    ).toContain("lease_expires_at > statement_timestamp()");
  });

  it("completes a disabled policy without inventing unavailable evidence", async () => {
    const disabledPolicy: AttachmentPreparationPolicy = Object.freeze({
      mode: "disabled",
      policyVersion: "attachment-policy-disabled-v1",
      accessPolicyHash,
    });
    const current = {
      ...attemptRow(),
      policy_mode: disabledPolicy.mode,
      policy_version: disabledPolicy.policyVersion,
    };
    const disabledResult = createAttachmentPreparationResult({
      policy: disabledPolicy,
    });
    const database = mockedPool([
      { expect: "BEGIN" },
      { expect: "FROM attachment_preparation_attempts", rows: [current] },
      {
        expect: "FROM attachment_preparation_attempt_occurrences",
        rows: [
          {
            occurrence_identity: occurrence.identity,
            owner_identity: occurrence.ownerIdentity,
            source_ordinal: occurrence.sourceOrdinal,
            ordinal: occurrence.ordinal,
            attachment_id: occurrence.attachmentId,
            relation: occurrence.relation,
            required: occurrence.required,
          },
        ],
      },
      {
        expect: "UPDATE attachment_preparation_attempts",
        rows: [{ id: "attempt-a" }],
      },
      { expect: "COMMIT" },
    ]);
    const store = new PostgresAttachmentPreparationAttemptStore(database.pool);

    await expect(
      store.finalize({
        attempt: { id: "attempt-a", fence: "fence-a", planIdentity },
        result: disabledResult,
        evidence: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();

    expect(database.pending).toHaveLength(0);
    expect(
      database.query.mock.calls.some(([statement]) =>
        statement.includes("attachment_preparation_attempt_evidence"),
      ),
    ).toBe(false);
  });

  it("rolls back a stale finalizer before it can append evidence", async () => {
    const database = mockedPool([
      { expect: "BEGIN" },
      { expect: "FROM attachment_preparation_attempts", rows: [] },
      { expect: "ROLLBACK" },
    ]);
    const store = new PostgresAttachmentPreparationAttemptStore(database.pool);
    const prepared = result();

    await expect(
      store.finalize({
        attempt: { id: "attempt-a", fence: "stale-fence", planIdentity },
        result: prepared,
        evidence: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(
      PostgresAttachmentPreparationAttemptOwnershipError,
    );

    expect(database.pending).toHaveLength(0);
    expect(
      database.query.mock.calls.some(([statement]) =>
        statement.includes("attachment_preparation_attempt_evidence"),
      ),
    ).toBe(false);
  });
});
