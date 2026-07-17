import {
  AttachmentCancelledError,
  type AttachmentOccurrencePreparationExecution,
  type AttachmentOccurrencePreparationProcessingPolicy,
  createAttachmentPreparationResult,
  type PrepareAttachmentOccurrencesRequest,
} from "@caseweaver/attachments";
import type {
  AttachmentOccurrence,
  ExternalReference,
  KnowledgeDocument,
  NormalizedCase,
} from "@caseweaver/connector-sdk";
import { sha256CanonicalJson } from "@caseweaver/connector-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  type AttachmentReservationPort,
  type LiveAttachmentPreparationDependencies,
  LiveAttachmentPreparationUnavailableError,
  LiveCaseAttachmentPreparation,
  LiveKnowledgeAttachmentPreparation,
  RequiredCaseAttachmentPreparationError,
} from "./live-attachment-preparation.js";

const signal = new AbortController().signal;
const workspaceId = "workspace-1";
const pin = {
  connectorRegistrationId: "connector-1",
  connectorConfigurationVersionId: "connector-version-1",
};
const knowledgeSourcePin = {
  sourceConfigurationVersionId: "source-configuration-version-1",
  ...pin,
};
const processing = {} as AttachmentOccurrencePreparationProcessingPolicy;
const documentReference: ExternalReference = {
  connectorInstanceId: "connector-1",
  resourceType: "document",
  externalId: "document-1",
};
const attachmentReference: ExternalReference = {
  connectorInstanceId: "connector-1",
  resourceType: "attachment",
  externalId: "attachment-1",
};
const optionalPolicy = {
  mode: "optional" as const,
  policyVersion: "policy-1",
  accessPolicyHash: "access-1",
};
const requiredPolicy = { ...optionalPolicy, mode: "required" as const };
const disabledPolicy = { ...optionalPolicy, mode: "disabled" as const };

function occurrence(input: {
  readonly owner: AttachmentOccurrence["owner"];
  readonly ordinal: number;
  readonly reference?: ExternalReference;
}): AttachmentOccurrence {
  return {
    owner: input.owner,
    ordinal: input.ordinal,
    relation: "inlineImage",
    reference: input.reference ?? attachmentReference,
    locator: "private-locator-must-never-escape",
    declared: { mediaType: "image/png" },
  };
}

function document(
  occurrences: readonly AttachmentOccurrence[] = [],
): KnowledgeDocument {
  return {
    reference: documentReference,
    body: { format: "plainText", normalizedText: "Server-only document" },
    attachments: [],
    ...(occurrences.length === 0 ? {} : { attachmentOccurrences: occurrences }),
  } as KnowledgeDocument;
}

function normalizedCase(
  occurrences: readonly AttachmentOccurrence[] = [],
): NormalizedCase {
  return {
    reference: {
      connectorInstanceId: "connector-1",
      resourceType: "case",
      externalId: "case-1",
    },
    subject: "Support case",
    messages: [],
    attachments: [],
    ...(occurrences.length === 0 ? {} : { attachmentOccurrences: occurrences }),
  } as NormalizedCase;
}

function execution(
  request: PrepareAttachmentOccurrencesRequest,
  input?: {
    readonly warnings?: readonly Readonly<{
      readonly kind: "attachmentPreparationWarning";
      readonly code: string;
      readonly retryable: boolean;
      readonly occurrenceIdentity?: string;
    }>[];
    readonly derivatives?: readonly Readonly<{
      readonly occurrenceIdentity: string;
      readonly derivativeIdentity: string;
      readonly derivativeContentHash: string;
      readonly searchableText: string;
    }>[];
  },
): AttachmentOccurrencePreparationExecution {
  return {
    subject: request.subject,
    planIdentity: "plan-1",
    result: createAttachmentPreparationResult({
      policy: request.policy,
      ...(input?.warnings === undefined ? {} : { warnings: input.warnings }),
      ...(input?.derivatives === undefined
        ? {}
        : { derivatives: input.derivatives }),
    }),
    attempt: { id: "attempt-1", planIdentity: "plan-1" },
  };
}

