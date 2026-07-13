import type { ConnectorRegistration } from "./capabilities.js";
import {
  type ConnectorCursor,
  type ExternalReference,
  versionedOpaqueValue,
} from "./primitives.js";
import type { DiscoveredKnowledgeItem, NormalizedCase } from "./schemas.js";

export function createJitbitShapedCaseFixture(): NormalizedCase {
  return {
    reference: {
      connectorInstanceId: "helpdesk-fixture",
      resourceType: "case",
      externalId: "44",
    },
    externalRevision: versionedOpaqueValue("api-revision.v1", "108"),
    subject: "Cannot save invoice",
    lifecycle: "resolved",
    actors: {
      requester: {
        externalId: "requester-10",
        displayName: "Customer",
        kind: "person",
      },
      assignee: {
        externalId: "agent-7",
        displayName: "Support engineer",
        kind: "person",
      },
    },
    messages: [
      {
        externalId: "description",
        sequence: 0,
        visibility: "public",
        author: { externalId: "requester-10", kind: "person" },
        sentAt: "2026-01-02T10:00:00.000Z",
        body: {
          format: "html",
          original: "<p>Save fails with error 42.</p>",
          normalizedText: "Save fails with error 42.",
        },
        attachments: [],
      },
      {
        externalId: "note-2",
        sequence: 1,
        visibility: "internal",
        author: { externalId: "agent-7", kind: "person" },
        sentAt: "2026-01-02T11:00:00.000Z",
        body: {
          format: "plainText",
          normalizedText: "Reproduced with an expired tax configuration.",
        },
        attachments: [],
      },
      {
        externalId: "state-3",
        sequence: 2,
        visibility: "system",
        sentAt: "2026-01-02T12:00:00.000Z",
        body: {
          format: "plainText",
          normalizedText: "Case state changed to resolved.",
        },
        attachments: [],
      },
    ],
    attachments: [],
    resolution: {
      kind: "fixed",
      summary: "Renew the tax configuration before retrying.",
    },
  };
}

export function createOdooShapedCaseFixture(): NormalizedCase {
  return {
    reference: {
      connectorInstanceId: "erp-helpdesk-fixture",
      resourceType: "case",
      externalId: "HD-900",
    },
    subject: "Warehouse scanner is offline",
    lifecycle: "pending",
    actors: {
      company: {
        externalId: "company-1",
        displayName: "Example warehouse",
        kind: "organization",
      },
      participants: [
        { externalId: "operator-22", displayName: "Warehouse operator" },
      ],
    },
    messages: [
      {
        externalId: "mail-1",
        sequence: 10,
        visibility: "public",
        sentAt: "2026-01-03T09:00:00.000Z",
        body: {
          format: "html",
          normalizedText:
            "The scanner stopped connecting after the network change.",
        },
        attachments: [],
      },
      {
        externalId: "log-2",
        sequence: 20,
        visibility: "internal",
        author: { externalId: "service-1", kind: "service" },
        sentAt: "2026-01-03T09:03:00.000Z",
        body: {
          format: "plainText",
          normalizedText: "Device heartbeat is absent.",
        },
        attachments: [],
      },
    ],
    attachments: [],
  };
}

export const gitBlobFingerprintFixture: DiscoveredKnowledgeItem = {
  reference: {
    connectorInstanceId: "knowledge-fixture",
    resourceType: "document",
    externalId: "docs/troubleshooting.md",
  },
  fingerprint: versionedOpaqueValue("git-blob.v1", "2f4d0a"),
};

export const etagFingerprintFixture: DiscoveredKnowledgeItem = {
  reference: {
    connectorInstanceId: "helpdesk-fixture",
    resourceType: "case",
    externalId: "44",
  },
  fingerprint: versionedOpaqueValue("http-etag.v1", '"case-44-v108"'),
};

export const noFingerprintFixture: DiscoveredKnowledgeItem = {
  reference: {
    connectorInstanceId: "legacy-fixture",
    resourceType: "document",
    externalId: "legacy-1",
  },
};

export function createCapabilityLimitedFixture(): ConnectorRegistration {
  return {
    instanceId: "read-only-fixture",
    connectorType: "fixture",
    capabilities: {},
  };
}

export function cursorFixture(value: string): ConnectorCursor {
  return versionedOpaqueValue("fixture-cursor.v1", value);
}

export function referenceFixture(externalId: string): ExternalReference {
  return {
    connectorInstanceId: "fixture",
    resourceType: "item",
    externalId,
  };
}
