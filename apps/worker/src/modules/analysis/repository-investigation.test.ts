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
    repository: {
      repositoryId: pin.repositoryId,
      repositoryVersionId: "support-service-v2",
      runtimePinId: pin.runtimeVersionId,
      executionPolicyId: "sandbox-policy",
      executionPolicyVersionId: "sandbox-policy-v1",
      repositoryAgentBindingVersionId: "repository-agent-binding-v1",
      pinnedCommit: pin.pinnedCommit,
      resolvedAt: "2026-07-16T00:00:00.000Z",
    },
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
        summary: "The retry path handles the unavailable dependency.",
        evidence: [
          {
            id: `repository-evidence-${"b".repeat(64)}`,
            path: "src/service.ts",
            startLine: 2,
            endLine: 5,
            excerptHash: "c".repeat(64),
          },
        ],
        findings: [
          {
            id: `repository-finding-${"d".repeat(64)}`,
            summary: "The retry path handles the unavailable dependency.",
            evidenceIds: [`repository-evidence-${"b".repeat(64)}`],
          },
        ],
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
      summary: "The retry path handles the unavailable dependency.",
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
    expect(result.findings).toEqual([
      expect.objectContaining({
        id: `repository-finding-${"d".repeat(64)}`,
      }),
    ]);
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

  it("fails closed before provider dispatch when an immutable runtime pin is absent", async () => {
    const execute = vi.fn();
    const port = new PinnedRepositoryInvestigationPort(
      { execute } as unknown as AiExecutionGateway,
      resolver(),
    );
    const missingRuntimePin = input();
    await expect(
      port.investigate({
        ...missingRuntimePin,
        repository: {
          ...missingRuntimePin.repository,
          runtimePinId: undefined,
        },
      } as never),
    ).rejects.toBeInstanceOf(RepositoryInvestigationRuntimeError);
    expect(execute).not.toHaveBeenCalled();
  });
});