function dependencies(input?: {
  readonly execute?: (
    request: PrepareAttachmentOccurrencesRequest,
  ) =>
    | AttachmentOccurrencePreparationExecution
    | Promise<AttachmentOccurrencePreparationExecution>;
  readonly resolveAttachmentSource?: ReturnType<typeof vi.fn>;
  readonly resolveProcessingPolicy?: ReturnType<typeof vi.fn>;
  readonly reservations?: AttachmentReservationPort;
  readonly preparedText?: LiveAttachmentPreparationDependencies["preparedText"];
}): {
  readonly value: LiveAttachmentPreparationDependencies;
  readonly reserveAttachment: ReturnType<typeof vi.fn>;
  readonly resolveAttachmentSource: ReturnType<typeof vi.fn>;
  readonly resolveProcessingPolicy: ReturnType<typeof vi.fn>;
  readonly processing: AttachmentOccurrencePreparationProcessingPolicy;
} {
  const reserveAttachment = vi.fn(async () => undefined);
  const reservations =
    input?.reservations ??
    ({
      reserveAttachment,
      recordReservedAttachment: vi.fn(async () => undefined),
      recordReservedDerivativeSource: vi.fn(async () => undefined),
    } satisfies AttachmentReservationPort);
  const resolveAttachmentSource =
    input?.resolveAttachmentSource ??
    vi.fn(async () => ({ openAttachment: vi.fn() }));
  const resolveProcessingPolicy =
    input?.resolveProcessingPolicy ?? vi.fn(async () => processing);
  return {
    value: {
      connectors: { resolveAttachmentSource },
      reservations,
      attempts: {} as never,
      blobStore: {} as never,
      outputStore: {} as never,
      repository: {} as never,
      runtime: {} as never,
      processingPolicies: { resolve: resolveProcessingPolicy },
      clock: { now: () => "2026-07-17T12:00:00.000Z" } as never,
      ...(input?.preparedText === undefined
        ? {}
        : { preparedText: input.preparedText }),
      executor: {
        prepare: async (request) =>
          input?.execute === undefined
            ? execution(request)
            : input.execute(request),
      },
    },
    reserveAttachment,
    resolveAttachmentSource,
    resolveProcessingPolicy,
    processing,
  };
}

