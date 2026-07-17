import { createHash } from "node:crypto";
import type { AiExecutionGateway } from "@caseweaver/ai-execution";
import type { Clock } from "@caseweaver/application";
import {
  type AcceptedAttachment,
  AttachmentCancelledError,
  type AttachmentDerivative,
  type AttachmentOccurrenceDescriptor,
  type AttachmentOccurrencePersistence,
  type AttachmentOccurrencePreparationDependencies,
  type AttachmentOccurrencePreparationExecution,
  type AttachmentOccurrencePreparationProcessingPolicy,
  type AttachmentOutputStore,
  type AttachmentPreparationAttemptStore,
  type AttachmentPreparationOutcome,
  type AttachmentPreparationPolicy,
  type AttachmentPreparationSubject,
  type AttachmentRepository,
  type AttachmentRuntime,
  type BlobStore,
  type PrepareAttachmentOccurrencesRequest,
  type PreparedAttachmentDerivative,
  prepareAttachmentOccurrences,
  type ServerPrivateAttachmentOccurrence,
} from "@caseweaver/attachments";
import {
  type RuntimeConnectorCapabilityResolver,
  RuntimeConnectorCapabilityUnavailableError,
} from "@caseweaver/connector-runtime";
import {
  type AttachmentOccurrence,
  type AttachmentSource,
  attachmentOccurrenceIdentity,
  type ExternalReference,
  type KnowledgeDocument,
  type NormalizedCase,
  sha256CanonicalJson,
} from "@caseweaver/connector-sdk";
import type {
  AttachmentPreparationPort,
  AttachmentPreparationResult as KnowledgeAttachmentPreparationResult,
} from "@caseweaver/knowledge";

export interface ExactAttachmentConnectorPin {
  readonly connectorRegistrationId: string;
  readonly connectorConfigurationVersionId: string;
}

/**
 * Resolves the byte/processor limits and optional vision binding selected by
 * an already-immutable source or case attachment policy. It is not a mutable
 * "current configuration" lookup: worker composition must key it only by the
 * supplied policy and, for knowledge, the exact source configuration version.
 */
export interface AttachmentProcessingPolicyResolver {
  resolve(input: {
    readonly workspaceId: string;
    readonly policy: AttachmentPreparationPolicy;
    readonly context:
      | Readonly<{
          readonly kind: "knowledgeSource";
          readonly sourceConfigurationVersionId: string;
        }>
      | Readonly<{ readonly kind: "caseCapture" }>;
    readonly signal: AbortSignal;
  }): Promise<AttachmentOccurrencePreparationProcessingPolicy | undefined>;
}

/**
 * Narrow persistence surface used before external bytes are opened. It is
 * structurally compatible with the PostgreSQL attachment repository but avoids
 * binding this worker feature module to a persistence adapter.
 */
export interface AttachmentReservationPort {
  reserveAttachment(input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly reference: ExternalReference;
    readonly observedAt: string;
  }): Promise<void>;
  recordReservedAttachment(input: {
    readonly attachmentId: string;
    readonly attachment: AcceptedAttachment;
    readonly observedAt: string;
  }): Promise<unknown>;
  recordReservedDerivativeSource(input: {
    readonly subject: AttachmentPreparationSubject;
    readonly occurrence: AttachmentOccurrenceDescriptor;
    readonly derivativeId: string;
  }): Promise<void>;
}

/**
 * Rehydrates server-private derivative text for a completed durable attempt.
 * This is never an API/read-model port: callers must validate the returned set
 * against `selectedDerivatives` before giving it to knowledge ingestion.
 */
export interface PreparedAttachmentTextReader {
  read(input: {
    readonly workspaceId: string;
    readonly subject: AttachmentPreparationSubject;
    readonly attemptId: string;
    readonly selectedDerivatives: readonly Readonly<{
      readonly occurrenceIdentity: string;
      readonly derivativeIdentity: string;
      readonly derivativeContentHash: string;
    }>[];
    readonly signal: AbortSignal;
  }): Promise<readonly PreparedAttachmentDerivative[]>;
}

export interface AttachmentOccurrencePreparationExecutor {
  prepare(
    request: PrepareAttachmentOccurrencesRequest,
    dependencies: AttachmentOccurrencePreparationDependencies,
  ): Promise<AttachmentOccurrencePreparationExecution>;
}

