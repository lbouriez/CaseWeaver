import { createHash } from "node:crypto";

import {
  type CaseDiscoveryStateStore,
  type ClaimedCaseDiscovery,
  RequestAnalysisTrigger,
} from "@caseweaver/application";
import type {
  CaseSource,
  DiscoveryPage,
  DiscoveredCase,
} from "@caseweaver/connector-sdk";
import {
  type RuntimeConnectorCapabilityResolver,
  RuntimeConnectorCapabilityUnavailableError,
} from "@caseweaver/connector-runtime";
import {
  correlationId,
  type EnvelopeFor,
  principalId,
  requestId,
  sha256Digest,
  workspaceId,
} from "@caseweaver/domain";

import type { WorkerCommandHandler } from "../runtime.js";

export type AnalysisDiscoveryCommand = EnvelopeFor<"analysis.discover.v1">;

export class AnalysisDiscoveryRuntimeUnavailableError extends Error {
  public readonly code = "analysis.discovery.runtimeUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("Case discovery runtime is unavailable.");
    this.name = "AnalysisDiscoveryRuntimeUnavailableError";
  }
}

export class AnalysisDiscoveryCursorIntegrityError extends Error {
  public readonly code = "analysis.discovery.cursorIntegrityFailed";
  public readonly retryable = false;

  public constructor() {
    super("Case discovery cursor state is unavailable.");
    this.name = "AnalysisDiscoveryCursorIntegrityError";
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function triggerDigests(input: {
  readonly command: AnalysisDiscoveryCommand;
  readonly item: DiscoveredCase;
}): Readonly<{ readonly idempotency: ReturnType<typeof sha256Digest>; readonly request: ReturnType<typeof sha256Digest>; readonly occurrenceKey: string }> {
  const fingerprint =
    input.item.fingerprint === undefined
      ? ""
      : `${input.item.fingerprint.version}\u0000${input.item.fingerprint.value}`;
  const identity = [
    "analysis.discovery.case.v1",
    input.command.workspaceId,
    input.command.payload.scheduleConfigurationVersionId,
    input.command.payload.triggerVersionId,
    input.command.payload.occurrenceKey,
    input.item.reference.connectorInstanceId,
    input.item.reference.resourceType,
    input.item.reference.externalId,
    fingerprint,
  ].join("\u0000");
  const occurrenceKey = hash(identity);
  return Object.freeze({
    occurrenceKey,
    idempotency: sha256Digest(hash(`idempotency\u0000${identity}`)),
    request: sha256Digest(hash(`request\u0000${identity}`)),
  });
}

function assertDiscoveredCase(
  command: AnalysisDiscoveryCommand,
  item: DiscoveredCase,
): void {
  if (
    item.reference.connectorInstanceId !==
      command.payload.connectorRegistrationId ||
    item.reference.resourceType.length === 0 ||
    item.reference.externalId.length === 0
  ) {
    throw new AnalysisDiscoveryRuntimeUnavailableError();
  }
}

function failure(error: unknown): Readonly<{
  readonly code: string;
  readonly retryable: boolean;
}> {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "retryable" in error &&
    typeof error.code === "string" &&
    typeof error.retryable === "boolean" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/u.test(error.code)
  ) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "analysis.discovery.failed", retryable: true };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The operation was aborted.");
  }
}

/**
 * Connector-neutral scheduled discovery. It turns discovered opaque targets
 * into existing PBI-012 version-pinned trigger requests, leaving capture,
 * attachment preparation, analysis, and publication to their own durable
 * command handlers. Cursor advancement follows successful request commits;
 * replay remains idempotent if this worker crashes between those transactions.
 */
export class RuntimeCaseDiscoveryService {
  public constructor(
    private readonly dependencies: Readonly<{
      readonly state: CaseDiscoveryStateStore;
      readonly connectors: RuntimeConnectorCapabilityResolver;
      readonly requestTrigger: Pick<RequestAnalysisTrigger, "execute">;
      readonly leaseMs: number;
    }>,
  ) {
    if (!Number.isInteger(dependencies.leaseMs) || dependencies.leaseMs < 1) {
      throw new RangeError("Case discovery lease must be a positive integer.");
    }
  }

