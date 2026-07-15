import { describe, expect, it, vi } from "vitest";

import { mapPrivacyPurge } from "./operation-dispatcher.js";
import { ExistingOperationsPreflight } from "./operations-preflight.js";

const context = {
  principalId: "principal-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  permissions: ["privacy.delete"],
  requestId: "request-1",
  correlationId: "correlation-1",
  requestMode: "user" as const,
};

function preflight(privacyTargets?: {
  exists: (input: {
    readonly workspaceId: string;
    readonly caseSnapshotId: string;
  }) => Promise<boolean>;
}) {
  return new ExistingOperationsPreflight({
    unitOfWork: {},
    operations: {},
    reads: {},
    ...(privacyTargets === undefined ? {} : { privacyTargets }),
  } as never);
}

describe("ExistingOperationsPreflight privacy purge", () => {
  it("fails closed without a workspace-scoped target reader and omits the reason", async () => {
    const reason = "Verified data-subject deletion request";
    const result = await preflight().preview({
      command: mapPrivacyPurge({ caseSnapshotId: "snapshot-1", reason })
        .command,
      context,
    });

    expect(result).toMatchObject({ canConfirm: false });
    expect(JSON.stringify(result)).not.toContain(reason);
  });

  it("uses only a workspace-scoped existence check and does not disclose the reason", async () => {
    const exists = vi.fn(async () => true);
    const reason = "Verified data-subject deletion request";
    const result = await preflight({ exists }).preview({
      command: mapPrivacyPurge({ caseSnapshotId: "snapshot-1", reason })
        .command,
      context,
    });

    expect(exists).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      caseSnapshotId: "snapshot-1",
    });
    expect(result).toMatchObject({ canConfirm: true });
    expect(JSON.stringify(result)).not.toContain(reason);
  });
});