export interface LiveAttachmentPreparationDependencies {
  readonly connectors: Pick<
    RuntimeConnectorCapabilityResolver,
    "resolveAttachmentSource"
  >;
  readonly reservations: AttachmentReservationPort;
  readonly attempts: AttachmentPreparationAttemptStore;
  readonly blobStore: BlobStore;
  readonly outputStore: AttachmentOutputStore;
  readonly repository: AttachmentRepository;
  readonly runtime: AttachmentRuntime;
  readonly processingPolicies: AttachmentProcessingPolicyResolver;
  readonly clock: Clock;
  readonly aiExecution?: AiExecutionGateway;
  readonly preparedText?: PreparedAttachmentTextReader;
  readonly executor?: AttachmentOccurrencePreparationExecutor;
}

export interface PrepareLiveCaseAttachmentsRequest {
  /** CaseWeaver-owned capture/request identifier, never the external case ID. */
  readonly caseCaptureId: string;
  readonly workspaceId: string;
  readonly connectorRegistrationId: string;
  readonly connectorConfigurationVersionId: string;
  readonly normalizedCase: NormalizedCase;
  readonly policy: AttachmentPreparationPolicy;
  readonly signal: AbortSignal;
  readonly analysisId?: string;
}

/** Safe case-capture output; derived text remains inside trusted preparation. */
export interface LiveCaseAttachmentPreparationResult {
  readonly outcome: AttachmentPreparationOutcome;
  readonly attemptId?: string;
}

/**
 * A stable, redacted operational failure. It intentionally never chains a
 * connector, storage, URL, locator, path, or source-text error as its message.
 */
export class LiveAttachmentPreparationUnavailableError extends Error {
  public readonly code = "attachment.preparation.unavailable";
  public readonly retryable = true;

  public constructor() {
    super("Attachment preparation is unavailable.");
    this.name = "LiveAttachmentPreparationUnavailableError";
  }
}

/** A required case cannot progress to capture/analysis with terminal evidence. */
export class RequiredCaseAttachmentPreparationError extends Error {
  public readonly code = "attachment.preparation.required";
  public readonly retryable = false;

  public constructor() {
    super("Required case attachment preparation did not complete.");
    this.name = "RequiredCaseAttachmentPreparationError";
  }
}

interface PreparedLiveAttachments {
  readonly execution: AttachmentOccurrencePreparationExecution;
  readonly policy: AttachmentPreparationPolicy;
}

/**
 * Adapter for knowledge ingestion. It resolves only the exact source pin
 * selected by durable work, preserves the terminal attempt ID, and keeps
 * occurrence reopen material inside this worker module.
 */
export class LiveKnowledgeAttachmentPreparation
  implements AttachmentPreparationPort
{
  private readonly preparation: LiveAttachmentPreparation;

  public constructor(
    private readonly dependencies: LiveAttachmentPreparationDependencies,
  ) {
    this.preparation = new LiveAttachmentPreparation(dependencies);
  }

  public async prepare(
    input: Parameters<AttachmentPreparationPort["prepare"]>[0],
  ): Promise<KnowledgeAttachmentPreparationResult> {
    throwIfAborted(input.signal);
    try {
      const prepared = await this.preparation.prepare({
        workspaceId: input.workspaceId,
        pin: {
          connectorRegistrationId: input.connectorRegistrationId,
          connectorConfigurationVersionId:
            input.connectorConfigurationVersionId,
        },
        processingContext: {
          kind: "knowledgeSource",
          sourceConfigurationVersionId: input.sourceConfigurationVersionId,
        },
        subject: sourceDocumentSubject(
          input.workspaceId,
          input.sourceId,
          input.document,
        ),
        occurrences: input.document.attachmentOccurrences ?? [],
        policy: input.policy,
        signal: input.signal,
      });
      const derivatives = await this.derivatives(prepared, input.signal);
      return Object.freeze({
        outcome: prepared.execution.result.outcome,
        derivatives,
        ...(prepared.execution.attempt === undefined
          ? {}
          : { attemptId: prepared.execution.attempt.id }),
      });
    } catch (error) {
      throw redactedPreparationError(error, input.signal);
    }
  }

  private async derivatives(
    prepared: PreparedLiveAttachments,
    signal: AbortSignal,
  ): Promise<readonly PreparedAttachmentDerivative[]> {
    const direct = prepared.execution.result.derivatives;
    if (
      direct.length > 0 ||
      prepared.execution.result.outcome.selectedDerivatives.length === 0
    ) {
      return direct;
    }
    const attempt = prepared.execution.attempt;
    if (attempt === undefined || this.dependencies.preparedText === undefined) {
      throw new LiveAttachmentPreparationUnavailableError();
    }
    const restored = await this.dependencies.preparedText.read({
      workspaceId: prepared.execution.subject.workspaceId,
      subject: prepared.execution.subject,
      attemptId: attempt.id,
      selectedDerivatives:
        prepared.execution.result.outcome.selectedDerivatives,
      signal,
    });
    assertSelectedDerivatives(
      restored,
      prepared.execution.result.outcome.selectedDerivatives,
    );
    return restored;
  }
}

