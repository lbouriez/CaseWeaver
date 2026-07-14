import { describe, expect, it } from "vitest";

import {
  loadRuntimeConfig,
  parseRuntimeConfig,
  RuntimeConfigurationError,
} from "./runtime-config.js";

describe("runtime configuration", () => {
  it("accepts an HTTPS API URL and a bounded UI title", () => {
    expect(
      parseRuntimeConfig({
        apiBaseUrl: "https://caseweaver.example.test/api/",
        uiTitle: "CaseWeaver East",
      }),
    ).toEqual({
      apiBaseUrl: "https://caseweaver.example.test/api",
      uiTitle: "CaseWeaver East",
    });
  });

  it.each([
    { apiBaseUrl: "http://caseweaver.example.test", uiTitle: "Control" },
    { apiBaseUrl: "https://user:pass@example.test", uiTitle: "Control" },
    { apiBaseUrl: "https://example.test?x=1", uiTitle: "Control" },
    { apiBaseUrl: "https://example.test", uiTitle: "" },
  ])("rejects insecure or malformed deployment values", (value) => {
    expect(() => parseRuntimeConfig(value)).toThrow(RuntimeConfigurationError);
  });

  it("permits HTTP only for a local development host", () => {
    expect(
      parseRuntimeConfig({
        apiBaseUrl: "http://localhost:3000",
        uiTitle: "Local control room",
      }).apiBaseUrl,
    ).toBe("http://localhost:3000");
  });

  it("does not expose JSON or network parsing failures", async () => {
    await expect(
      loadRuntimeConfig(
        async () =>
          new Response("not json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    ).rejects.toThrow(RuntimeConfigurationError);
  });
});
