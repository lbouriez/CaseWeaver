import { redactConnectorConfiguration } from "@caseweaver/connector-sdk";
import { describe, expect, it } from "vitest";

import {
  jitbitAdministrationDescriptor,
  jitbitAdministrationDescriptorRevisions,
  legacyJitbitAdministrationDescriptor,
  previousJitbitAdministrationDescriptor,
  validateJitbitAdministrationSettings,
  versionTwoJitbitAdministrationDescriptor,
} from "./administration-descriptor.js";
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

  it("publishes the current immutable descriptor revision with the schema timeout field", () => {
    expect(jitbitAdministrationDescriptor.version).toBe("4");
    expect(
      jitbitAdministrationDescriptor.settingsSchema.properties,
    ).toHaveProperty("requestTimeoutMs");
    expect(
      jitbitAdministrationDescriptor.settingsSchema.properties,
    ).not.toHaveProperty("timeoutMs");
    expect(legacyJitbitAdministrationDescriptor.version).toBe("1");
    expect(
      legacyJitbitAdministrationDescriptor.settingsSchema.properties,
    ).toHaveProperty("timeoutMs");
    expect(jitbitAdministrationDescriptorRevisions).toEqual([
      legacyJitbitAdministrationDescriptor,
      versionTwoJitbitAdministrationDescriptor,
      previousJitbitAdministrationDescriptor,
      jitbitAdministrationDescriptor,
    ]);
    expect(jitbitAdministrationDescriptor.connectorCapabilities).toContain(
      "attachmentSource",
    );
    expect(
      previousJitbitAdministrationDescriptor.connectorCapabilities,
    ).not.toContain("attachmentSource");
  });

  it("validates the current descriptor shape against the authoritative settings schema", () => {
    expect(
      validateJitbitAdministrationSettings({
        connectorInstanceId: "jitbit-support",
        baseUrl: "https://helpdesk.example.test",
        apiTokenReference: "env:JITBIT_TOKEN",
        requestTimeoutMs: 1_500,
      }),
    ).toMatchObject({
      apiTokenSecretName: "env:JITBIT_TOKEN",
      requestTimeoutMs: 1_500,
    });
    expect(() =>
      validateJitbitAdministrationSettings({
        connectorInstanceId: "jitbit-support",
        baseUrl: "https://helpdesk.example.test",
        apiTokenReference: "env:JITBIT_TOKEN",
        timeoutMs: 1_500,
      }),
    ).toThrow();
  });
});
