import type {
  RuntimeConnectorConfigurationResolver,
  ServerPrivateConnectorConfiguration,
} from "@caseweaver/administration";
import {
  RuntimeConnectorCapabilityResolver,
  RuntimeConnectorCapabilityUnavailableError,
} from "@caseweaver/connector-runtime";
import { InMemoryConnectorSecretResolver } from "@caseweaver/connector-sdk";
import { describe, expect, it, vi } from "vitest";

import { createJitbitRuntimeContributions } from "./runtime-contribution.js";

const workspaceId = "workspace-1";
const connectorRegistrationId = "connector-1";
const connectorConfigurationVersionId = "connector-version-1";
const locator = "env:JITBIT_TOKEN";
const token = "jitbit-production-token";

const currentDescriptor = Object.freeze({
  kind: "connector" as const,
  type: "jitbit",
  version: "2",
});

const legacyDescriptor = Object.freeze({
  kind: "connector" as const,
  type: "jitbit",
  version: "1",
});

function configuration(
  input: Readonly<{
    readonly configurationVersionId?: string;
    readonly descriptor?: ServerPrivateConnectorConfiguration["descriptor"];
    readonly settings?: Readonly<Record<string, unknown>>;
  }> = {},
): ServerPrivateConnectorConfiguration {
  return Object.freeze({
    workspaceId,
    connectorRegistrationId,
    configurationVersionId:
      input.configurationVersionId ?? connectorConfigurationVersionId,
    descriptor: input.descriptor ?? currentDescriptor,
    settings: Object.freeze(
      input.settings ?? {
        connectorInstanceId: connectorRegistrationId,
        baseUrl: "https://helpdesk.example.test",
        apiTokenSecretName: locator,
        requestTimeoutMs: 5_000,
      },
    ),
    secretReferences: Object.freeze([Object.freeze({ locator })]),
  });
}

function configurationResolver(
  value: ServerPrivateConnectorConfiguration | undefined,
): RuntimeConnectorConfigurationResolver {
  return Object.freeze({
    resolve: vi.fn(async () => value),
  });
}

function runtime(
  configurations: RuntimeConnectorConfigurationResolver,
  secrets: InMemoryConnectorSecretResolver,
  fetch: typeof globalThis.fetch,
) {
  return new RuntimeConnectorCapabilityResolver(
    configurations,
    createJitbitRuntimeContributions({ fetch }),
    secrets,
  );
}

const request = Object.freeze({
  workspaceId,
  connectorRegistrationId,
  connectorConfigurationVersionId,
});

describe("Jitbit runtime contribution consumer contract", () => {
  it("uses the exact durable configuration pin before constructing a knowledge source", async () => {
    const privateConfiguration = configuration();
    const configurations = configurationResolver(privateConfiguration);
    const secrets = new InMemoryConnectorSecretResolver({ [locator]: token });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${token}`,
      );
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const resolver = runtime(configurations, secrets, fetch);

    const source = await resolver.resolveKnowledgeSource(request);

    expect(configurations.resolve).toHaveBeenCalledWith({
      workspaceId,
      connectorRegistrationId,
      configurationVersionId: connectorConfigurationVersionId,
      requiredCapability: "knowledgeSource",
    });
    expect(secrets.calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();

    for await (const _page of source.discover({
      signal: new AbortController().signal,
    })) {
      // Consume the only Jitbit discovery page.
    }

    expect(secrets.calls).toEqual([locator]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("selects the retained revision-one contribution for legacy immutable configuration", async () => {
    const configurations = configurationResolver(
      configuration({
        descriptor: legacyDescriptor,
        settings: {
          connectorInstanceId: connectorRegistrationId,
          baseUrl: "https://helpdesk.example.test",
          apiTokenSecretName: locator,
          timeoutMs: 1_500,
        },
      }),
    );
    const secrets = new InMemoryConnectorSecretResolver({ [locator]: token });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const source = await runtime(
      configurations,
      secrets,
      fetch,
    ).resolveKnowledgeSource(request);
    for await (const _page of source.discover({
      signal: new AbortController().signal,
    })) {
      // Consume the legacy contribution's discovery page.
    }

    expect(fetch).toHaveBeenCalledOnce();
    expect(secrets.calls).toEqual([locator]);
  });

  it("fails unknown descriptors and mismatched pins before secret or remote I/O", async () => {
    const secrets = new InMemoryConnectorSecretResolver({ [locator]: token });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const unknownDescriptor = configuration({
      descriptor: {
        kind: "connector",
        type: "unknown",
        version: "1",
      },
    });
    const mismatchedPin = configuration({
      configurationVersionId: "other-connector-version",
    });

    for (const privateConfiguration of [unknownDescriptor, mismatchedPin]) {
      const resolver = runtime(
        configurationResolver(privateConfiguration),
        secrets,
        fetch,
      );
      let failure: unknown;
      try {
        await resolver.resolveKnowledgeSource(request);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(
        RuntimeConnectorCapabilityUnavailableError,
      );
      expect(String(failure)).not.toContain(locator);
      expect(String(failure)).not.toContain(token);
    }

    expect(secrets.calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
