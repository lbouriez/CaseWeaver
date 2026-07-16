import type {
  RepositoryAgentRuntime,
  RepositoryAgentRuntimeContext,
  RepositoryAgentRuntimeRequest,
} from "@caseweaver/ai-sdk";
import {
  RepositoryRuntimeError,
  type AdministratorRepositoryConfiguration,
  type IsolatedRepositorySandbox,
  type RepositoryAgentOutput,
  type RepositoryCheckoutBroker,
  type RepositorySandboxAttestation,
  type RepositorySandboxLimits,
  type RepositorySandboxSession,
  type SanitizedPinnedTree,
} from "./contracts.js";

export type {
  ConfiguredRepository,
  RepositoryAgentEvidence,
  RepositoryAgentRuntime,
  RepositoryAgentRuntimeContext,
  RepositoryAgentRuntimeRequest,
  RepositoryAgentRuntimeResult,
  RepositoryAgentSandboxLimits,
  RepositoryAgentToolGateway,
  RepositoryReadOnlyTool,
} from "@caseweaver/ai-sdk";
export {
  RepositoryRuntimeError,
  type AdministratorRepositoryConfiguration,
  type IsolatedRepositorySandbox,
  type PinnedRepositoryFile,
  type RepositoryAgentOutput,
  type RepositoryCheckoutBroker,
  type RepositoryEvidence,
  type RepositorySandboxAttestation,
  type RepositorySandboxLimits,
  type RepositorySandboxSession,
  type RepositoryToolName,
  type SanitizedPinnedTree,
} from "./contracts.js";

const forbiddenTreeProperties = new Set([
  "checkoutSecretReference",
  "credential",
  "credentials",
  "remote",
  "remoteUrl",
  "secret",
]);

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

function assertSafeString(value: string, label: string): void {
  if (value.length === 0 || value.length > 512 || hasControlCharacter(value)) {
    throw new RepositoryRuntimeError(
      "repository.runtimeConfiguration",
      `${label} is invalid.`,
    );
  }
}

function assertAdministratorConfiguration(
  configuration: AdministratorRepositoryConfiguration,
): void {
  assertSafeString(configuration.repositoryId, "Repository identifier");
  assertSafeString(
    configuration.checkoutSecretReference,
    "Checkout secret reference",
  );
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(configuration.pinnedCommit)) {
    throw new RepositoryRuntimeError(
      "repository.runtimeConfiguration",
      "Repository commit must be a pinned SHA-1 or SHA-256 identifier.",
    );
  }
}

function assertLimits(limits: RepositorySandboxLimits): void {
  if (
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    )
  ) {
    throw new RepositoryRuntimeError(
      "repository.runtimeConfiguration",
      "Repository sandbox limits must be positive integers.",
    );
  }
}

function assertSafePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 1_024 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-z]:/iu.test(path) ||
    path
      .split(/[\\/]/u)
      .some((segment) => segment === "" || segment === "..") ||
    hasControlCharacter(path)
  ) {
    throw new RepositoryRuntimeError(
      "repository.runtimeIsolation",
      "Sanitized repository tree contains an unsafe path.",
    );
  }
}

function assertSanitizedTree(
  tree: SanitizedPinnedTree,
  configuration: AdministratorRepositoryConfiguration,
): void {
  for (const property of Object.keys(tree)) {
    if (forbiddenTreeProperties.has(property)) {
      throw new RepositoryRuntimeError(
        "repository.runtimeIsolation",
        "Checkout broker returned repository authentication or remote metadata.",
      );
    }
  }
  if (
    tree.treeId.length === 0 ||
    tree.repositoryId !== configuration.repositoryId ||
    tree.pinnedCommit !== configuration.pinnedCommit
  ) {
    throw new RepositoryRuntimeError(
      "repository.runtimeIsolation",
      "Checkout broker did not return the configured pinned repository.",
    );
  }
  const paths = new Set<string>();
  for (const file of tree.files) {
    assertSafePath(file.path);
    if (
      !Number.isSafeInteger(file.lineCount) ||
      file.lineCount < 0 ||
      paths.has(file.path)
    ) {
      throw new RepositoryRuntimeError(
        "repository.runtimeIsolation",
        "Sanitized repository tree manifest is invalid.",
      );
    }
    paths.add(file.path);
  }
}

function assertAttestation(attestation: RepositorySandboxAttestation): void {
  if (
    !attestation.networkDisabled ||
    !attestation.credentialsUnavailable ||
    !attestation.readOnlyFilesystem ||
    !attestation.disposableFilesystem ||
    !attestation.toolAllowlistEnforced ||
    !attestation.quotasEnforced
  ) {
    throw new RepositoryRuntimeError(
      "repository.runtimeIsolation",
      "Repository sandbox did not attest required isolation.",
    );
  }
}

