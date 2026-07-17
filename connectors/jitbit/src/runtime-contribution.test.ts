import {
  ConnectorCancelledError,
  InMemoryConnectorSecretResolver,
} from "@caseweaver/connector-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  createJitbitRuntimeContribution,
  createJitbitRuntimeContributions,
} from "./runtime-contribution.js";

const locator = "env:JITBIT_TOKEN";
const token = "jitbit-production-token";

function privateConfiguration(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const { descriptor, settings, secretReferences, ...rest } = overrides;
  return {
    workspaceId: "workspace-1",
    connectorRegistrationId: "connector-1",
    configurationVersionId: "connector-version-1",
    descriptor: {
      kind: "connector" as const,
      type: "jitbit",
      version: "4",
      ...(descriptor as Record<string, unknown> | undefined),
    },
    settings: {
      connectorInstanceId: "connector-1",
      baseUrl: "https://helpdesk.example.test",
      apiTokenSecretName: locator,
      requestTimeoutMs: 5_000,
      ...(settings as Record<string, unknown> | undefined),
    },
    secretReferences: [
      { locator },
      ...((secretReferences as
        | readonly { readonly locator: string }[]
        | undefined) ?? []),
    ],
    ...rest,
  };
}

describe("Jitbit runtime contribution", () => {
  it("constructs only declared ports from an exact immutable configuration", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${token}`,
      );
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const secrets = new InMemoryConnectorSecretResolver({ [locator]: token });
    const contribution = createJitbitRuntimeContribution({ fetch });

    const ports = await contribution.create({
      configuration: privateConfiguration(),
      secrets,
    });

    expect(contribution.descriptor).toEqual({
      kind: "connector",
      type: "jitbit",
      version: "4",
    });
    expect(ports).toEqual(
      expect.objectContaining({
        knowledgeSource: expect.anything(),
        caseSource: expect.anything(),
        attachmentSource: expect.anything(),
        analysisDestination: expect.anything(),
      }),
    );
    expect(secrets.calls).toEqual([]);

    for await (const _page of ports.knowledgeSource.discover({
      signal: new AbortController().signal,
    })) {
      // Consume the discovery call, which is where the secret is resolved.
    }

    expect(fetch).toHaveBeenCalledOnce();
    expect(secrets.calls).toEqual([locator]);
  });

  it("preserves cancellation before secret resolution or remote I/O", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const secrets = new InMemoryConnectorSecretResolver({ [locator]: token });
    const ports = await createJitbitRuntimeContribution({ fetch }).create({
      configuration: privateConfiguration(),
      secrets,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(async () => {
      for await (const _page of ports.caseSource.discoverCases({
        signal: controller.signal,
      })) {
        // No pages are expected.
      }
    }).rejects.toBeInstanceOf(ConnectorCancelledError);

    expect(secrets.calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects mismatched private configuration without disclosing locators or values", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const secrets = new InMemoryConnectorSecretResolver({ [locator]: token });
    const contribution = createJitbitRuntimeContribution({ fetch });

    let failure: unknown;
    try {
      await contribution.create({
        configuration: privateConfiguration({
          secretReferences: [{ locator: "env:OTHER_JITBIT_TOKEN" }],
        }),
        secrets,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "connector.configuration",
      category: "configuration",
      retryable: false,
    });
    expect(String(failure)).not.toContain(locator);
    expect(String(failure)).not.toContain(token);
    expect(secrets.calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains descriptor versions one, two, and three while new construction uses version four", async () => {
    const secrets = new InMemoryConnectorSecretResolver({ [locator]: token });
    const [legacy, versionTwo, versionThree, current] =
      createJitbitRuntimeContributions({});
    if (
      legacy === undefined ||
      versionTwo === undefined ||
      versionThree === undefined ||
      current === undefined
    ) {
      throw new Error(
        "All retained Jitbit descriptor contributions are required.",
      );
    }

    await expect(
      legacy.create({
        configuration: privateConfiguration({
          descriptor: { version: "1" },
          settings: { timeoutMs: 1_500, requestTimeoutMs: undefined },
        }),
        secrets,
      }),
    ).resolves.toBeDefined();
    await expect(
      versionTwo.create({
        configuration: privateConfiguration({ descriptor: { version: "2" } }),
        secrets,
      }),
    ).resolves.toBeDefined();
    await expect(
      versionTwo.create({
        configuration: privateConfiguration({ settings: { timeoutMs: 1_500 } }),
        secrets,
      }),
    ).rejects.toThrow("Jitbit runtime is unavailable");
    await expect(
      versionThree.create({
        configuration: privateConfiguration({ descriptor: { version: "3" } }),
        secrets,
      }),
    ).resolves.toBeDefined();
    expect(current.descriptor.version).toBe("4");
  });
});
