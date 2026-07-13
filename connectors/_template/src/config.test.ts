import { describe, expect, it } from "vitest";

import { exampleConnectorConfigurationSchema } from "./config.js";
import { createExampleCaseFixture } from "./fakes.js";

describe("example connector boundary", () => {
  it("parses secret references and produces a normalized fixture", () => {
    expect(
      exampleConnectorConfigurationSchema.parse({
        schemaVersion: 1,
        connectorType: "example",
        secrets: { apiToken: "vault:example-token" },
        settings: {
          connectorInstanceId: "example-connector",
          baseUrl: "https://example.invalid",
          projectId: "project-1",
        },
      }).secrets.apiToken,
    ).toBe("vault:example-token");

    expect(createExampleCaseFixture().messages[0]?.visibility).toBe("public");
  });
});