/**
 * Prepares a normalized case before immutable capture. Only a safe terminal
 * result and its opaque attempt ID cross this boundary; no attachment text or
 * reopening identity reaches the snapshot/projector caller.
 */
export class LiveCaseAttachmentPreparation {
  private readonly preparation: LiveAttachmentPreparation;

  public constructor(dependencies: LiveAttachmentPreparationDependencies) {
    this.preparation = new LiveAttachmentPreparation(dependencies);
  }

  public async prepare(
    input: PrepareLiveCaseAttachmentsRequest,
  ): Promise<LiveCaseAttachmentPreparationResult> {
    throwIfAborted(input.signal);
    try {
      const prepared = await this.preparation.prepare({
        workspaceId: input.workspaceId,
        pin: {
          connectorRegistrationId: input.connectorRegistrationId,
          connectorConfigurationVersionId:
            input.connectorConfigurationVersionId,
        },
        processingContext: { kind: "caseCapture" },
        subject: caseCaptureSubject(input.workspaceId, input.caseCaptureId),
        occurrences: caseOccurrences(input.normalizedCase),
        policy: input.policy,
        signal: input.signal,
        ...(input.analysisId === undefined
          ? {}
          : { analysisId: input.analysisId }),
      });
      if (
        input.policy.mode === "required" &&
        prepared.execution.result.outcome.status === "terminal"
      ) {
        throw new RequiredCaseAttachmentPreparationError();
      }
      return Object.freeze({
        outcome: prepared.execution.result.outcome,
        ...(prepared.execution.attempt === undefined
          ? {}
          : { attemptId: prepared.execution.attempt.id }),
      });
    } catch (error) {
      if (error instanceof RequiredCaseAttachmentPreparationError) {
        throw error;
      }
      throw redactedPreparationError(error, input.signal);
    }
  }
}

class LiveAttachmentPreparation {
  private readonly executor: AttachmentOccurrencePreparationExecutor;
  private readonly preparationDependencies: AttachmentOccurrencePreparationDependencies;

  public constructor(
    private readonly dependencies: LiveAttachmentPreparationDependencies,
  ) {
    this.executor =
      dependencies.executor ??
      Object.freeze({ prepare: prepareAttachmentOccurrences });
    this.preparationDependencies = Object.freeze({
      blobStore: dependencies.blobStore,
      outputStore: dependencies.outputStore,
      repository: dependencies.repository,
      runtime: dependencies.runtime,
      attempts: dependencies.attempts,
      occurrencePersistence: new ReservationOccurrencePersistence(
        dependencies.reservations,
        dependencies.clock,
      ),
      ...(dependencies.aiExecution === undefined
        ? {}
        : { aiExecution: dependencies.aiExecution }),
    });
  }

  public async prepare(input: {
    readonly workspaceId: string;
    readonly pin: ExactAttachmentConnectorPin;
    readonly processingContext: Parameters<
      AttachmentProcessingPolicyResolver["resolve"]
    >[0]["context"];
    readonly subject: AttachmentPreparationSubject;
    readonly occurrences: readonly AttachmentOccurrence[];
    readonly policy: AttachmentPreparationPolicy;
    readonly signal: AbortSignal;
    readonly analysisId?: string;
  }): Promise<PreparedLiveAttachments> {
    throwIfAborted(input.signal);
    assertPin(input.pin);
    assertSubject(input.subject, input.workspaceId);
    assertProcessingContext(input.processingContext);
    const processing = await this.resolveProcessingPolicy(input);
    const descriptors = attachmentDescriptors(
      input.workspaceId,
      input.pin.connectorRegistrationId,
      input.occurrences,
      input.policy.mode,
    );
    await reserveAttachments({
      reservations: this.dependencies.reservations,
      workspaceId: input.workspaceId,
      occurrences: descriptors,
      clock: this.dependencies.clock,
      signal: input.signal,
    });
    const source = await this.resolveSource(input);
    const occurrences = descriptors.map(({ descriptor, raw }) =>
      serverPrivateOccurrence(descriptor, raw, source),
    );
    const execution = await this.executor.prepare(
      {
        subject: input.subject,
        policy: input.policy,
        occurrences,
        processing,
        signal: input.signal,
        ...(input.analysisId === undefined
          ? {}
          : { analysisId: input.analysisId }),
      },
      this.preparationDependencies,
    );
    return Object.freeze({ execution, policy: input.policy });
  }

