import type {
  AnalysisTriggerRequest,
  CapturedCaseSnapshot,
  TriggeredCaseSnapshotCapture,
} from "@caseweaver/application";
import {
  type RuntimeConnectorCapabilityResolver,
  RuntimeConnectorCapabilityUnavailableError,
} from "@caseweaver/connector-runtime";
import type { EnvelopeFor } from "@caseweaver/domain";

import type { WorkerCommandHandler } from "../runtime.js";

/**
 * Redacted, non-retryable failure used when the durable pins cannot construct
 * a case source. Settings, secret locators, and connector exceptions remain
 * private to the runtime resolver.
 */
export class AnalysisTriggerRuntimeUnavailableError extends Error {
  public readonly code = "analysis.trigger.runtimeUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("Analysis trigger runtime is unavailable.");
    this.name = "AnalysisTriggerRuntimeUnavailableError";
  }
}

/** A connector response must never be persisted under a different case target. */
export class AnalysisTriggerCaptureIntegrityError extends Error {
  public readonly code = "analysis.trigger.captureIntegrityFailed";
  public readonly retryable = false;

  public constructor() {
    super("Analysis trigger capture did not match its requested case target.");
    this.name = "AnalysisTriggerCaptureIntegrityError";
  }
}

/**
 * Maps connector-normalized case data to the application capture contract.
 * The worker boundary intentionally keeps connector SDK types out of the
 * feature contract; deployment composition supplies the approved mapper.
 */
export interface CaseSnapshotProjector {
  project(
    input: Readonly<{
      readonly request: AnalysisTriggerRequest;
      readonly normalizedCase: unknown;
      readonly signal: AbortSignal;
    }>,
  ): Promise<CapturedCaseSnapshot>;
}

/**
 * Resolves a `CaseSource` from the exact immutable request pins and loads only
 * the opaque case target persisted with that request. This is the sole outer
 * runtime bridge for PBI-012 capture; it does not look up a current connector
 * configuration, construct a connector itself, or handle worker registration.
 */
export class RuntimeCaseSourceSnapshotCapture
  implements TriggeredCaseSnapshotCapture
{
  public constructor(
    private readonly connectors: RuntimeConnectorCapabilityResolver,
    private readonly projector: CaseSnapshotProjector,
  ) {}

  public async capture(
    input: Parameters<TriggeredCaseSnapshotCapture["capture"]>[0],
  ): Promise<CapturedCaseSnapshot> {
    throwIfAborted(input.signal);
    if (
      input.request.target.connectorInstanceId !==
      input.request.connectorRegistrationId
    ) {
      throw new AnalysisTriggerRuntimeUnavailableError();
    }
    const source = await this.connectors
      .resolveCaseSource({
        workspaceId: input.request.workspaceId,
        connectorRegistrationId: input.request.connectorRegistrationId,
        connectorConfigurationVersionId:
          input.request.connectorConfigurationVersionId,
      })
      .catch((error: unknown) => {
        if (error instanceof RuntimeConnectorCapabilityUnavailableError) {
          throw new AnalysisTriggerRuntimeUnavailableError();
        }
        throw error;
      });
    throwIfAborted(input.signal);
    const normalizedCase = await source.loadCase({
      reference: input.request.target,
      requestId: input.request.id,
      signal: input.signal,
    });
    throwIfAborted(input.signal);
    if (!hasExpectedTarget(normalizedCase, input.request.target)) {
      throw new AnalysisTriggerCaptureIntegrityError();
    }
    return this.projector.project({
      request: input.request,
      normalizedCase,
      signal: input.signal,
    });
  }
}

export interface AnalysisTriggerCaptureService {
  execute(
    command: EnvelopeFor<"analysis.trigger.v2">,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/**
 * Integration-owned worker composition wires this thin transport handler to
 * `CaptureAnalysisTriggerCase`. It accepts only v2 commands by construction.
 */
export function createAnalysisTriggerCaptureHandler(
  service: AnalysisTriggerCaptureService,
): WorkerCommandHandler<EnvelopeFor<"analysis.trigger.v2">> {
  return Object.freeze({
    async handle(
      command: EnvelopeFor<"analysis.trigger.v2">,
      signal: AbortSignal,
    ): Promise<void> {
      await service.execute(command, signal);
    },
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The operation was aborted.");
  }
}

function hasExpectedTarget(
  value: unknown,
  target: AnalysisTriggerRequest["target"],
): boolean {
  if (typeof value !== "object" || value === null || !("reference" in value)) {
    return false;
  }
  const reference = value.reference;
  return (
    typeof reference === "object" &&
    reference !== null &&
    "connectorInstanceId" in reference &&
    "resourceType" in reference &&
    "externalId" in reference &&
    reference.connectorInstanceId === target.connectorInstanceId &&
    reference.resourceType === target.resourceType &&
    reference.externalId === target.externalId
  );
}
