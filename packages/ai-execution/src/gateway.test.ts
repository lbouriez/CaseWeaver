import {
  type CatalogModel,
  createImmutableBinding,
  decimal,
  type PriceComponent,
} from "@caseweaver/ai-config";
import {
  AiCancelledError,
  AiHardBudgetError,
  AiProviderError,
  AiTimeoutError,
  DeterministicAiProviderDispatcher,
} from "@caseweaver/ai-sdk";
import { describe, expect, it } from "vitest";

import {
  type AiBudgetPolicyRequirementPort,
  type AiBudgetPort,
  type AiExecutionTransaction,
  type AiExecutionUnitOfWork,
  type AiOperationLedgerPort,
  DefaultAiExecutionGateway,
} from "./index.js";

const input: PriceComponent = {
  id: "input",
  kind: "input",
  unit: "token",
  amount: decimal("0.001"),
  currency: "USD",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  sourceId: "catalog",
  conditions: {},
};

const output: PriceComponent = {
  ...input,
  id: "output",
  kind: "output",
  amount: decimal("0.002"),
};

function binding(
  catalogComponents: readonly PriceComponent[] = [input, output],
) {
  const model: CatalogModel = {
    id: "catalog-model",
    snapshotId: "snapshot-1",
    canonicalModel: "model-1",
    provider: "fake",
    supportedRoles: new Set(["analysis"]),
    capabilities: new Set(),
    maximumInputTokens: 10,
    maximumOutputTokens: 5,
    priceComponents: catalogComponents,
    rawEntry: {},
  };
  return createImmutableBinding({
    workspaceId: "workspace-1",
    bindingId: "binding-1",
    version: 1,
    role: "analysis",
    providerInstanceVersionId: "provider-version-1",
    providerType: "fake",
    endpoint: "https://fake.invalid",
    canonicalModel: "model-1",
    wireApi: "chatCompletions",
    secretReference: "vault:fake",
    catalogModel: model,
  });
}

function repositoryAgentBinding() {
  const model: CatalogModel = {
    id: "repository-agent-model",
    snapshotId: "snapshot-1",
    canonicalModel: "repository-agent-model",
    provider: "fake",
    supportedRoles: new Set(["repositoryAgent"]),
    capabilities: new Set(["repositoryAgent"]),
    maximumInputTokens: 10,
    maximumOutputTokens: 5,
    priceComponents: [input, output],
    rawEntry: {},
  };
  return createImmutableBinding({
    workspaceId: "workspace-1",
    bindingId: "repository-agent-binding",
    version: 1,
    role: "repositoryAgent",
    providerInstanceVersionId: "provider-version-1",
    providerType: "fake",
    endpoint: "https://fake.invalid",
    canonicalModel: "repository-agent-model",
    wireApi: "custom",
    secretReference: "vault:fake",
    catalogModel: model,
    maximumInputTokens: 10,
    maximumOutputTokens: 5,
  });
}

function harness(
  provider: DeterministicAiProviderDispatcher,
  model = binding(),
  options: Readonly<{
    readonly budgetPolicy?: AiBudgetPolicyRequirementPort;
  }> = {},
) {
  const starts: unknown[] = [];
  const finalizations: unknown[] = [];
  const reservations: unknown[] = [];
  const reconciliations: unknown[] = [];
  const unitOfWork: AiExecutionUnitOfWork = {
    transaction: async (operation) =>
      operation(Object.freeze({}) as AiExecutionTransaction),
  };
  const ledger: AiOperationLedgerPort = {
    start: async (_transaction, operation) => {
      starts.push(operation);
    },
    finalize: async (_transaction, operation) => {
      finalizations.push(operation);
    },
  };
  const budget: AiBudgetPort = {
    reserve: async (_transaction, reservation) => {
      reservations.push(reservation);
    },
    reconcile: async (_transaction, reconciliation) => {
      reconciliations.push(reconciliation);
    },
  };
  let next = 0;
  return {
    starts,
    finalizations,
    reservations,
    reconciliations,
    gateway: new DefaultAiExecutionGateway({
      bindingResolver: { resolve: async () => model },
      providerDispatcher: provider,
      secretResolver: { resolve: async () => ({ value: "secret" }) },
      ledger,
      budget,
      ...(options.budgetPolicy === undefined
        ? {}
        : { budgetPolicy: options.budgetPolicy }),
      unitOfWork,
      operationIds: { next: () => `operation-${++next}` },
      clock: { now: () => "2026-02-01T00:00:00.000Z" },
    }),
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    kind: "generation" as const,
    role: "analysis" as const,
    request: { messages: [{ role: "user" as const, content: "prompt" }] },
    maximumInputTokens: 10,
    maximumOutputTokens: 5,
    budget: { currency: "USD", hard: true },
    ...overrides,
  };
}