  private async resolveSource(input: {
    readonly workspaceId: string;
    readonly pin: ExactAttachmentConnectorPin;
    readonly policy: AttachmentPreparationPolicy;
    readonly occurrences: readonly AttachmentOccurrence[];
  }): Promise<AttachmentSource> {
    if (input.occurrences.length === 0 || input.policy.mode === "disabled") {
      return disabledAttachmentSource;
    }
    try {
      return await this.dependencies.connectors.resolveAttachmentSource({
        workspaceId: input.workspaceId,
        connectorRegistrationId: input.pin.connectorRegistrationId,
        connectorConfigurationVersionId:
          input.pin.connectorConfigurationVersionId,
      });
    } catch (error) {
      if (error instanceof RuntimeConnectorCapabilityUnavailableError) {
        throw new LiveAttachmentPreparationUnavailableError();
      }
      throw error;
    }
  }

  private async resolveProcessingPolicy(input: {
    readonly workspaceId: string;
    readonly policy: AttachmentPreparationPolicy;
    readonly processingContext: Parameters<
      AttachmentProcessingPolicyResolver["resolve"]
    >[0]["context"];
    readonly signal: AbortSignal;
  }): Promise<AttachmentOccurrencePreparationProcessingPolicy> {
    try {
      const processing = await this.dependencies.processingPolicies.resolve({
        workspaceId: input.workspaceId,
        policy: input.policy,
        context: input.processingContext,
        signal: input.signal,
      });
      throwIfAborted(input.signal);
      if (processing === undefined) {
        throw new LiveAttachmentPreparationUnavailableError();
      }
      return processing;
    } catch (error) {
      if (error instanceof AttachmentCancelledError) throw error;
      throw new LiveAttachmentPreparationUnavailableError();
    }
  }
}

class ReservationOccurrencePersistence
  implements AttachmentOccurrencePersistence
{
  public constructor(
    private readonly reservations: AttachmentReservationPort,
    private readonly clock: Clock,
  ) {}

  public async recordAccepted(input: {
    readonly subject: AttachmentPreparationSubject;
    readonly occurrence: AttachmentOccurrenceDescriptor;
    readonly attachment: AcceptedAttachment;
    readonly signal: AbortSignal;
  }): Promise<void> {
    throwIfAborted(input.signal);
    await this.reservations.recordReservedAttachment({
      attachmentId: input.occurrence.attachmentId,
      attachment: input.attachment,
      observedAt: this.clock.now(),
    });
  }

  public async recordDerivativeSource(input: {
    readonly subject: AttachmentPreparationSubject;
    readonly occurrence: AttachmentOccurrenceDescriptor;
    readonly derivative: AttachmentDerivative;
    readonly signal: AbortSignal;
  }): Promise<void> {
    throwIfAborted(input.signal);
    await this.reservations.recordReservedDerivativeSource({
      subject: input.subject,
      occurrence: input.occurrence,
      derivativeId: input.derivative.id,
    });
  }
}

const disabledAttachmentSource: AttachmentSource = Object.freeze({
  async openAttachment(): Promise<never> {
    throw new LiveAttachmentPreparationUnavailableError();
  },
});

function attachmentDescriptors(
  workspaceId: string,
  connectorRegistrationId: string,
  occurrences: readonly AttachmentOccurrence[],
  policyMode: AttachmentPreparationPolicy["mode"],
): readonly Readonly<{
  readonly descriptor: AttachmentOccurrenceDescriptor;
  readonly raw: AttachmentOccurrence;
}>[] {
  const identities = new Set<string>();
  const entries = occurrences.map((raw) => {
    if (raw.reference.connectorInstanceId !== connectorRegistrationId) {
      throw new LiveAttachmentPreparationUnavailableError();
    }
    const identity = attachmentOccurrenceIdentity(raw);
    if (identities.has(identity)) {
      throw new LiveAttachmentPreparationUnavailableError();
    }
    identities.add(identity);
    return Object.freeze({ identity, raw });
  });
  return Object.freeze(
    entries
      .toSorted((left, right) => left.identity.localeCompare(right.identity))
      .map(({ identity, raw }, ordinal) =>
        Object.freeze({
          descriptor: Object.freeze({
            identity,
            ownerIdentity: sha256CanonicalJson(raw.owner),
            sourceOrdinal: raw.ordinal,
            ordinal,
            attachmentId: attachmentId(workspaceId, raw.reference),
            relation: raw.relation,
            required: policyMode === "required",
          }),
          raw,
        }),
      ),
  );
}

