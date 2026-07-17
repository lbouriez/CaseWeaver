import { describe, expect, it } from "vitest";

import { preparedAttachmentsFromSnapshotReferences } from "./repository-analysis-execution-input-store.js";

describe("preparedAttachmentsFromSnapshotReferences", () => {
  it("keeps separate case occurrences when they safely reuse one derivative", () => {
    const prepared = preparedAttachmentsFromSnapshotReferences([
      {
        occurrence_identity: "occurrence-1",
        attachment_id: "attachment-1",
        attachment_derivative_id: "derivative-1",
        output_content_hash: "a".repeat(64),
      },
      {
        occurrence_identity: "occurrence-2",
        attachment_id: "attachment-1",
        attachment_derivative_id: "derivative-1",
        output_content_hash: "a".repeat(64),
      },
    ]);

    expect(prepared.evidence).toEqual([
      expect.objectContaining({
        occurrenceIdentity: "occurrence-1",
        attachmentId: "attachment-1",
      }),
      expect.objectContaining({
        occurrenceIdentity: "occurrence-2",
        attachmentId: "attachment-1",
      }),
    ]);
  });

  it("rejects duplicate immutable occurrence evidence", () => {
    expect(() =>
      preparedAttachmentsFromSnapshotReferences([
        {
          occurrence_identity: "occurrence-1",
          attachment_id: "attachment-1",
          attachment_derivative_id: "derivative-1",
          output_content_hash: "a".repeat(64),
        },
        {
          occurrence_identity: "occurrence-1",
          attachment_id: "attachment-1",
          attachment_derivative_id: "derivative-1",
          output_content_hash: "a".repeat(64),
        },
      ]),
    ).toThrow();
  });
});
