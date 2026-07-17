import { createHash } from "node:crypto";

import type {
  RepositoryAgentEvidence,
  RepositoryAgentFinding,
  RepositoryAgentUnverifiedResult,
} from "@caseweaver/ai-sdk";

import {
  type PreparedRepositoryTreeReader,
  RepositoryRuntimeError,
  type SanitizedPinnedTree,
} from "./contracts.js";

const maximumFindings = 100;
const maximumCitations = 100;
const maximumSummaryCharacters = 16_000;

function invalidOutput(message = "Repository agent output is invalid."): never {
  throw new RepositoryRuntimeError("repository.runtimeOutput", message);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[a-z]:/iu.test(value) &&
    !hasControlCharacter(value) &&
    !value
      .split(/[\\/]/u)
      .some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizedLines(value: string): readonly string[] {
  return value.replace(/\r\n|\r/gu, "\n").split("\n");
}

function locationKey(input: {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}): string {
  return `${input.path}\u0000${input.startLine}\u0000${input.endLine}`;
}

function assertUnverifiedResult(
  value: unknown,
): asserts value is RepositoryAgentUnverifiedResult {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, "summary") ||
    !Object.hasOwn(value, "findings")
  ) {
    invalidOutput();
  }
  const result = value as RepositoryAgentUnverifiedResult;
  if (
    typeof result.summary !== "string" ||
    result.summary.trim().length === 0 ||
    result.summary.length > maximumSummaryCharacters ||
    !Array.isArray(result.findings) ||
    result.findings.length > maximumFindings
  ) {
    invalidOutput();
  }
}

/**
 * Resolves model-authored locations only against the exact private prepared
 * tree. It derives all retained evidence IDs and excerpt hashes from source
 * bytes; providers cannot manufacture them from a path/range alone.
 */
export async function verifyRepositoryAgentOutput(input: {
  readonly output: RepositoryAgentUnverifiedResult;
  readonly tree: SanitizedPinnedTree;
  readonly reader: PreparedRepositoryTreeReader;
  readonly signal: AbortSignal;
  readonly maximumOutputBytes: number;
}): Promise<{
  readonly summary: string;
  readonly evidence: readonly RepositoryAgentEvidence[];
  readonly findings: readonly RepositoryAgentFinding[];
}> {
  assertUnverifiedResult(input.output);
  let encodedBytes: number;
  try {
    encodedBytes = new TextEncoder().encode(
      JSON.stringify(input.output),
    ).byteLength;
  } catch {
    invalidOutput();
  }
  if (encodedBytes > input.maximumOutputBytes) invalidOutput();

  const files = new Map(
    input.tree.files.map((file) => [file.path, file.lineCount]),
  );
  const evidenceByLocation = new Map<string, RepositoryAgentEvidence>();
  const evidence: RepositoryAgentEvidence[] = [];
  const findings: RepositoryAgentFinding[] = [];
  let citationCount = 0;

  for (const finding of input.output.findings) {
    if (
      typeof finding !== "object" ||
      finding === null ||
      typeof finding.summary !== "string" ||
      finding.summary.trim().length === 0 ||
      finding.summary.length > maximumSummaryCharacters ||
      !Array.isArray(finding.citations) ||
      finding.citations.length === 0 ||
      finding.citations.length > maximumCitations
    ) {
      invalidOutput();
    }

    const evidenceIds: string[] = [];
    const seenFindingLocations = new Set<string>();
    for (const citation of finding.citations) {
      citationCount += 1;
      if (citationCount > maximumCitations) invalidOutput();
      if (
        typeof citation !== "object" ||
        citation === null ||
        !safePath(citation.path) ||
        !Number.isSafeInteger(citation.startLine) ||
        !Number.isSafeInteger(citation.endLine) ||
        citation.startLine < 1 ||
        citation.endLine < citation.startLine
      ) {
        invalidOutput();
      }
      const lineCount = files.get(citation.path);
      if (lineCount === undefined || citation.endLine > lineCount)
        invalidOutput();
      const key = locationKey(citation);
      if (seenFindingLocations.has(key)) invalidOutput();
      seenFindingLocations.add(key);

      let verified = evidenceByLocation.get(key);
      if (verified === undefined) {
        if (input.signal.aborted) throw input.signal.reason;
        let contents: string;
        try {
          contents = await input.reader.readText({
            tree: input.tree,
            path: citation.path,
            signal: input.signal,
          });
        } catch (_error) {
          if (input.signal.aborted) throw input.signal.reason;
          throw new RepositoryRuntimeError(
            "repository.runtimePreparation",
            "Prepared repository evidence is unavailable.",
          );
        }
        const lines = normalizedLines(contents);
        if (lines.length !== lineCount) {
          throw new RepositoryRuntimeError(
            "repository.runtimePreparation",
            "Prepared repository evidence no longer matches its manifest.",
          );
        }
        const excerptHash = hash(
          lines.slice(citation.startLine - 1, citation.endLine).join("\n"),
        );
        verified = Object.freeze({
          id: `repository-evidence-${hash(
            [
              input.tree.repositoryId,
              input.tree.pinnedCommit.toLowerCase(),
              citation.path,
              String(citation.startLine),
              String(citation.endLine),
              excerptHash,
            ].join("\u0000"),
          )}`,
          path: citation.path,
          startLine: citation.startLine,
          endLine: citation.endLine,
          excerptHash,
        });
        evidenceByLocation.set(key, verified);
        evidence.push(verified);
      }
      evidenceIds.push(verified.id);
    }
    const uniqueEvidenceIds = [...new Set(evidenceIds)];
    if (uniqueEvidenceIds.length === 0) invalidOutput();
    findings.push(
      Object.freeze({
        id: `repository-finding-${hash(
          [finding.summary, ...uniqueEvidenceIds].join("\u0000"),
        )}`,
        summary: finding.summary.trim(),
        evidenceIds: Object.freeze(uniqueEvidenceIds),
      }),
    );
  }

  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) {
    invalidOutput();
  }
  return Object.freeze({
    summary: input.output.summary.trim(),
    evidence: Object.freeze(evidence),
    findings: Object.freeze(findings),
  });
}
