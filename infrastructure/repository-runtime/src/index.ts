import type {
  ConfiguredRepository,
  OpaqueRepositoryRuntime,
  RepositoryAgentRuntime,
  RepositoryAgentRuntimeBinder,
  RepositoryAgentRuntimeContext,
  RepositoryAgentRuntimeRequest,
  RepositoryAgentUnverifiedResult,
} from "@caseweaver/ai-sdk";

import {
  type AdministratorRepositoryConfiguration,
  type IsolatedRepositorySandbox,
  type PreparedRepositoryTreeReader,
  type RepositoryCheckoutBroker,
  RepositoryRuntimeError,
  type RepositorySandboxAttestation,
  type RepositorySandboxLimits,
  type RepositorySandboxSession,
  type SanitizedPinnedTree,
} from "./contracts.js";
import { verifyRepositoryAgentOutput } from "./tree-verifier.js";

export type {
  ConfiguredRepository,
  OpaqueRepositoryRuntime,
  RepositoryAgentCitationLocation,
  RepositoryAgentEvidence,
  RepositoryAgentFinding,
  RepositoryAgentRuntime,
  RepositoryAgentRuntimeBinder,
  RepositoryAgentRuntimeContext,
  RepositoryAgentRuntimeRequest,
  RepositoryAgentRuntimeResult,
  RepositoryAgentSandboxLimits,
  RepositoryAgentToolGateway,
  RepositoryAgentUnverifiedFinding,
  RepositoryAgentUnverifiedResult,
  RepositoryReadOnlyTool,
} from "@caseweaver/ai-sdk";
export {
  type AdministratorRepositoryConfiguration,
  type IsolatedRepositorySandbox,
  type PinnedRepositoryFile,
  type PreparedRepositoryTreeReader,
  type PreparedRepositoryTreeRegistrar,
  type RepositoryAgentOutput,
  type RepositoryCheckoutBroker,
  type RepositoryCheckoutMaterial,
  type RepositoryEvidence,
  RepositoryRuntimeError,
  type RepositorySandboxAttestation,
  type RepositorySandboxLimits,
  type RepositorySandboxSession,
  type RepositoryToolName,
  type SanitizedPinnedTree,
} from "./contracts.js";
export {
  createPrivatePreparedRepositoryTree,
  type PrivatePreparedRepositoryTree,
  publishPreparedRepositoryTree,
} from "./prepared-tree.js";
export { isSafeRepositoryTextFile } from "./tree-sanitizer.js";
export { verifyRepositoryAgentOutput } from "./tree-verifier.js";

