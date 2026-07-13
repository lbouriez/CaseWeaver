import type { NormalizedCase } from "@caseweaver/connector-sdk";

export function createExampleCaseFixture(): NormalizedCase {
  return {
    reference: {
      connectorInstanceId: "example-connector",
      resourceType: "case",
      externalId: "case-1",
    },
    subject: "Example support request",
    lifecycle: "open",
    messages: [
      {
        externalId: "message-1",
        sequence: 0,
        visibility: "public",
        body: {
          format: "plainText",
          normalizedText: "The example service is unavailable.",
        },
        attachments: [],
      },
    ],
    attachments: [],
  };
}
