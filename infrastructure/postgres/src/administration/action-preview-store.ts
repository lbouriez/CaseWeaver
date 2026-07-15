import type {
  AdministrationActionPreviewStore,
  AdministrationOperationCommand,
  StoredAdministrationActionPreview,
} from "@caseweaver/administration";
import {
  administrationOperationActions,
  requiredOperationPermission,
  validateOperationCommand,
} from "@caseweaver/administration";
import { principalId, sha256Digest, workspaceId } from "@caseweaver/domain";
import type { Permission } from "@caseweaver/security";
import type { Prisma, PrismaClient } from "@prisma/client";

interface PreviewRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly principal_id: string;
  readonly session_id: string;
  readonly action: string;
  readonly command: unknown;
  readonly parameter_digest: string;
  readonly permission: string;
  readonly confirmation: string;
  readonly impact: string;
  readonly can_confirm: boolean;
  readonly estimated_cost: unknown;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
}

function safeJson(value: unknown): Prisma.InputJsonObject {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Administration preview command is invalid.");
  }
  return parsed as Prisma.InputJsonObject;
}

function iso(value: Date): string {
  return value.toISOString();
}

function parseCost(
  value: unknown,
):
  | Readonly<{ readonly amount: string; readonly currency: string }>
  | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.amount === "string" &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(record.amount) &&
    typeof record.currency === "string" &&
    /^[A-Z]{3}$/u.test(record.currency)
    ? Object.freeze({ amount: record.amount, currency: record.currency })
    : undefined;
}

function asStored(row: PreviewRow): StoredAdministrationActionPreview {
  if (
    !(administrationOperationActions as readonly string[]).includes(row.action)
  ) {
    throw new Error("Persisted administration preview action is invalid.");
  }
  const command = validateOperationCommand(
    row.command as AdministrationOperationCommand,
  );
  if (
    command.action !== row.action ||
    requiredOperationPermission(command.action) !== row.permission
  ) {
    throw new Error("Persisted administration preview authority is invalid.");
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(row.id) ||
    !/^[a-fA-F0-9]{64}$/u.test(row.parameter_digest) ||
    row.confirmation.length < 1 ||
    row.confirmation.length > 500 ||
    row.impact.length < 1 ||
    row.impact.length > 2_000
  ) {
    throw new Error("Persisted administration preview is invalid.");
  }
  const estimatedCost = parseCost(row.estimated_cost);
  if (row.estimated_cost !== null && estimatedCost === undefined) {
    throw new Error("Persisted administration preview cost is invalid.");
  }
  return Object.freeze({
    id: row.id,
    workspaceId: workspaceId(row.workspace_id),
    principalId: principalId(row.principal_id),
    sessionId: row.session_id,
    action: command.action,
    target: command.target,
    command,
    parameterDigest: sha256Digest(row.parameter_digest),
    permission: row.permission as Permission,
    confirmation: row.confirmation,
    impact: row.impact,
    canConfirm: row.can_confirm,
    ...(estimatedCost === undefined ? {} : { estimatedCost }),
    expiresAt: iso(row.expires_at),
    ...(row.consumed_at === null ? {} : { consumedAt: iso(row.consumed_at) }),
  });
}

/** Durable one-use previews bound to a server session, principal, and workspace. */
export class PostgresAdministrationActionPreviewStore
  implements AdministrationActionPreviewStore
{
  public constructor(private readonly client: PrismaClient) {}

  public async create(
    preview: StoredAdministrationActionPreview,
  ): Promise<void> {
    validateOperationCommand(preview.command);
    if (
      preview.action !== preview.command.action ||
      preview.permission !== requiredOperationPermission(preview.action)
    ) {
      throw new Error("Administration preview authority is invalid.");
    }
    await this.client.administrationActionPreview.create({
      data: {
        id: preview.id,
        workspaceId: preview.workspaceId,
        principalId: preview.principalId,
        sessionId: preview.sessionId,
        action: preview.action,
        command: safeJson(preview.command),
        parameterDigest: preview.parameterDigest,
        permission: preview.permission,
        confirmation: preview.confirmation,
        impact: preview.impact,
        canConfirm: preview.canConfirm,
        ...(preview.estimatedCost === undefined
          ? {}
          : { estimatedCost: safeJson(preview.estimatedCost) }),
        expiresAt: new Date(preview.expiresAt),
      },
    });
  }

  public async consume(
    input: Readonly<{
      readonly previewId: string;
      readonly workspaceId: string;
      readonly principalId: string;
      readonly sessionId: string;
      readonly now: string;
    }>,
  ): Promise<StoredAdministrationActionPreview | undefined> {
    const rows = await this.client.$queryRaw<readonly PreviewRow[]>`
      UPDATE administration_action_previews
      SET consumed_at = ${new Date(input.now)}
      WHERE id = ${input.previewId}
        AND workspace_id = ${input.workspaceId}
        AND principal_id = ${input.principalId}
        AND session_id = ${input.sessionId}
        AND consumed_at IS NULL
        AND expires_at > ${new Date(input.now)}
      RETURNING id, workspace_id, principal_id, session_id, action, command,
        parameter_digest, permission, confirmation, impact, can_confirm,
        estimated_cost, expires_at, consumed_at
    `;
    const row = rows[0];
    return row === undefined ? undefined : asStored(row);
  }
}
