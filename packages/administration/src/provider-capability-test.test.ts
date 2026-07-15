import type {
  AiExecutionGateway,
  AiExecutionPreflightGateway,
  MeteredAiRequest,
} from "@caseweaver/ai-execution";
import { describe, expect, it, vi } from "vitest";
import {
  AdministrationAuditUnavailableError,
  IdempotencyConflictError,
} from "./errors.js";
import {
  type ImmutableProviderCapabilityTestConfiguration,
  PreviewProviderCapabilityTest,
  type ProviderCapabilityTestClaimStore,
  type ProviderCapabilityTestDependencies,
  RunProviderCapabilityTest,
} from "./provider-capability-test.js";

const digest = "a".repeat(64);
const timestamp = "2026-07-15T12:00:00.000Z";

const template: MeteredAiRequest = Object.freeze({
  kind: "generation",
  role: "analysis",
  request: Object.freeze({
    messages: Object.freeze([
      Object.freeze({ role: "user", content: "A fixed health-check prompt." }),
    ]),
    maxOutputTokens: 4,
  }),
  maximumInputTokens: 16,
  maximumOutputTokens: 4,
  budget: Object.freeze({
    currency: "USD",
    hard: false,
    allowUnknownPricing: true,
  }),
  timeoutMs: 90_000,
});

function configuration(
  overrides: Partial<ImmutableProviderCapabilityTestConfiguration> = {},
): ImmutableProviderCapabilityTestConfiguration {
  return Object.freeze({
    workspaceId: "workspace-1",
    providerInstanceId: "provider-1",
    providerInstanceVersionId: "provider-1:2",
    bindingVersionId: "binding-1:4",
    testOperation: "healthCheck",
    templateDigest: "b".repeat(64),
    request: template,
    timeoutMs: 5_000,
    budgetPolicy: Object.freeze({ status: "configured" as const }),
    ...overrides,
  });
}