async function reserveAttachments(input: {
  readonly reservations: AttachmentReservationPort;
  readonly workspaceId: string;
  readonly occurrences: readonly Readonly<{
    readonly descriptor: AttachmentOccurrenceDescriptor;
    readonly raw: AttachmentOccurrence;
  }>[];
  readonly clock: Clock;
  readonly signal: AbortSignal;
}): Promise<void> {
  for (const occurrence of input.occurrences) {
    throwIfAborted(input.signal);
    await input.reservations.reserveAttachment({
      id: occurrence.descriptor.attachmentId,
      workspaceId: input.workspaceId,
      reference: occurrence.raw.reference,
      observedAt: input.clock.now(),
    });
  }
}

function serverPrivateOccurrence(
  descriptor: AttachmentOccurrenceDescriptor,
  raw: AttachmentOccurrence,
  source: AttachmentSource,
): ServerPrivateAttachmentOccurrence {
  return Object.freeze({
    occurrence: descriptor,
    source,
    reference: raw.reference,
    openIdentity: raw,
    ...(raw.declared?.mediaType === undefined
      ? {}
      : { declaredMimeType: raw.declared.mediaType }),
  });
}

function sourceDocumentSubject(
  workspaceId: string,
  sourceId: string,
  document: KnowledgeDocument,
): AttachmentPreparationSubject {
  return Object.freeze({
    workspaceId,
    kind: "sourceDocument",
    id: `source-document:${opaqueIdentity({ workspaceId, sourceId, reference: document.reference })}`,
  });
}

function caseCaptureSubject(
  workspaceId: string,
  caseCaptureId: string,
): AttachmentPreparationSubject {
  requireCaseWeaverIdentifier(caseCaptureId);
  return Object.freeze({
    workspaceId,
    kind: "caseCapture",
    id: `case-capture:${opaqueIdentity({ workspaceId, caseCaptureId })}`,
  });
}

function caseOccurrences(
  normalizedCase: NormalizedCase,
): readonly AttachmentOccurrence[] {
  return Object.freeze([
    ...(normalizedCase.attachmentOccurrences ?? []),
    ...normalizedCase.messages.flatMap(
      (message) => message.attachmentOccurrences ?? [],
    ),
  ]);
}

function attachmentId(
  workspaceId: string,
  reference: ExternalReference,
): string {
  return `attachment:${opaqueIdentity({ workspaceId, reference })}`;
}

function opaqueIdentity(value: object): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function assertPin(pin: ExactAttachmentConnectorPin): void {
  if (
    !isIdentifier(pin.connectorRegistrationId) ||
    !isIdentifier(pin.connectorConfigurationVersionId)
  ) {
    throw new LiveAttachmentPreparationUnavailableError();
  }
}

function assertSubject(
  subject: AttachmentPreparationSubject,
  workspaceId: string,
): void {
  if (subject.workspaceId !== workspaceId || !isIdentifier(subject.id)) {
    throw new LiveAttachmentPreparationUnavailableError();
  }
}

function assertProcessingContext(
  context: Parameters<
    AttachmentProcessingPolicyResolver["resolve"]
  >[0]["context"],
): void {
  if (
    context.kind === "knowledgeSource" &&
    !isIdentifier(context.sourceConfigurationVersionId)
  ) {
    throw new LiveAttachmentPreparationUnavailableError();
  }
}

function requireCaseWeaverIdentifier(value: string): void {
  if (!isIdentifier(value)) {
    throw new LiveAttachmentPreparationUnavailableError();
  }
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/u.test(value);
}

function assertSelectedDerivatives(
  derivatives: readonly PreparedAttachmentDerivative[],
  selected: readonly Readonly<{
    readonly occurrenceIdentity: string;
    readonly derivativeIdentity: string;
    readonly derivativeContentHash: string;
  }>[],
): void {
  const actual = derivatives
    .map((derivative) =>
      JSON.stringify([
        derivative.occurrenceIdentity,
        derivative.derivativeIdentity,
        derivative.derivativeContentHash,
      ]),
    )
    .toSorted();
  const expected = selected
    .map((derivative) =>
      JSON.stringify([
        derivative.occurrenceIdentity,
        derivative.derivativeIdentity,
        derivative.derivativeContentHash,
      ]),
    )
    .toSorted();
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new LiveAttachmentPreparationUnavailableError();
  }
}

function redactedPreparationError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted || error instanceof AttachmentCancelledError) {
    return new AttachmentCancelledError();
  }
  if (
    error instanceof LiveAttachmentPreparationUnavailableError ||
    error instanceof RequiredCaseAttachmentPreparationError
  ) {
    return error;
  }
  return new LiveAttachmentPreparationUnavailableError();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AttachmentCancelledError();
  }
}