describe("DefaultAiExecutionGateway", () => {
  it("preflights the same immutable binding and conservative price without external side effects", async () => {
    const provider = new DeterministicAiProviderDispatcher({
      generate: async () => ({
        value: { text: "must not run" },
        metadata: { retryCount: 0 },
      }),
    });
    const test = harness(provider);

    await expect(
      test.gateway.preflight(request(), { workspaceId: "workspace-1" }),
    ).resolves.toMatchObject({
      bindingVersionId: "binding-1:1",
      providerInstanceVersionId: "provider-version-1",
      maximumInputTokens: 10,
      maximumOutputTokens: 5,
      conservativeCost: { status: "known", amount: "0.02", currency: "USD" },
    });

    expect(provider.calls).toHaveLength(0);
    expect(test.starts).toHaveLength(0);
    expect(test.reservations).toHaveLength(0);
    expect(test.finalizations).toHaveLength(0);
    expect(test.reconciliations).toHaveLength(0);
  });

  it("requires an applicable budget policy only when a request opts into the guard", async () => {
    const provider = new DeterministicAiProviderDispatcher({
      generate: async () => ({
        value: { text: "ok" },
        usage: { inputTokens: 1, outputTokens: 1 },
        metadata: { retryCount: 0 },
      }),
    });
    const blocked = harness(provider);
    await expect(
      blocked.gateway.execute(
        request({
          budget: {
            currency: "USD",
            hard: true,
            requireBudgetPolicy: true,
          },
        }),
        { workspaceId: "workspace-1", signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(AiHardBudgetError);
    expect(blocked.starts).toHaveLength(0);
    expect(blocked.reservations).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);

    const allowed = harness(provider, binding(), {
      budgetPolicy: { hasApplicablePolicy: async () => true },
    });
    await expect(
      allowed.gateway.execute(
        request({
          budget: {
            currency: "USD",
            hard: true,
            requireBudgetPolicy: true,
          },
        }),
        { workspaceId: "workspace-1", signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ operationId: "operation-1" });
  });

  it("starts, reserves, finalizes, and reconciles successful calls", async () => {
    const provider = new DeterministicAiProviderDispatcher({
      generate: async () => ({
        value: { text: "ok" },
        usage: { inputTokens: 2, outputTokens: 3 },
        metadata: { providerRequestId: "provider-request", retryCount: 0 },
      }),
    });
    const test = harness(provider);

    await expect(
      test.gateway.execute(request(), {
        workspaceId: "workspace-1",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      operationId: "operation-1",
      calculatedCost: { status: "known", amount: "0.008" },
    });
    expect(test.starts).toHaveLength(1);
    expect(test.reservations).toHaveLength(1);
    expect(test.finalizations).toMatchObject([{ status: "succeeded" }]);
    expect(test.reservations).toMatchObject([
      {
        scope: {
          operationId: "operation-1",
          day: "2026-02-01",
          workspace: "all",
        },
      },
    ]);
    expect(test.reconciliations).toMatchObject([{ status: "reconciled" }]);
  });

  it("retains an uncertain reservation after a dispatched provider failure", async () => {
    const provider = new DeterministicAiProviderDispatcher({
      generate: async () => {
        throw new AiProviderError("provider failure", { retryable: true });
      },
    });
    const test = harness(provider);

    await expect(
      test.gateway.execute(request(), {
        workspaceId: "workspace-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("provider failure");
    expect(provider.calls).toHaveLength(1);
    expect(test.finalizations).toMatchObject([
      {
        status: "failed",
        calculatedCost: { status: "unknown" },
        error: { code: "ai.provider", retryable: true },
      },
    ]);
    expect(test.reconciliations).toMatchObject([
      { status: "retainedUncertain" },
    ]);
  });

  it("records timeout and cancellation separately", async () => {
    const provider = new DeterministicAiProviderDispatcher({
      generate: async (invocation) =>
        new Promise((_, reject) => {
          invocation.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    const timedOut = harness(provider);
    await expect(
      timedOut.gateway.execute(request({ timeoutMs: 1 }), {
        workspaceId: "workspace-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AiTimeoutError);
    expect(timedOut.finalizations).toMatchObject([{ status: "timedOut" }]);

    const controller = new AbortController();
    const cancelled = harness(provider);
    const pending = cancelled.gateway.execute(request(), {
      workspaceId: "workspace-1",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AiCancelledError);
    expect(cancelled.finalizations).toMatchObject([{ status: "cancelled" }]);
  });

  it("finalizes and releases a cancellation before provider dispatch", async () => {
    const provider = new DeterministicAiProviderDispatcher({
      generate: async () => ({
        value: { text: "must not run" },
        metadata: { retryCount: 0 },
      }),
    });
    const test = harness(provider);
    const controller = new AbortController();
    controller.abort();

    await expect(
      test.gateway.execute(request(), {
        workspaceId: "workspace-1",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AiCancelledError);

    expect(provider.calls).toHaveLength(0);
    expect(test.starts).toHaveLength(1);
    expect(test.finalizations).toMatchObject([
      {
        status: "cancelled",
        error: { code: "ai.cancelled", retryable: false },
      },
    ]);
    expect(test.reconciliations).toMatchObject([{ status: "released" }]);
  });

  it("rejects unknown hard pricing unless explicit bypass is supplied", async () => {
    const provider = new DeterministicAiProviderDispatcher({
      generate: async () => ({
        value: { text: "ok" },
        metadata: { retryCount: 0 },
      }),
    });
    const blocked = harness(provider, binding([]));
    await expect(
      blocked.gateway.execute(request(), {
        workspaceId: "workspace-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AiHardBudgetError);
    expect(provider.calls).toHaveLength(0);

    const bypassed = harness(provider, binding([]));
    await expect(
      bypassed.gateway.execute(
        request({
          budget: { currency: "USD", hard: true, allowUnknownPricing: true },
        }),
        { workspaceId: "workspace-1", signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ operationId: "operation-1" });
    expect(bypassed.reservations).toMatchObject([
      { unknownPriceBypass: true, estimatedAmount: undefined },
    ]);
  });

  it("marks provider-reported same-currency overage explicitly", async () => {
    const provider = new DeterministicAiProviderDispatcher({
      generate: async () => ({
        value: { text: "ok" },
        usage: { inputTokens: 2, outputTokens: 1 },
        providerCost: { amount: "1", currency: "USD" },
        metadata: { retryCount: 0 },
      }),
    });
    const test = harness(provider);
    await test.gateway.execute(request(), {
      workspaceId: "workspace-1",
      signal: new AbortController().signal,
    });
    expect(test.reconciliations).toMatchObject([
      { status: "providerOverage", actualAmount: "1" },
    ]);
  });

  it("retains foreign provider cost without spending it as budget currency", async () => {
    const provider = new DeterministicAiProviderDispatcher({
      generate: async () => ({
        value: { text: "ok" },
        usage: { inputTokens: 2, outputTokens: 1 },
        providerCost: { amount: "1", currency: "EUR" },
        metadata: { retryCount: 0 },
      }),
    });
    const test = harness(provider);

    await test.gateway.execute(request(), {
      workspaceId: "workspace-1",
      signal: new AbortController().signal,
    });

    expect(test.reconciliations).toMatchObject([
      {
        status: "retainedUncertain",
        currency: "USD",
        actualAmount: undefined,
        providerCost: { amount: "1", currency: "EUR" },
      },
    ]);
  });

  it("reserves a whole-run parent and records observable repository-agent turns", async () => {
    const provider = new DeterministicAiProviderDispatcher({
      runRepositoryAgent: async () => ({
        value: {
          summary: "The configured source handles the error.",
          metering: {
            mode: "observableTurns",
            turns: [
              { turn: 1, usage: { inputTokens: 3, outputTokens: 1 } },
              { turn: 2, usage: { inputTokens: 2, outputTokens: 2 } },
            ],
          },
        },
        metadata: { retryCount: 0 },
      }),
    });
    const test = harness(provider, repositoryAgentBinding());

    await expect(
      test.gateway.execute(
        {
          kind: "repositoryAgent",
          role: "repositoryAgent",
          request: {
            instruction: "Inspect only the configured pinned repository.",
            maximumTurns: 2,
            maximumInputTokensPerTurn: 10,
            maximumOutputTokensPerTurn: 5,
          },
          budget: { currency: "USD", hard: true },
        },
        {
          workspaceId: "workspace-1",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      operationId: "operation-1",
      usage: { inputTokens: 5, outputTokens: 3 },
      calculatedCost: { status: "known", amount: "0.011" },
    });

    expect(test.starts).toMatchObject([
      {
        operationId: "operation-1",
        operationKind: "repositoryAgent",
      },
      {
        operationId: "operation-2",
        parentOperationId: "operation-1",
        operationKind: "repositoryAgentTurn",
      },
      {
        operationId: "operation-3",
        parentOperationId: "operation-1",
        operationKind: "repositoryAgentTurn",
      },
    ]);
    expect(test.reservations).toMatchObject([
      { operationId: "operation-1", estimatedAmount: "0.04" },
    ]);
    expect(test.reservations).toHaveLength(1);
    expect(test.finalizations).toMatchObject([
      { operationId: "operation-2", status: "succeeded" },
      { operationId: "operation-3", status: "succeeded" },
      { operationId: "operation-1", status: "succeeded" },
    ]);
    expect(test.reconciliations).toMatchObject([
      {
        operationId: "operation-1",
        status: "reconciled",
        actualAmount: "0.011",
      },
    ]);
  });

  it("reconciles hidden repository-agent turns from aggregate usage", async () => {
    const provider = new DeterministicAiProviderDispatcher({
      runRepositoryAgent: async () => ({
        value: {
          summary: "The configured source handles the error.",
          metering: { mode: "aggregate" },
        },
        usage: { inputTokens: 4, outputTokens: 2 },
        metadata: { retryCount: 0 },
      }),
    });
    const test = harness(provider, repositoryAgentBinding());

    await test.gateway.execute(
      {
        kind: "repositoryAgent",
        role: "repositoryAgent",
        request: {
          instruction: "Inspect only the configured pinned repository.",
          maximumTurns: 2,
          maximumInputTokensPerTurn: 10,
          maximumOutputTokensPerTurn: 5,
        },
        budget: { currency: "USD", hard: true },
      },
      {
        workspaceId: "workspace-1",
        signal: new AbortController().signal,
      },
    );

    expect(test.starts).toHaveLength(1);
    expect(test.finalizations).toMatchObject([
      {
        operationId: "operation-1",
        status: "succeeded",
        metadata: {
          rawRedacted: {
            repositoryAgentMetering: "aggregate",
            observableTurnCount: 0,
          },
        },
      },
    ]);
    expect(test.reconciliations).toMatchObject([
      {
        operationId: "operation-1",
        status: "reconciled",
        actualAmount: "0.008",
      },
    ]);
  });

  it("rejects hard-budget repository-agent execution without safe token bounds", async () => {
    const provider = new DeterministicAiProviderDispatcher({
      runRepositoryAgent: async () => {
        throw new Error("must not run");
      },
    });
    const test = harness(provider, repositoryAgentBinding());

    await expect(
      test.gateway.execute(
        {
          kind: "repositoryAgent",
          role: "repositoryAgent",
          request: {
            instruction: "Inspect.",
            maximumTurns: 2,
          } as never,
          budget: { currency: "USD", hard: true },
        },
        {
          workspaceId: "workspace-1",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toBeInstanceOf(AiHardBudgetError);
    expect(provider.calls).toHaveLength(0);
    expect(test.starts).toHaveLength(0);
  });
});
