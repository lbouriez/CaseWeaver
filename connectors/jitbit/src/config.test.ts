import { redactConnectorConfiguration } from "@caseweaver/connector-sdk";
import { describe, expect, it } from "vitest";

import { createJitbitConfiguration } from "./fakes.js";

describe("Jitbit configuration", () => {
  it("stores only a secret reference and redacts it for diagnostics", () => {
    const configuration = createJitbitConfiguration();

    expect(configuration.secrets.apiToken).toBe("vault:jitbit-token");
    expect(redactConnectorConfiguration(configuration).secrets).toEqual({
      apiToken: "[redacted]",
    });
    expect(configuration.settings.discoveryPageSize).toBe(100);
  });

  it("rejects insecure endpoint and a missing token reference", () => {
    expect(() =>
      createJitbitConfiguration({ baseUrl: "http://helpdesk.example.invalid" }),
    ).toThrow(/HTTPS/);
    expect(() =>
      createJitbitConfiguration({
        apiTokenSecretName: "otherToken",
        secrets: { apiToken: "vault:jitbit-token" },
      }),
    ).toThrow(/secret reference is required/);
  });
});
