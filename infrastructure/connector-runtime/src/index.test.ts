import { describe, expect, it, vi } from "vitest";
import {
  RuntimeConnectorCapabilityResolver,
  RuntimeConnectorCapabilityUnavailableError,
} from "./index.js";

const request = Object.freeze({
  workspaceId: "workspace-a",
  connectorRegistrationId: "connector-a",
  connectorConfigurationVersionId: "connector-version-a",
});

describe("RuntimeConnectorCapabilityResolver", () => {
  it("selects a contribution by the exact descriptor-backed immutable pin", async () => {
    const knowledgeSource = { discover: vi.fn(), load: vi.fn() };
    const resolver = new RuntimeConnectorCapabilityResolver(
      {
        resolve: vi.fn(async () =>
          Object.freeze({
            ...request,
            configurationVersionId: request.connectorConfigurationVersionId,
            descriptor: Object.freeze({
              kind: "connector" as const,
              type: "future",
              version: "1",
            }),
            settings: Object.freeze({}),
            secretReferences: Object.freeze([]),
          }),
        ),
      },
      [
        {
          descriptor: { kind: "connector", type: "future", version: "1" },
          create: vi.fn(async () => ({ knowledgeSource })),
        },
      ],
      { resolve: vi.fn() },
    );

    await expect(resolver.resolveKnowledgeSource(request)).resolves.toBe(
      knowledgeSource,
    );
  });

  it("fails closed before contribution construction when the private result is not the durable pin", async () => {
    const create = vi.fn();
    const resolver = new RuntimeConnectorCapabilityResolver(
      {
        resolve: vi.fn(async () =>
          Object.freeze({
            workspaceId: request.workspaceId,
            connectorRegistrationId: request.connectorRegistrationId,
            configurationVersionId: "successor-version",
            descriptor: Object.freeze({
              kind: "connector" as const,
              type: "future",
              version: "1",
            }),
            settings: Object.freeze({}),
            secretReferences: Object.freeze([]),
          }),
        ),
      },
      [
        {
          descriptor: { kind: "connector", type: "future", version: "1" },
          create,
        },
      ],
      { resolve: vi.fn() },
    );

    await expect(
      resolver.resolveKnowledgeSource(request),
    ).rejects.toBeInstanceOf(RuntimeConnectorCapabilityUnavailableError);
    expect(create).not.toHaveBeenCalled();
  });
});