describe("live worker attachment preparation", () => {
  it("resolves a knowledge attachment source through the immutable exact pin and reserves before preparation", async () => {
    const state = dependencies();
    const prepare = vi.fn(state.value.executor?.prepare);
    const adapter = new LiveKnowledgeAttachmentPreparation({
      ...state.value,
      executor: { prepare },
    });
    const observed = occurrence({
      owner: { kind: "knowledgeDocument", document: documentReference },
      ordinal: 0,
    });

    await adapter.prepare({
      workspaceId,
      sourceId: "source-1",
      ...knowledgeSourcePin,
      document: document([observed]),
      policy: optionalPolicy,
      signal,
    });

    expect(state.resolveAttachmentSource).toHaveBeenCalledWith({
      workspaceId,
      ...pin,
    });
    expect(state.resolveProcessingPolicy).toHaveBeenCalledWith({
      workspaceId,
      policy: optionalPolicy,
      context: {
        kind: "knowledgeSource",
        sourceConfigurationVersionId: "source-configuration-version-1",
      },
      signal,
    });
    expect(prepare.mock.calls[0]?.[0].processing).toBe(state.processing);
    expect(state.reserveAttachment).toHaveBeenCalledBefore(prepare);
    expect(state.reserveAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, reference: attachmentReference }),
    );
  });

  it("fails closed on an invalid direct knowledge pin instead of falling back to a current connector configuration", async () => {
    const state = dependencies();
    const adapter = new LiveKnowledgeAttachmentPreparation(state.value);

    await expect(
      adapter.prepare({
        workspaceId,
        sourceId: "source-1",
        ...knowledgeSourcePin,
        sourceConfigurationVersionId: "",
        document: document(),
        policy: optionalPolicy,
        signal,
      }),
    ).rejects.toBeInstanceOf(LiveAttachmentPreparationUnavailableError);

    expect(state.resolveProcessingPolicy).not.toHaveBeenCalled();
    expect(state.resolveAttachmentSource).not.toHaveBeenCalled();
    expect(state.reserveAttachment).not.toHaveBeenCalled();
  });

  it("fails closed before reservation or connector I/O when the exact immutable policy cannot be resolved", async () => {
    const resolveProcessingPolicy = vi.fn(async () => undefined);
    const state = dependencies({ resolveProcessingPolicy });
    const adapter = new LiveKnowledgeAttachmentPreparation(state.value);
    const observed = occurrence({
      owner: { kind: "knowledgeDocument", document: documentReference },
      ordinal: 0,
    });

    await expect(
      adapter.prepare({
        workspaceId,
        sourceId: "source-1",
        ...knowledgeSourcePin,
        document: document([observed]),
        policy: optionalPolicy,
        signal,
      }),
    ).rejects.toBeInstanceOf(LiveAttachmentPreparationUnavailableError);

    expect(resolveProcessingPolicy).toHaveBeenCalledWith({
      workspaceId,
      policy: optionalPolicy,
      context: {
        kind: "knowledgeSource",
        sourceConfigurationVersionId: "source-configuration-version-1",
      },
      signal,
    });
    expect(state.reserveAttachment).not.toHaveBeenCalled();
    expect(state.resolveAttachmentSource).not.toHaveBeenCalled();
  });

  it("resolves the immutable case policy before reservation and connector I/O", async () => {
    const order: string[] = [];
    const state = dependencies({
      resolveProcessingPolicy: vi.fn(async () => {
        order.push("policy");
        return processing;
      }),
      resolveAttachmentSource: vi.fn(async () => {
        order.push("source");
        return { openAttachment: vi.fn() };
      }),
      execute: (request) => {
        order.push("prepare");
        return execution(request);
      },
    });
    vi.mocked(state.value.reservations.reserveAttachment).mockImplementation(
      async () => {
        order.push("reserve");
      },
    );
    const adapter = new LiveCaseAttachmentPreparation(state.value);
    const observed = occurrence({
      owner: { kind: "case", case: normalizedCase().reference },
      ordinal: 0,
    });

    await adapter.prepare({
      caseCaptureId: "capture-policy-order",
      workspaceId,
      ...pin,
      normalizedCase: normalizedCase([observed]),
      policy: optionalPolicy,
      signal,
    });

    expect(state.resolveProcessingPolicy).toHaveBeenCalledWith({
      workspaceId,
      policy: optionalPolicy,
      context: { kind: "caseCapture" },
      signal,
    });
    expect(order).toEqual(["policy", "reserve", "source", "prepare"]);
  });

  it("reserves every occurrence before the injected preparation can open its source bytes", async () => {
    const openAttachment = vi.fn(async () => ({ content: [] }));
    const source = { openAttachment };
    const state = dependencies({
      resolveAttachmentSource: vi.fn(async () => source),
      execute: async (request) => {
        const first = request.occurrences[0];
        if (first === undefined) throw new Error("test occurrence is missing");
        await first.source.openAttachment({
          reference: first.reference,
          signal: request.signal,
        });
        return execution(request);
      },
    });
    const adapter = new LiveCaseAttachmentPreparation(state.value);
    const observed = occurrence({
      owner: { kind: "case", case: normalizedCase().reference },
      ordinal: 0,
    });

    await adapter.prepare({
      caseCaptureId: "capture-reserved-before-open",
      workspaceId,
      ...pin,
      normalizedCase: normalizedCase([observed]),
      policy: optionalPolicy,
      signal,
    });

    expect(state.reserveAttachment).toHaveBeenCalledTimes(1);
    expect(openAttachment).toHaveBeenCalledTimes(1);
    expect(state.reserveAttachment.mock.invocationCallOrder[0]).toBeLessThan(
      openAttachment.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("keeps distinct occurrence evidence while allowing duplicate binary references to share a cache attachment identity", async () => {
    const requests: PrepareAttachmentOccurrencesRequest[] = [];
    const state = dependencies({
      execute: (request) => {
        requests.push(request);
        return execution(request);
      },
    });
    const adapter = new LiveCaseAttachmentPreparation(state.value);
    const caseReference = normalizedCase().reference;
    const root = occurrence({
      owner: { kind: "case", case: caseReference },
      ordinal: 0,
    });
    const message = occurrence({
      owner: {
        kind: "caseMessage",
        case: caseReference,
        messageExternalId: "comment-1",
      },
      ordinal: 0,
    });

    await adapter.prepare({
      caseCaptureId: "capture-1",
      workspaceId,
      ...pin,
      normalizedCase: {
        ...normalizedCase([root]),
        messages: [
          {
            externalId: "comment-1",
            sequence: 0,
            visibility: "public",
            body: { format: "plainText", normalizedText: "Comment" },
            attachments: [],
            attachmentOccurrences: [message],
          },
        ],
      } as NormalizedCase,
      policy: optionalPolicy,
      signal,
    });

    const preparedOccurrences = requests[0]?.occurrences ?? [];
    expect(preparedOccurrences).toHaveLength(2);
    expect(preparedOccurrences[0]?.occurrence.identity).not.toBe(
      preparedOccurrences[1]?.occurrence.identity,
    );
    expect(preparedOccurrences[0]?.occurrence.attachmentId).toBe(
      preparedOccurrences[1]?.occurrence.attachmentId,
    );
    expect(
      preparedOccurrences.map((prepared) => prepared.occurrence.sourceOrdinal),
    ).toEqual([0, 0]);
    expect(
      preparedOccurrences.map((prepared) => prepared.occurrence.ordinal),
    ).toEqual([0, 1]);
    expect(
      preparedOccurrences.map((prepared) => prepared.occurrence.ownerIdentity),
    ).toEqual(
      expect.arrayContaining([
        sha256CanonicalJson(root.owner),
        sha256CanonicalJson(message.owner),
      ]),
    );
    expect(preparedOccurrences[0]?.occurrence.ownerIdentity).not.toBe(
      preparedOccurrences[1]?.occurrence.ownerIdentity,
    );
    expect(
      JSON.stringify(
        preparedOccurrences.map((prepared) => prepared.occurrence),
      ),
    ).not.toContain("private-locator-must-never-escape");
    expect(state.reserveAttachment).toHaveBeenCalledTimes(2);
  });

  it("restores private text only for knowledge from a completed attempt and preserves its opaque terminal attempt ID", async () => {
    const observed = occurrence({
      owner: { kind: "knowledgeDocument", document: documentReference },
      ordinal: 0,
    });
    const identity = "occurrence-identity";
    const preparedText = {
      read: vi.fn(async () => [
        {
          occurrenceIdentity: identity,
          derivativeIdentity: "derivative-identity",
          derivativeContentHash: "content-hash",
          searchableText: "private derived text",
        },
      ]),
    };
    const state = dependencies({
      preparedText,
      execute: (request) =>
        execution(request, {
          derivatives: [],
        }),
    });
    const adapter = new LiveKnowledgeAttachmentPreparation({
      ...state.value,
      executor: {
        prepare: async (request, _runtime) => {
          const result = execution(request, {
            derivatives: [
              {
                occurrenceIdentity: identity,
                derivativeIdentity: "derivative-identity",
                derivativeContentHash: "content-hash",
                searchableText: "private derived text",
              },
            ],
          });
          return {
            ...result,
            result: {
              ...result.result,
              derivatives: [],
            },
          };
        },
      },
    });

    const result = await adapter.prepare({
      workspaceId,
      sourceId: "source-1",
      ...knowledgeSourcePin,
      document: document([observed]),
      policy: optionalPolicy,
      signal,
    });

    expect(result.attemptId).toBe("attempt-1");
    expect(result.derivatives).toEqual([
      expect.objectContaining({ searchableText: "private derived text" }),
    ]);
    expect(preparedText.read).toHaveBeenCalledOnce();
  });

  it("fails closed when a cache-hit text reader returns derivatives other than the terminal attempt selected", async () => {
    const observed = occurrence({
      owner: { kind: "knowledgeDocument", document: documentReference },
      ordinal: 0,
    });
    const preparedText = {
      read: vi.fn(async () => [
        {
          occurrenceIdentity: "other-occurrence",
          derivativeIdentity: "other-derivative",
          derivativeContentHash: "other-content",
          searchableText: "private text that must stay inside the worker",
        },
      ]),
    };
    const state = dependencies({ preparedText });
    const adapter = new LiveKnowledgeAttachmentPreparation({
      ...state.value,
      executor: {
        prepare: async (request, _runtime) => {
          const completed = execution(request, {
            derivatives: [
              {
                occurrenceIdentity: "selected-occurrence",
                derivativeIdentity: "selected-derivative",
                derivativeContentHash: "selected-content",
                searchableText: "private original text",
              },
            ],
          });
          return {
            ...completed,
            result: { ...completed.result, derivatives: [] },
          };
        },
      },
    });

    const error = await adapter
      .prepare({
        workspaceId,
        sourceId: "source-1",
        ...knowledgeSourcePin,
        document: document([observed]),
        policy: optionalPolicy,
        signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LiveAttachmentPreparationUnavailableError);
    expect(String(error)).not.toContain("private text");
    expect(preparedText.read).toHaveBeenCalledOnce();
  });

  it("returns safe optional warnings but fails a required case after its terminal attempt", async () => {
    const warning = {
      kind: "attachmentPreparationWarning" as const,
      code: "attachment.processing-failed",
      retryable: false,
      occurrenceIdentity: "occurrence-1",
    };
    const state = dependencies({
      execute: (request) => execution(request, { warnings: [warning] }),
    });
    const adapter = new LiveCaseAttachmentPreparation(state.value);

    const optional = await adapter.prepare({
      caseCaptureId: "capture-optional",
      workspaceId,
      ...pin,
      normalizedCase: normalizedCase(),
      policy: optionalPolicy,
      signal,
    });
    expect(optional.outcome.status).toBe("prepared");
    await expect(
      adapter.prepare({
        caseCaptureId: "capture-required",
        workspaceId,
        ...pin,
        normalizedCase: normalizedCase(),
        policy: requiredPolicy,
        signal,
      }),
    ).rejects.toBeInstanceOf(RequiredCaseAttachmentPreparationError);
  });

  it("does not resolve a source for disabled or empty work and keeps a stable opaque case subject", async () => {
    const subjects: string[] = [];
    const state = dependencies({
      execute: (request) => {
        subjects.push(request.subject.id);
        return execution(request);
      },
    });
    const adapter = new LiveCaseAttachmentPreparation(state.value);

    const first = await adapter.prepare({
      caseCaptureId: "capture-stable",
      workspaceId,
      ...pin,
      normalizedCase: normalizedCase(),
      policy: disabledPolicy,
      signal,
    });
    await adapter.prepare({
      caseCaptureId: "capture-stable",
      workspaceId,
      ...pin,
      normalizedCase: normalizedCase(),
      policy: optionalPolicy,
      signal,
    });

    expect(first.outcome.policy.mode).toBe("disabled");
    expect(state.resolveAttachmentSource).not.toHaveBeenCalled();
    expect(state.reserveAttachment).not.toHaveBeenCalled();
    expect(subjects).toEqual([subjects[0], subjects[0]]);
    expect(subjects[0]).toMatch(/^case-capture:[a-f0-9]{64}$/u);
  });

  it("redacts private connector errors and never serializes occurrence locators in a case result", async () => {
    const state = dependencies({
      resolveAttachmentSource: vi.fn(async () => {
        throw new Error("https://private.example/locator?token=top-secret");
      }),
    });
    const adapter = new LiveCaseAttachmentPreparation(state.value);
    const observed = occurrence({
      owner: { kind: "case", case: normalizedCase().reference },
      ordinal: 0,
    });

    const error = await adapter
      .prepare({
        caseCaptureId: "capture-private-error",
        workspaceId,
        ...pin,
        normalizedCase: normalizedCase([observed]),
        policy: optionalPolicy,
        signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LiveAttachmentPreparationUnavailableError);
    expect(String(error)).not.toContain("private.example");
    expect(String(error)).not.toContain("top-secret");
  });

  it("propagates a redacted in-flight attachment cancellation instead of treating it as retryable unavailability", async () => {
    const state = dependencies({
      execute: async () => {
        throw new AttachmentCancelledError();
      },
    });
    const adapter = new LiveCaseAttachmentPreparation(state.value);
    const observed = occurrence({
      owner: { kind: "case", case: normalizedCase().reference },
      ordinal: 0,
    });

    const error = await adapter
      .prepare({
        caseCaptureId: "capture-in-flight-cancellation",
        workspaceId,
        ...pin,
        normalizedCase: normalizedCase([observed]),
        policy: optionalPolicy,
        signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AttachmentCancelledError);
    expect((error as AttachmentCancelledError).retryable).toBe(false);
    expect(String(error)).not.toContain("private-locator-must-never-escape");
  });

  it("does not begin pin resolution, reservation, or connector I/O after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private cancellation reason"));
    const state = dependencies();
    const adapter = new LiveKnowledgeAttachmentPreparation({
      ...state.value,
    });

    const error = await adapter
      .prepare({
        workspaceId,
        sourceId: "source-1",
        ...knowledgeSourcePin,
        document: document(),
        policy: optionalPolicy,
        signal: controller.signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AttachmentCancelledError);
    expect((error as AttachmentCancelledError).retryable).toBe(false);
    expect(String(error)).not.toContain("private cancellation reason");
    expect(state.resolveProcessingPolicy).not.toHaveBeenCalled();
    expect(state.resolveAttachmentSource).not.toHaveBeenCalled();
    expect(state.reserveAttachment).not.toHaveBeenCalled();
  });
});