const forbiddenTreeProperties = new Set([
  "checkoutSecretReference",
  "credential",
  "credentials",
  "directory",
  "remote",
  "remoteUrl",
  "secret",
  "url",
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

function assertCheckoutMaterial(
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

function assertRuntimeIdentity(runtime: OpaqueRepositoryRuntime): void {
  assertSafeString(runtime.repositoryId, "Repository identifier");
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(runtime.pinnedCommit)) {
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
      .some(
        (segment) => segment === "" || segment === "." || segment === "..",
      ) ||
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
  configuration: ConfiguredRepository,
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
    typeof tree.treeId !== "string" ||
    tree.treeId.length === 0 ||
    tree.treeId.length > 200 ||
    hasControlCharacter(tree.treeId) ||
    tree.repositoryId !== configuration.repositoryId ||
    tree.pinnedCommit.toLowerCase() !== configuration.pinnedCommit.toLowerCase()
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
    !attestation.quotasEnforced ||
    !attestation.unprivilegedUser ||
    !attestation.immutableImage ||
    !attestation.readOnlyRepositoryMount
  ) {
    throw new RepositoryRuntimeError(
      "repository.runtimeIsolation",
      "Repository sandbox did not attest required isolation.",
    );
  }
}

function abortError(timedOut: boolean): RepositoryRuntimeError {
  return new RepositoryRuntimeError(
    timedOut ? "repository.runtimeTimeout" : "repository.runtimeIsolation",
    timedOut
      ? "Repository sandbox exceeded its time limit."
      : "Repository sandbox was cancelled.",
  );
}

class BoundAttestedRepositoryRuntime implements RepositoryAgentRuntime {
  public constructor(
    private readonly checkout: ConfiguredRepository,
    private readonly checkoutBroker: RepositoryCheckoutBroker,
    private readonly sandbox: IsolatedRepositorySandbox,
    private readonly reader: PreparedRepositoryTreeReader,
  ) {}

  public async run(
    request: RepositoryAgentRuntimeRequest,
    runner: (
      context: RepositoryAgentRuntimeContext,
    ) => Promise<RepositoryAgentUnverifiedResult>,
  ) {
    assertRuntimeIdentity(request.runtime);
    assertLimits(request.limits);
    if (
      request.runtime.repositoryId !== this.checkout.repositoryId ||
      request.runtime.pinnedCommit.toLowerCase() !==
        this.checkout.pinnedCommit.toLowerCase()
    ) {
      throw new RepositoryRuntimeError(
        "repository.runtimeConfiguration",
        "Repository runtime identity does not match its bound checkout.",
      );
    }
    if (request.signal.aborted) throw request.signal.reason;
    if (request.allowedTools.length === 0) {
      throw new RepositoryRuntimeError(
        "repository.runtimeConfiguration",
        "Repository sandbox requires an explicit read-only tool allowlist.",
      );
    }

    const tree = await this.checkoutBroker.checkout(
      this.checkout,
      request.signal,
    );
    try {
      assertSanitizedTree(tree, this.checkout);
      assertAttestation(this.sandbox.attestation);
      if (request.signal.aborted) throw abortError(false);
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
      void session?.terminate().catch(() => undefined);
    }, request.limits.timeoutMs);
    let removeAbortListener: (() => void) | undefined;
    try {
      const openedSession = await this.sandbox.open({
        tree,
        allowedTools: [...new Set(request.allowedTools)],
        limits: request.limits,
        signal: controller.signal,
      });
      session = openedSession;
      if (controller.signal.aborted) throw abortError(timedOut);
      let toolCalls = 0;
      const aborted = new Promise<never>((_resolve, reject) => {
        const rejectAborted = () => reject(abortError(timedOut));
        controller.signal.addEventListener("abort", rejectAborted, {
          once: true,
        });
        removeAbortListener = () =>
          controller.signal.removeEventListener("abort", rejectAborted);
        if (controller.signal.aborted) rejectAborted();
      });
      const output = await Promise.race([
        runner({
          runtime: Object.freeze({
            repositoryId: tree.repositoryId,
            pinnedCommit: tree.pinnedCommit,
          }),
          signal: controller.signal,
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
        aborted,
      ]);
      if (controller.signal.aborted) throw abortError(timedOut);
      return await verifyRepositoryAgentOutput({
        output,
        tree,
        reader: this.reader,
        signal: controller.signal,
        maximumOutputBytes: request.limits.maximumOutputBytes,
      });
    } finally {
      removeAbortListener?.();
      clearTimeout(timer);
      request.signal.removeEventListener("abort", cancel);
      await session?.terminate().catch(() => undefined);
      await this.sandbox.cleanup(tree.treeId);
    }
  }
}

/**
 * Binds private checkout material into a capability before a provider is
 * resolved. The returned runtime exposes only the opaque identity on `run`.
 */
export class AttestedRepositoryRuntime implements RepositoryAgentRuntimeBinder {
  public constructor(
    private readonly checkoutBroker: RepositoryCheckoutBroker,
    private readonly sandbox: IsolatedRepositorySandbox,
    private readonly reader: PreparedRepositoryTreeReader,
  ) {}

  public bind(checkout: ConfiguredRepository): RepositoryAgentRuntime {
    assertCheckoutMaterial(checkout);
    return new BoundAttestedRepositoryRuntime(
      Object.freeze({
        ...checkout,
        pinnedCommit: checkout.pinnedCommit.toLowerCase(),
      }),
      this.checkoutBroker,
      this.sandbox,
      this.reader,
    );
  }
}

export * from "./local-git-oci.js";