  public async execute(
    command: AnalysisDiscoveryCommand,
    signal: AbortSignal,
  ): Promise<"completed" | "alreadyRunning"> {
    throwIfAborted(signal);
    const claimed = await this.dependencies.state.claim({
      command,
      leaseMs: this.dependencies.leaseMs,
    });
    if (claimed.kind !== "claimed") {
      if (claimed.kind === "alreadyRunning") return "alreadyRunning";
      throw new AnalysisDiscoveryRuntimeUnavailableError();
    }
    const claim = claimed.claim;
    try {
      const source = await this.resolveSource(command, signal);
      let completed = false;
      for await (const page of source.discoverCases({
        ...(claim.cursor === undefined ? {} : { cursor: claim.cursor }),
        signal,
      })) {
        throwIfAborted(signal);
        await this.createRequests(command, claim, page, signal);
        if (page.nextCursor === undefined) {
          throw new AnalysisDiscoveryCursorIntegrityError();
        }
        await this.dependencies.state.advance({
          command,
          claim,
          cursor: page.nextCursor,
        });
        if (page.complete) {
          completed = true;
          break;
        }
      }
      if (!completed) throw new AnalysisDiscoveryCursorIntegrityError();
      await this.dependencies.state.complete({ command, claim });
      return "completed";
    } catch (error) {
      const result = failure(error);
      await this.dependencies.state
        .fail({ command, claim, ...result })
        .catch(() => undefined);
      throw error;
    }
  }

  private async resolveSource(
    command: AnalysisDiscoveryCommand,
    signal: AbortSignal,
  ): Promise<CaseSource> {
    throwIfAborted(signal);
    try {
      const source = await this.dependencies.connectors.resolveCaseSource({
        workspaceId: command.workspaceId,
        connectorRegistrationId: command.payload.connectorRegistrationId,
        connectorConfigurationVersionId:
          command.payload.connectorConfigurationVersionId,
      });
      throwIfAborted(signal);
      return source;
    } catch (error) {
      if (error instanceof RuntimeConnectorCapabilityUnavailableError) {
        throw new AnalysisDiscoveryRuntimeUnavailableError();
      }
      throw error;
    }
  }

  private async createRequests(
    command: AnalysisDiscoveryCommand,
    claim: ClaimedCaseDiscovery,
    page: DiscoveryPage<DiscoveredCase>,
    signal: AbortSignal,
  ): Promise<void> {
    const items =
      page.mode === "delta"
        ? page.events.flatMap((event) =>
            event.kind === "upsert" ? [event.item] : [],
          )
        : page.items;
    for (const item of items) {
      throwIfAborted(signal);
      assertDiscoveredCase(command, item);
      const digests = triggerDigests({ command, item });
      await this.dependencies.requestTrigger.execute(
        {
          triggerId: command.payload.triggerId,
          expectedTriggerVersionId: command.payload.triggerVersionId,
          source: "schedule",
          occurrenceKey: digests.occurrenceKey,
          target: item.reference,
          idempotencyKeyDigest: digests.idempotency,
          requestDigest: digests.request,
        },
        {
          requestId: requestId(
            `case-discovery:${command.payload.occurrenceKey}:${digests.occurrenceKey}`,
          ),
          workspaceId: workspaceId(command.workspaceId),
          principalId: principalId(claim.actorPrincipalId),
          correlationId: correlationId(command.correlationId),
          ...(command.traceContext === undefined
            ? {}
            : { traceContext: command.traceContext }),
          signal,
        },
      );
    }
  }
}

export function createCaseDiscoveryHandler(
  service: Pick<RuntimeCaseDiscoveryService, "execute">,
): WorkerCommandHandler<AnalysisDiscoveryCommand> {
  return Object.freeze({
    async handle(command: AnalysisDiscoveryCommand, signal: AbortSignal) {
      await service.execute(command, signal);
    },
  });
}
