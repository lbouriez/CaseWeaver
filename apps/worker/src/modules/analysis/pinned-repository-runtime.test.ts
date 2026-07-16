import type {
  RepositoryAgentRuntime,
  RepositoryAgentRuntimePin,
} from "@caseweaver/ai-sdk";
import type { RepositoryRuntimeConfigurationResolver } from "@caseweaver/postgres";
import { describe, expect, it } from "vitest";

import { ComposedPinnedRepositoryAgentRuntimeResolver } from "./pinned-repository-runtime.js";

const pin: RepositoryAgentRuntimePin = {
  workspaceId: "workspace-a",
  runtimeVersionId: "repository-runtime-v1",
  repositoryId: "support-service",
  pinnedCommit: "a".repeat(40),
};

function configuration(
  repositoryId = pin.repositoryId,
): RepositoryRuntimeConfigurationResolver {
  return {
    resolve: async () => ({
      runtimeVersionId: pin.runtimeVersionId,
      repository: {
        repositoryId,
        pinnedCommit: pin.pinnedCommit,
        checkoutSecretReference: "vault:checkout/support-service",
      },
      allowedTools: ["readFile"],
      sandboxLimits: {
        timeoutMs: 1_000,
        maximumCpuMilliseconds: 1_000,
        maximumMemoryBytes: 16 * 1024 * 1024,
        maximumOutputBytes: 1_024,
        maximumToolCalls: 1,
      },
      execution: {
        bindingVersionId: "binding-a",
        maximumTurns: 1,
        maximumInputTokensPerTurn: 1,
        maximumOutputTokensPerTurn: 1,
        maximumInstructionCharacters: 1,
        budget: { currency: "USD", hard: true },
      },
    }),
  };
}

describe("ComposedPinnedRepositoryAgentRuntimeResolver", () => {
  it("returns only the exact immutable configuration to the attested runtime", async () => {
    const runtime = {
      run: async () => ({ summary: "", evidence: [] }),
    } as unknown as RepositoryAgentRuntime;
    const resolver = new ComposedPinnedRepositoryAgentRuntimeResolver(
      configuration(),
      runtime,
    );

    await expect(
      resolver.resolve(pin, new AbortController().signal),
    ).resolves.toMatchObject({
      repository: {
        repositoryId: pin.repositoryId,
        pinnedCommit: pin.pinnedCommit,
      },
      runtime,
      allowedTools: ["readFile"],
    });
  });

  it("fails closed when private runtime configuration does not match the pin", async () => {
    const runtime = {
      run: async () => ({ summary: "", evidence: [] }),
    } as unknown as RepositoryAgentRuntime;
    const resolver = new ComposedPinnedRepositoryAgentRuntimeResolver(
      configuration("other-service"),
      runtime,
    );

    await expect(
      resolver.resolve(pin, new AbortController().signal),
    ).rejects.toThrow("does not match");
  });
});