function command(
  overrides: Partial<Parameters<RunProviderCapabilityTest["execute"]>[0]> = {},
) {
  return {
    workspaceId: "workspace-1",
    principalId: "principal-1",
    sessionId: "session-1",
    providerInstanceId: "provider-1",
    testOperation: "healthCheck",
    confirmationId: "confirmation-1",
    idempotency: { keyDigest: digest },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function claims(
  overrides: Partial<ProviderCapabilityTestClaimStore> = {},
): ProviderCapabilityTestClaimStore {
  return {
    claim: vi.fn(async () => ({ kind: "acquired" as const, id: "test-1" })),
    ...overrides,
  };
}

function harness(
  input: {
    readonly config?: ImmutableProviderCapabilityTestConfiguration | undefined;
    readonly claimStore?: ProviderCapabilityTestClaimStore;
    readonly confirmation?: boolean;
    readonly rateAllowed?: boolean;
    readonly gateway?: AiExecutionGateway;
    readonly preflight?: AiExecutionPreflightGateway;
    readonly complete?: ProviderCapabilityTestDependencies["results"]["completeAndRecord"];
  } = {},
) {
  const gateway =
    input.gateway ??
    ({
      execute: vi.fn(async () => ({
        operationId: "ai-operation-1",
        value: { text: "provider output must not leave this use case" },
        calculatedCost: {
          status: "known" as const,
          amount: "0.01",
          currency: "USD",
          components: [],
        },
      })),
    } satisfies AiExecutionGateway);
  const preflight =
    input.preflight ??
    ({
      preflight: vi.fn(async () => ({
        bindingVersionId: "binding-1:4",
        providerInstanceVersionId: "provider-1:2",
        catalogSnapshotId: "catalog-1",
        configuredModel: "model-1",
        maximumInputTokens: 16,
        maximumOutputTokens: 4,
        pricing: { status: "known" as const, components: [] },
        conservativeCost: {
          status: "known" as const,
          amount: "0.02",
          currency: "USD",
          components: [],
        },
      })),
    } satisfies AiExecutionPreflightGateway);
  const stores = {
    configurations: {
      load: vi.fn(async () => input.config ?? configuration()),
    },
    confirmations: {
      issueAndRecord: vi.fn(async () => ({
        confirmationId: "confirmation-1",
        confirmation: "Run the configured provider health check.",
        impact: "One bounded, metered provider request will run.",
        expiresAt: "2026-07-15T12:05:00.000Z",
      })),
      recordPreviewAudit: vi.fn(async () => undefined),
      consume: vi.fn(async () => input.confirmation ?? true),
    },
    rateLimiter: {
      acquire: vi.fn(async () => ({ allowed: input.rateAllowed ?? true })),
    },
    claims: input.claimStore ?? claims(),
    results: {
      completeAndRecord: input.complete ?? vi.fn(async ({ result }) => result),
    },
  };
  return {
    ...stores,
    gateway,
    preflight,
    service: new RunProviderCapabilityTest({
      ...stores,
      gateway,
      preflight,
      clock: { now: () => timestamp },
    }),
  };
}

describe("provider capability-test use cases", () => {
  it("issues a session-bound server preview only when pricing is known", async () => {
    const test = harness();
    const preview = new PreviewProviderCapabilityTest(
      test.configurations,
      test.confirmations,
      test.preflight,
      { now: () => timestamp },
    );

    await expect(
      preview.execute({
        workspaceId: "workspace-1",
        principalId: "principal-1",
        sessionId: "session-1",
        providerInstanceId: "provider-1",
        testOperation: "healthCheck",
      }),
    ).resolves.toEqual({
      providerInstanceId: "provider-1",
      providerInstanceVersionId: "provider-1:2",
      bindingVersionId: "binding-1:4",
      testOperation: "healthCheck",
      pricingStatus: "known",
      canConfirm: true,
      confirmationId: "confirmation-1",
      confirmation: "Run the configured provider health check.",
      impact: "One bounded, metered provider request will run.",
      estimatedCost: { amount: "0.02", currency: "USD" },
      expiresAt: "2026-07-15T12:05:00.000Z",
    });
    expect(test.confirmations.issueAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        templateDigest: "b".repeat(64),
        bindingVersionId: "binding-1:4",
        audit: expect.objectContaining({
          action: "admin.provider.capabilityTest.preview",
          targetId: "provider-1",
        }),
      }),
    );

    const unpriced = harness({
      preflight: {
        preflight: vi.fn(async () => ({
          bindingVersionId: "binding-1:4",
          providerInstanceVersionId: "provider-1:2",
          catalogSnapshotId: "catalog-1",
          configuredModel: "model-1",
          maximumInputTokens: 16,
          maximumOutputTokens: 4,
          pricing: { status: "unknown" as const, components: [] },
          conservativeCost: { status: "unknown" as const, components: [] },
        })),
      },
    });
    const unpricedPreview = new PreviewProviderCapabilityTest(
      unpriced.configurations,
      unpriced.confirmations,
      unpriced.preflight,
      { now: () => timestamp },
    );
    await expect(
      unpricedPreview.execute({
        workspaceId: "workspace-1",
        principalId: "principal-1",
        sessionId: "session-1",
        providerInstanceId: "provider-1",
        testOperation: "healthCheck",
      }),
    ).resolves.toMatchObject({
      pricingStatus: "unknown",
      canConfirm: false,
      reasonCode: "pricing.unknown",
    });
    expect(unpriced.confirmations.issueAndRecord).not.toHaveBeenCalled();
    expect(unpriced.confirmations.recordPreviewAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        reasonCode: "pricing.unknown",
      }),
    );
  });

  it("does not accept a browser digest and denies a test without a budget policy", async () => {
    const missingPolicy = harness({
      config: configuration({ budgetPolicy: { status: "missing" } }),
    });
    const preview = new PreviewProviderCapabilityTest(
      missingPolicy.configurations,
      missingPolicy.confirmations,
      missingPolicy.preflight,
      { now: () => timestamp },
    );

    await expect(
      preview.execute({
        workspaceId: "workspace-1",
        principalId: "principal-1",
        sessionId: "session-1",
        providerInstanceId: "provider-1",
        testOperation: "healthCheck",
      }),
    ).resolves.toMatchObject({
      canConfirm: false,
      reasonCode: "budget.policy_missing",
    });
    expect(missingPolicy.preflight.preflight).not.toHaveBeenCalled();
    expect(missingPolicy.confirmations.issueAndRecord).not.toHaveBeenCalled();
    expect(missingPolicy.confirmations.recordPreviewAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        reasonCode: "budget.policy_missing",
      }),
    );

    await expect(
      missingPolicy.service.execute(command()),
    ).resolves.toMatchObject({
      outcome: "denied",
      reasonCode: "budget.policy_missing",
    });
    expect(missingPolicy.gateway.execute).not.toHaveBeenCalled();
  });

  it("fails closed when issuing a confirmation and its audit cannot commit atomically", async () => {
    const test = harness();
    test.confirmations.issueAndRecord.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    const preview = new PreviewProviderCapabilityTest(
      test.configurations,
      test.confirmations,
      test.preflight,
      { now: () => timestamp },
    );

    await expect(
      preview.execute({
        workspaceId: "workspace-1",
        principalId: "principal-1",
        sessionId: "session-1",
        providerInstanceId: "provider-1",
        testOperation: "healthCheck",
      }),
    ).rejects.toBeInstanceOf(AdministrationAuditUnavailableError);
  });

  it("uses a bound safe template through the exclusive gateway with a hard known-price budget", async () => {
    const test = harness();

    const result = await test.service.execute(command());

    expect(result).toEqual({
      id: "test-1",
      providerInstanceId: "provider-1",
      providerInstanceVersionId: "provider-1:2",
      bindingVersionId: "binding-1:4",
      testOperation: "healthCheck",
      outcome: "succeeded",
      operationId: "ai-operation-1",
      estimatedCost: { amount: "0.02", currency: "USD" },
      actualCost: { amount: "0.01", currency: "USD" },
      completedAt: timestamp,
      idempotency: "created",
    });
    expect(test.gateway.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingVersionId: "binding-1:4",
        timeoutMs: 5_000,
        budget: {
          currency: "USD",
          hard: true,
          requireBudgetPolicy: true,
        },
      }),
      { workspaceId: "workspace-1", signal: expect.any(AbortSignal) },
    );
    expect(test.gateway.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({
        budget: expect.objectContaining({ allowUnknownPricing: true }),
      }),
      expect.anything(),
    );
    expect(test.preflight.preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingVersionId: "binding-1:4",
        budget: expect.objectContaining({ requireBudgetPolicy: true }),
      }),
      { workspaceId: "workspace-1" },
    );
    expect(test.confirmations.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingVersionId: "binding-1:4",
        templateDigest: "b".repeat(64),
        estimatedCost: { amount: "0.02", currency: "USD" },
      }),
    );
    expect(test.results.completeAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          action: "admin.provider.capabilityTest",
          targetId: "provider-1",
          permission: "configuration.manage",
          outcome: "succeeded",
        }),
      }),
    );
    expect(
      JSON.stringify(test.results.completeAndRecord.mock.calls),
    ).not.toContain("provider output must not leave this use case");
  });

  it("denies unknown and incomplete pricing without treating either as zero", async () => {
    for (const pricing of ["unknown", "incomplete"] as const) {
      const test = harness({
        preflight: {
          preflight: vi.fn(async () => ({
            bindingVersionId: "binding-1:4",
            providerInstanceVersionId: "provider-1:2",
            catalogSnapshotId: "catalog-1",
            configuredModel: "model-1",
            maximumInputTokens: 16,
            maximumOutputTokens: 4,
            pricing: { status: pricing, components: [] },
            conservativeCost: { status: pricing, components: [] },
          })),
        },
      });

      await expect(test.service.execute(command())).resolves.toMatchObject({
        outcome: "denied",
        reasonCode: "pricing.unknown",
      });
      expect(test.gateway.execute).not.toHaveBeenCalled();
      expect(test.confirmations.consume).not.toHaveBeenCalled();
      expect(test.rateLimiter.acquire).not.toHaveBeenCalled();
      expect(test.results.completeAndRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          result: expect.not.objectContaining({
            estimatedCost: expect.anything(),
          }),
          audit: expect.objectContaining({
            outcome: "denied",
            reasonCode: "pricing.unknown",
          }),
        }),
      );
    }
  });

  it("records confirmation and rate-limit denials atomically without invoking a provider", async () => {
    const unconfirmed = harness({ confirmation: false });
    await expect(unconfirmed.service.execute(command())).resolves.toMatchObject(
      {
        outcome: "denied",
        reasonCode: "confirmation.required",
      },
    );
    expect(unconfirmed.rateLimiter.acquire).not.toHaveBeenCalled();
    expect(unconfirmed.gateway.execute).not.toHaveBeenCalled();

    const limited = harness({ rateAllowed: false });
    await expect(limited.service.execute(command())).resolves.toMatchObject({
      outcome: "denied",
      reasonCode: "rate_limited",
    });
    expect(limited.gateway.execute).not.toHaveBeenCalled();
    expect(limited.results.completeAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          outcome: "denied",
          reasonCode: "rate_limited",
        }),
      }),
    );
  });

  it("replays a durable idempotency result without consuming confirmation, rate, or budget", async () => {
    const stored = {
      id: "test-previous",
      workspaceId: "workspace-1",
      providerInstanceId: "provider-1",
      providerInstanceVersionId: "provider-1:2",
      bindingVersionId: "binding-1:4",
      testOperation: "healthCheck",
      outcome: "succeeded" as const,
      operationId: "ai-operation-previous",
      completedAt: timestamp,
    };
    const test = harness({
      claimStore: claims({
        claim: vi.fn(async () => ({
          kind: "replayed" as const,
          result: stored,
        })),
      }),
    });

    await expect(test.service.execute(command())).resolves.toMatchObject({
      id: "test-previous",
      idempotency: "replayed",
      outcome: "succeeded",
    });
    expect(test.confirmations.consume).not.toHaveBeenCalled();
    expect(test.rateLimiter.acquire).not.toHaveBeenCalled();
    expect(test.gateway.execute).not.toHaveBeenCalled();
    expect(test.results.completeAndRecord).not.toHaveBeenCalled();
  });

  it("returns outcome unknown for an in-progress idempotency claim instead of duplicating a model call", async () => {
    const test = harness({
      claimStore: claims({
        claim: vi.fn(async () => ({
          kind: "inProgress" as const,
          id: "test-pending",
        })),
      }),
    });

    await expect(test.service.execute(command())).resolves.toEqual({
      id: "test-pending",
      providerInstanceId: "provider-1",
      providerInstanceVersionId: "provider-1:2",
      bindingVersionId: "binding-1:4",
      testOperation: "healthCheck",
      outcome: "outcome_unknown",
      idempotency: "in_progress",
    });
    expect(test.gateway.execute).not.toHaveBeenCalled();
  });

  it("records a generic terminal failure and never returns provider exception text", async () => {
    const providerSecret = "super-secret-provider-response";
    const test = harness({
      gateway: {
        execute: vi.fn(async () => {
          throw new Error(providerSecret);
        }),
      },
    });

    const result = await test.service.execute(command());

    expect(result).toMatchObject({
      outcome: "failed",
      reasonCode: "execution.failed",
    });
    expect(JSON.stringify(result)).not.toContain(providerSecret);
    expect(
      JSON.stringify(test.results.completeAndRecord.mock.calls),
    ).not.toContain(providerSecret);
  });

  it("fails closed when the atomic result-and-audit write is unavailable", async () => {
    const test = harness({
      complete: vi.fn(async () => {
        throw new Error("audit database unavailable");
      }),
    });

    await expect(test.service.execute(command())).rejects.toBeInstanceOf(
      AdministrationAuditUnavailableError,
    );
    expect(test.gateway.execute).toHaveBeenCalledTimes(1);
    expect(test.results.completeAndRecord).toHaveBeenCalledTimes(1);
  });

  it("rejects idempotency conflicts and invalid immutable test controls before execution", async () => {
    const conflicted = harness({
      claimStore: claims({
        claim: vi.fn(async () => ({ kind: "conflict" as const })),
      }),
    });
    await expect(conflicted.service.execute(command())).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(conflicted.gateway.execute).not.toHaveBeenCalled();

    const invalid = harness({
      config: configuration({ timeoutMs: 30_001 }),
    });
    await expect(invalid.service.execute(command())).rejects.toMatchObject({
      code: "administration.invalid",
    });
    expect(invalid.gateway.execute).not.toHaveBeenCalled();
  });

  it("does not report a successful test when the gateway supplies an unknown calculated cost", async () => {
    const test = harness({
      gateway: {
        execute: vi.fn(async () => ({
          operationId: "ai-operation-1",
          value: { text: "not returned" },
          calculatedCost: { status: "unknown" as const, components: [] },
        })),
      },
    });

    const result = await test.service.execute(command());
    expect(result).toMatchObject({
      outcome: "failed",
      reasonCode: "pricing.unknown",
    });
    expect(result).not.toHaveProperty("actualCost");
  });
});
