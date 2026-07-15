import { describe, expect, it } from "vitest";

import {
  runtimeDescriptorRegistration,
  runtimeDescriptorRegistrations,
} from "./runtime-descriptors.js";

describe("runtime descriptor registrations", () => {
  it("exposes adapter-provided descriptors without shared vendor branches", () => {
    expect(
      runtimeDescriptorRegistrations.map((item) => item.descriptor.type),
    ).toEqual([
      "git-markdown",
      "jitbit",
      "openai-compatible",
      "copilot-sdk-agent",
    ]);
  });

  it("normalizes only a secret reference into immutable metadata", () => {
    const registration = runtimeDescriptorRegistration("connector", "jitbit");
    expect(registration).toBeDefined();
    const settings = registration?.validateSettings({
      connectorInstanceId: "jitbit-support",
      baseUrl: "https://helpdesk.example.test",
      apiTokenReference: "vault:jitbit/support",
    });
    expect(settings).toMatchObject({
      apiTokenSecretName: "vault:jitbit/support",
    });
    expect(registration?.secretReferenceIds(settings ?? {})).toEqual([
      "vault:jitbit/support",
    ]);
  });
});
