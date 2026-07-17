import {
  analysisProfileVersionId,
  analysisTriggerId,
  analysisTriggerRequestId,
  analysisTriggerVersionId,
  principalId,
  sha256Digest,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it } from "vitest";

import {
  NormalizedCaseProjectionError,
  NormalizedCaseSnapshotProjector,
} from "./normalized-case-projector.js";

const request = {
  id: analysisTriggerRequestId("request-1"),
  workspaceId: workspaceId("workspace-1"),
  actorPrincipalId: principalId("principal-1"),
  triggerId: analysisTriggerId("trigger-1"),
  triggerVersionId: analysisTriggerVersionId("trigger-version-1"),
  analysisProfileVersionId: analysisProfileVersionId("profile-version-1"),
  connectorRegistrationId: "connector-1",
  connectorConfigurationVersionId: "connector-configuration-1",
  source: "manual" as const,
  target: {
    connectorInstanceId: "connector-1",
    resourceType: "case",
    externalId: "case-1",
  },
  idempotencyKeyDigest: sha256Digest("a".repeat(64)),
  requestDigest: sha256Digest("b".repeat(64)),
};

describe("NormalizedCaseSnapshotProjector", () => {
  it("projects normalized case content and deterministic attachment references", async () => {
    const projector = new NormalizedCaseSnapshotProjector({
      now: () => utcInstant("2026-07-15T20:00:00.000Z"),
    });
    const snapshot = await projector.project({
      request,
      signal: new AbortController().signal,
      normalizedCase: {
        reference: request.target,
        subject: "Customer cannot sign in",
        messages: [
          {
            externalId: "message-1",
            sequence: 0,
            visibility: "internal",
            body: { format: "plainText", normalizedText: "Sign-in fails." },
            attachments: [
              {
                reference: {
                  connectorInstanceId: "connector-1",
                  resourceType: "attachment",
                  externalId: "attachment-2",
                },
              },
            ],
          },
        ],
        attachments: [
          {
            reference: {
              connectorInstanceId: "connector-1",
              resourceType: "attachment",
              externalId: "attachment-1",
            },
          },
        ],
      },
    });

    expect(snapshot).toMatchObject({
      capturedAt: "2026-07-15T20:00:00.000Z",
      title: "Customer cannot sign in",
      summary: "Sign-in fails.",
      attachmentReferences: [
        {
          connectorRegistrationId: "connector-1",
          resourceType: "attachment",
          externalId: "attachment-1",
        },
        {
          connectorRegistrationId: "connector-1",
          resourceType: "attachment",
          externalId: "attachment-2",
        },
      ],
    });
    expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.messages).toHaveLength(1);
  });

  it("rejects a cross-connector attachment before persistence", async () => {
    const projector = new NormalizedCaseSnapshotProjector({
      now: () => utcInstant("2026-07-15T20:00:00.000Z"),
    });

    await expect(
      projector.project({
        request,
        signal: new AbortController().signal,
        normalizedCase: {
          reference: request.target,
          messages: [],
          attachments: [
            {
              reference: {
                connectorInstanceId: "other-connector",
                resourceType: "attachment",
                externalId: "attachment-1",
              },
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(NormalizedCaseProjectionError);
  });

  it("retains distinct occurrence identities when two locations name one binary", async () => {
    const projector = new NormalizedCaseSnapshotProjector({
      now: () => utcInstant("2026-07-15T20:00:00.000Z"),
    });
    const attachment = {
      connectorInstanceId: "connector-1",
      resourceType: "attachment",
      externalId: "shared-image",
    };
    const snapshot = await projector.project({
      request,
      signal: new AbortController().signal,
      normalizedCase: {
        reference: request.target,
        messages: [],
        attachmentOccurrences: [
          {
            owner: { kind: "case", case: request.target },
            ordinal: 0,
            relation: "inlineImage",
            reference: attachment,
            locator: { version: "fixture.v1", value: "privateone" },
          },
          {
            owner: { kind: "case", case: request.target },
            ordinal: 1,
            relation: "inlineImage",
            reference: attachment,
            locator: { version: "fixture.v1", value: "privatetwo" },
          },
        ],
      },
    });

    expect(snapshot.attachmentReferences).toHaveLength(2);
    expect(snapshot.attachmentReferences?.map((value) => value.occurrenceIdentity)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/u)]),
    );
    expect(new Set(snapshot.attachmentReferences?.map((value) => value.occurrenceIdentity))).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toContain("private-one");
    expect(JSON.stringify(snapshot)).not.toContain("private-two");
  });
});
