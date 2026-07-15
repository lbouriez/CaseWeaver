import { randomUUID } from "node:crypto";

import { deserializeEnvelope, type EnvelopeFor } from "@caseweaver/domain";
import type { PrismaClient } from "@prisma/client";

const diagnosticExportType = "diagnostics.export.generate.v1";

export interface ClaimedDiagnosticExportEnvelope {
  readonly envelope: EnvelopeFor<"diagnostics.export.generate.v1">;
  readonly claimToken: string;
}

/**
 * PBI-016-owned filtered outbox dispatcher. It never claims unrelated work, so
 * the diagnostics worker can be deployed independently while retaining normal
 * durable-outbox leasing and acknowledgement semantics.
 */
export class PostgresDiagnosticExportDispatchStore {
  public constructor(private readonly client: PrismaClient) {}

  public async claim(
    input: Readonly<{
      readonly limit: number;
      readonly leaseMs: number;
      readonly now: string;
    }>,
  ): Promise<readonly ClaimedDiagnosticExportEnvelope[]> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new RangeError(
        "Diagnostic export outbox claim limit must be between 1 and 100.",
      );
    }
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new RangeError(
        "Diagnostic export outbox lease duration must be positive.",
      );
    }
    const now = timestamp(input.now);
    const claimToken = randomUUID();
    const rows = await this.client.$queryRaw<
      readonly Readonly<{
        readonly id: string;
        readonly workspace_id: string;
        readonly kind: string;
        readonly type: string;
        readonly schema_version: number;
        readonly occurred_at: Date;
        readonly correlation_id: string;
        readonly causation_id: string;
        readonly trace_context: unknown;
        readonly payload: unknown;
      }>[]
    >`
      WITH selected AS (
        SELECT id
        FROM outbox_envelopes
        WHERE type = ${diagnosticExportType}
          AND delivered_at IS NULL
          AND available_at <= ${now}
          AND (claimed_until IS NULL OR claimed_until <= ${now})
        ORDER BY occurred_at, id
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_envelopes AS envelope
      SET claim_token = ${claimToken},
          claimed_until = ${new Date(now.getTime() + input.leaseMs)},
          claim_attempts = envelope.claim_attempts + 1
      FROM selected
      WHERE envelope.id = selected.id
      RETURNING envelope.id, envelope.workspace_id, envelope.kind, envelope.type,
        envelope.schema_version, envelope.occurred_at, envelope.correlation_id,
        envelope.causation_id, envelope.trace_context, envelope.payload
    `;
    return Object.freeze(
      rows.map((row) => {
        const envelope = deserializeEnvelope({
          id: row.id,
          workspaceId: row.workspace_id,
          kind: row.kind,
          type: row.type,
          schemaVersion: row.schema_version,
          occurredAt: row.occurred_at.toISOString(),
          correlationId: row.correlation_id,
          causationId: row.causation_id,
          ...(row.trace_context === null
            ? {}
            : { traceContext: row.trace_context }),
          payload: row.payload,
        });
        if (envelope.type !== diagnosticExportType) {
          throw new Error(
            "Diagnostic export dispatcher received an invalid envelope.",
          );
        }
        return Object.freeze({
          envelope,
          claimToken,
        });
      }),
    );
  }

  public async acknowledge(
    input: Readonly<{
      readonly claim: ClaimedDiagnosticExportEnvelope;
      readonly deliveredAt: string;
    }>,
  ): Promise<void> {
    const updated = await this.client.$executeRaw`
      UPDATE outbox_envelopes
      SET delivered_at = ${timestamp(input.deliveredAt)},
          claim_token = NULL,
          claimed_until = NULL
      WHERE id = ${input.claim.envelope.id}
        AND workspace_id = ${input.claim.envelope.workspaceId}
        AND type = ${diagnosticExportType}
        AND claim_token = ${input.claim.claimToken}
        AND delivered_at IS NULL
    `;
    if (updated !== 1) {
      throw new Error("Diagnostic export outbox claim is no longer active.");
    }
  }
}

function timestamp(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new RangeError("Diagnostic export dispatcher timestamp is invalid.");
  }
  return date;
}