function assertOutput(
  output: RepositoryAgentOutput,
  tree: SanitizedPinnedTree,
  maximumOutputBytes: number,
): void {
  if (
    typeof output !== "object" ||
    output === null ||
    typeof output.summary !== "string" ||
    !Array.isArray(output.evidence)
  ) {
    throw new RepositoryRuntimeError(
      "repository.runtimeOutput",
      "Repository agent output is invalid.",
    );
  }
  if (
    output.summary.length === 0 ||
    new TextEncoder().encode(JSON.stringify(output)).byteLength >
      maximumOutputBytes
  ) {
    throw new RepositoryRuntimeError(
      "repository.runtimeOutput",
      "Repository agent output is invalid or exceeds its limit.",
    );
  }
  const files = new Map(tree.files.map((file) => [file.path, file.lineCount]));
  for (const reference of output.evidence) {
    if (
      typeof reference !== "object" ||
      reference === null ||
      typeof reference.path !== "string"
    ) {
      throw new RepositoryRuntimeError(
        "repository.runtimeOutput",
        "Repository agent returned invalid evidence.",
      );
    }
    const lineCount = files.get(reference.path);
    if (
      lineCount === undefined ||
      !Number.isSafeInteger(reference.startLine) ||
      !Number.isSafeInteger(reference.endLine) ||
      reference.startLine < 1 ||
      reference.endLine < reference.startLine ||
      reference.endLine > lineCount
    ) {
      throw new RepositoryRuntimeError(
        "repository.runtimeOutput",
        "Repository agent returned evidence outside the pinned tree.",
      );
    }
  }
}

export class AttestedRepositoryRuntime implements RepositoryAgentRuntime {
  public constructor(
    private readonly checkoutBroker: RepositoryCheckoutBroker,
    private readonly sandbox: IsolatedRepositorySandbox,
  ) {}

  public async run(
    request: RepositoryAgentRuntimeRequest,
    runner: (
      context: RepositoryAgentRuntimeContext,
    ) => Promise<RepositoryAgentOutput>,
  ): Promise<RepositoryAgentOutput> {
    assertAdministratorConfiguration(request.repository);
    assertLimits(request.limits);
    if (request.signal.aborted) throw request.signal.reason;
    if (request.allowedTools.length === 0) {
      throw new RepositoryRuntimeError(
        "repository.runtimeConfiguration",
        "Repository sandbox requires an explicit read-only tool allowlist.",
      );
    }

    const tree = await this.checkoutBroker.checkout(
      request.repository,
      request.signal,
    );
    try {
      assertSanitizedTree(tree, request.repository);
      assertAttestation(this.sandbox.attestation);
      if (request.signal.aborted) {
        throw new RepositoryRuntimeError(
          "repository.runtimeIsolation",
          "Repository sandbox was cancelled before it started.",
        );
      }
    } catch (error) {
      await this.sandbox.cleanup(tree.treeId);
      throw error;
    }

    const controller = new AbortController();
    let timedOut = false;
    let session: RepositorySandboxSession | undefined;
    const cancel = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      void session?.terminate();
    }, request.limits.timeoutMs);
    try {
      const openedSession = await this.sandbox.open({
        tree,
        allowedTools: [...new Set(request.allowedTools)],
        limits: request.limits,
        signal: controller.signal,
      });
      session = openedSession;
      let toolCalls = 0;
      const output = await Promise.race([
        runner({
          repositoryId: tree.repositoryId,
          pinnedCommit: tree.pinnedCommit,
          tools: {
            execute: async (tool, input) => {
              if (!request.allowedTools.includes(tool)) {
                throw new RepositoryRuntimeError(
                  "repository.runtimeIsolation",
                  "Repository agent requested a non-allowlisted tool.",
                );
              }
              toolCalls += 1;
              if (toolCalls > request.limits.maximumToolCalls) {
                throw new RepositoryRuntimeError(
                  "repository.runtimeOutput",
                  "Repository agent exceeded its tool-call limit.",
                );
              }
              return openedSession.execute(tool, input, controller.signal);
            },
          },
        }),
        new Promise<never>((_resolve, reject) => {
          const abort = () =>
            reject(
              new RepositoryRuntimeError(
                timedOut
                  ? "repository.runtimeTimeout"
                  : "repository.runtimeIsolation",
                timedOut
                  ? "Repository sandbox exceeded its time limit."
                  : "Repository sandbox was cancelled.",
              ),
            );
          if (controller.signal.aborted) {
            abort();
          } else {
            controller.signal.addEventListener("abort", abort, { once: true });
          }
        }),
      ]);
      if (timedOut) {
        throw new RepositoryRuntimeError(
          "repository.runtimeTimeout",
          "Repository sandbox exceeded its time limit.",
        );
      }
      if (request.signal.aborted) throw request.signal.reason;
      assertOutput(output, tree, request.limits.maximumOutputBytes);
      return Object.freeze({
        summary: output.summary,
        evidence: Object.freeze([...output.evidence]),
      });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", cancel);
      await session?.terminate();
      await this.sandbox.cleanup(tree.treeId);
    }
  }
}

export * from "./local-git-oci.js";
