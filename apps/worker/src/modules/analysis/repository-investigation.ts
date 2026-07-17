import { createHash } from "node:crypto";

import type { AiExecutionGateway } from "@caseweaver/ai-execution";
import type {
  RepositoryAgentEvidence,
  RepositoryAgentFinding,
  RepositoryAgentResult,
  RepositoryAgentRuntimePin,
} from "@caseweaver/ai-sdk";
import type {
  AnalysisEvidence,
  RepositoryInvestigationPort,
} from "@caseweaver/analysis";
import type { RepositoryRuntimeExecutionConfigurationResolver } from "@caseweaver/postgres";

const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu;

/** Stable redacted runtime failure for the durable analysis attempt record. */
export class RepositoryInvestigationRuntimeError extends Error {
  public readonly code = "analysis.repositoryRuntimeUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("The immutable repository investigation runtime is unavailable.");
    this.name = "RepositoryInvestigationRuntimeError";
  }
}

function unavailable(): never {
  throw new RepositoryInvestigationRuntimeError();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEvidence(
  value: readonly RepositoryAgentEvidence[],
  pin: RepositoryAgentRuntimePin,
): readonly AnalysisEvidence[] {
  const positions = new Set<string>();
  const output: AnalysisEvidence[] = [];
  for (const reference of value) {
    if (
      reference === null ||
      typeof reference !== "object" ||
      typeof reference.path !== "string" ||
      typeof reference.id !== "string" ||
      !/^repository-evidence-[a-f0-9]{64}$/iu.test(reference.id) ||
      typeof reference.excerptHash !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(reference.excerptHash) ||
      reference.path.length === 0 ||
      reference.path.length > 1_024 ||
      reference.path.startsWith("/") ||
      reference.path.startsWith("\\") ||
      /^[a-z]:/iu.test(reference.path) ||
      reference.path
        .split(/[\\/]/u)
        .some((part) => part.length === 0 || part === "..") ||
      !Number.isSafeInteger(reference.startLine) ||
      !Number.isSafeInteger(reference.endLine) ||
      reference.startLine < 1 ||
      reference.endLine < reference.startLine
    ) {
      unavailable();
    }
    const location = `${reference.path}:${reference.startLine}:${reference.endLine}`;
    if (positions.has(reference.id) || positions.has(location)) unavailable();
    positions.add(reference.id);
    positions.add(location);
    // Do not retain source excerpts or model text. The isolated runtime has
    // already validated the location against the immutable tree; downstream
    // prompts receive provenance only, which prevents secret/source leakage.
    const content = `Pinned repository evidence at ${reference.path}:${reference.startLine}-${reference.endLine}.`;
    output.push(
      Object.freeze({
        id: reference.id,
        kind: "repository" as const,
        content,
        contentHash: sha256(content),
        repositoryId: pin.repositoryId,
        commit: pin.pinnedCommit.toLowerCase(),
        path: reference.path,
        startLine: reference.startLine,
        endLine: reference.endLine,
        excerptHash: reference.excerptHash.toLowerCase(),
      }),
    );
  }
  return Object.freeze(output);
}

function safeFindings(
  value: readonly RepositoryAgentFinding[],
  evidence: readonly AnalysisEvidence[],
): readonly import("@caseweaver/analysis").RepositoryFinding[] {
  if (!Array.isArray(value) || value.length > 100) unavailable();
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const findingIds = new Set<string>();
  const findings: import("@caseweaver/analysis").RepositoryFinding[] = [];
  for (const finding of value) {
    if (
      finding === null ||
      typeof finding !== "object" ||
      typeof finding.id !== "string" ||
      !/^repository-finding-[a-f0-9]{64}$/iu.test(finding.id) ||
      findingIds.has(finding.id) ||
      typeof finding.summary !== "string" ||
      finding.summary.trim().length === 0 ||
      finding.summary.length > 16_000 ||
      !Array.isArray(finding.evidenceIds) ||
      finding.evidenceIds.length === 0 ||
      finding.evidenceIds.length > 100 ||
      new Set(finding.evidenceIds).size !== finding.evidenceIds.length ||
      finding.evidenceIds.some((id: string) => !evidenceIds.has(id))
    ) {
      unavailable();
    }
    findingIds.add(finding.id);
    findings.push({
      id: finding.id,
      summary: finding.summary.trim(),
      evidenceIds: [...finding.evidenceIds],
    });
  }
  return Object.freeze(findings);
}

function instruction(input: {
  readonly caseSummary: string;
  readonly evidence: readonly AnalysisEvidence[];
}): string {
  return [
    "Investigate only the administrator-pinned repository through the supplied read-only tools.",
    "Do not disclose credentials, tokens, configuration values, or source excerpts in the result.",
    "Return only a concise summary and bounded findings, each linked to file/line citations.",
    "Case context follows:",
    JSON.stringify({
      caseSummary: input.caseSummary,
      evidence: input.evidence.map((item) => ({
        id: item.id,
        kind: item.kind,
        content: item.content,
        contentHash: item.contentHash,
      })),
    }),
  ].join("\n");
}

function runtimePin(input: {
  readonly workspaceId: string;
  readonly runtimeVersionId: string;
  readonly repositoryId: string;
  readonly pinnedCommit: string;
}): RepositoryAgentRuntimePin {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(input.workspaceId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(input.runtimeVersionId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(input.repositoryId) ||
    !shaPattern.test(input.pinnedCommit)
  ) {
    unavailable();
  }
  return Object.freeze({
    workspaceId: input.workspaceId,
    runtimeVersionId: input.runtimeVersionId,
    repositoryId: input.repositoryId,
    pinnedCommit: input.pinnedCommit.toLowerCase(),
  });
}

/**
 * Repository analysis bridge. It checks the exact immutable runtime before a
 * metered provider call, delegates dispatch solely to `ai-execution`, and
 * converts returned locations into source-free analysis provenance.
 */
export class PinnedRepositoryInvestigationPort
  implements RepositoryInvestigationPort
{
  public constructor(
    private readonly ai: AiExecutionGateway,
    private readonly runtimes: RepositoryRuntimeExecutionConfigurationResolver,
  ) {}

  public async investigate(
    input: Parameters<RepositoryInvestigationPort["investigate"]>[0],
  ) {
    const pin = runtimePin({
      workspaceId: input.execution.workspaceId,
      runtimeVersionId: input.repository.runtimePinId,
      repositoryId: input.repository.repositoryId,
      pinnedCommit: input.repository.pinnedCommit,
    });
    const resolved = await this.runtimes.resolveExecution(pin, input.signal);
    if (
      resolved.runtimeVersionId !== pin.runtimeVersionId ||
      resolved.repositoryId !== pin.repositoryId ||
      resolved.pinnedCommit.toLowerCase() !== pin.pinnedCommit ||
      resolved.execution.bindingVersionId !==
        input.repository.repositoryAgentBindingVersionId
    ) {
      unavailable();
    }
    const requestInstruction = instruction({
      caseSummary: input.caseSummary,
      evidence: input.evidence,
    });
    if (
      requestInstruction.length >
      resolved.execution.maximumInstructionCharacters
    ) {
      unavailable();
    }
    const result = await this.ai.execute<RepositoryAgentResult>(
      {
        kind: "repositoryAgent",
        role: "repositoryAgent",
        bindingVersionId: input.repository.repositoryAgentBindingVersionId,
        analysisId: input.execution.analysisIdentityId,
        attribution: { analysisJobId: input.execution.analysisJobId },
        requiredCapabilities: ["repositoryAgent", "tools"],
        request: {
          runtimePin: pin,
          instruction: requestInstruction,
          maximumTurns: resolved.execution.maximumTurns,
          maximumInputTokensPerTurn:
            resolved.execution.maximumInputTokensPerTurn,
          maximumOutputTokensPerTurn:
            resolved.execution.maximumOutputTokensPerTurn,
        },
        maximumInputTokens:
          resolved.execution.maximumTurns *
          resolved.execution.maximumInputTokensPerTurn,
        maximumOutputTokens:
          resolved.execution.maximumTurns *
          resolved.execution.maximumOutputTokensPerTurn,
        timeoutMs: resolved.sandboxLimits.timeoutMs,
        budget: resolved.execution.budget,
      },
      { workspaceId: input.execution.workspaceId, signal: input.signal },
    );
    if (
      result.value === null ||
      typeof result.value !== "object" ||
      typeof result.value.summary !== "string" ||
      result.value.summary.trim().length === 0 ||
      !Array.isArray(result.value.evidence) ||
      !Array.isArray(result.value.findings)
    ) {
      unavailable();
    }
    const evidence = safeEvidence(result.value.evidence, pin);
    return Object.freeze({
      summary: result.value.summary.trim(),
      evidence,
      findings: safeFindings(result.value.findings, evidence),
      operationIds: Object.freeze([result.operationId]),
    });
  }
}
