import type { AiExecutionGateway } from "@caseweaver/ai-execution";
import type { RepositoryRuntimeExecutionConfigurationResolver } from "@caseweaver/postgres";
import { describe, expect, it, vi } from "vitest";

import {
  PinnedRepositoryInvestigationPort,
  RepositoryInvestigationRuntimeError,
} from "./repository-investigation.js";

const pin = {
  workspaceId: "workspace-a",
  runtimeVersionId: "repository-runtime-v1",
  repositoryId: "support-service",
  pinnedCommit: "a".repeat(40),
};

function resolver(
  bindingVersionId = "repository-agent-binding-v1",
): RepositoryRuntimeExecutionConfigurationResolver {
  return {
    resolveExecution: async () => ({
      runtimeVersionId: pin.runtimeVersionId,
      repositoryId: pin.repositoryId,
      pinnedCommit: pin.pinnedCommit,
      allowedTools: ["listFiles", "readFile"],
      sandboxLimits: {
        timeoutMs: 120_000,
        maximumCpuMilliseconds: 120_000,
        maximumMemoryBytes: 512 * 1024 * 1024,
        maximumOutputBytes: 1_048_576,
        maximumToolCalls: 30,
      },
      execution: {
        bindingVersionId,
        maximumTurns: 3,
        maximumInputTokensPerTurn: 100,
        maximumOutputTokensPerTurn: 20,
        maximumInstructionCharacters: 64_000,
        budget: { currency: "USD", hard: true },
      },
    }),
  };
}

function input() {
  return {
    execution: {
      workspaceId: pin.workspaceId,
      analysisJobId: "analysis-job-a",
      analysisIdentityId: "analysis-identity-a",
    },
    runtimeVersionId: pin.runtimeVersionId,
    bindingVersionId: "repository-agent-binding-v1",
    repositoryId: pin.repositoryId,
    pinnedCommit: pin.pinnedCommit,
    caseSummary: "The support workflow reports an unavailable dependency.",
    evidence: [],
    signal: new AbortController().signal,
  };
}

describe("PinnedRepositoryInvestigationPort", () => {
  it("executes only through the metered AI gateway and retains source-free pinned locations", async () => {
    const execute = vi.fn(async () => ({
      operationId: "ai-operation-a",
      value: {
        summary: "A source excerpt that must never become analysis evidence.",
        evidence: [{ path: "src/service.ts", startLine: 2, endLine: 5 }],
        metering: { mode: "aggregate" as const },
      },
      calculatedCost: {
        status: "known" as const,
        amount: "0.01",
        currency: "USD",
      },
    }));
    const port = new PinnedRepositoryInvestigationPort(
      { execute } as unknown as AiExecutionGateway,
      resolver(),
    );

    const result = await port.investigate(input() as never);

    expect(execute).toHaveBeenCalledOnce();
    const [request, context] = execute.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(request).toMatchObject({
      kind: "repositoryAgent",
      role: "repositoryAgent",
      bindingVersionId: "repository-agent-binding-v1",
      request: {
        runtimePin: pin,
        maximumTurns: 3,
        maximumInputTokensPerTurn: 100,
        maximumOutputTokensPerTurn: 20,
      },
      budget: { currency: "USD", hard: true },
    });
    expect(context).toMatchObject({ workspaceId: "workspace-a" });
    expect(JSON.stringify(request)).not.toContain(
      "vault:checkout/support-service",
    );
    expect(result).toMatchObject({
      summary: "Pinned repository investigation completed.",
      operationIds: ["ai-operation-a"],
      evidence: [
        {
          kind: "repository",
          repositoryId: "support-service",
          commit: "a".repeat(40),
          path: "src/service.ts",
          startLine: 2,
          endLine: 5,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("source excerpt");
  });

  it("fails before provider dispatch when the retained runtime binding differs", async () => {
    const execute = vi.fn();
    const port = new PinnedRepositoryInvestigationPort(
      { execute } as unknown as AiExecutionGateway,
      resolver("other-binding"),
    );

    await expect(port.investigate(input() as never)).rejects.toBeInstanceOf(
      RepositoryInvestigationRuntimeError,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
