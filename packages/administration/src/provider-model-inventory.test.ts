import { describe, expect, it, vi } from "vitest";

import {
  type ProviderModelInventoryStore,
  RefreshProviderModelInventory,
} from "./provider-model-inventory.js";

const mutation = {
  keyDigest: "a".repeat(64),
  requestDigest: "b".repeat(64),
};
const context = {
  workspaceId: "workspace-1",
  actorPrincipalId: "principal-1",
  occurredAt: "2026-07-17T00:00:00.000Z",
  origin: "admin_ui" as const,
};

describe("RefreshProviderModelInventory", () => {
  it("normalizes provider metadata before the atomic persistence boundary and never carries a credential", async () => {
    const refreshAndRecord = vi.fn<
      ProviderModelInventoryStore["refreshAndRecord"]
    >(async (input) => ({
      summary: {
        id: "provider-model-inventory-1",
        providerInstanceId: input.providerInstanceId,
        providerInstanceVersionId: input.providerInstanceVersionId,
        discoveredAt: context.occurredAt,
        modelCount: input.models.length,
        pricedModelCount: 0,
      },
      idempotency: "created" as const,
    }));
    const useCase = new RefreshProviderModelInventory({
      refreshAndRecord,
    } satisfies ProviderModelInventoryStore);

    await useCase.execute(
      {
        providerInstanceId: "provider-1",
        providerInstanceVersionId: "provider-version-1",
        providerType: "openai-compatible",
        wireApi: "chatCompletions",
        models: [
          {
            canonicalModel: "openai/gpt-4o",
            supportedRoles: ["chat", "analysis", "chat"],
            capabilities: ["tools", "tools"],
          },
        ],
        mutation,
      },
      context,
    );

    expect(refreshAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        models: [
          {
            canonicalModel: "openai/gpt-4o",
            supportedRoles: ["analysis", "chat"],
            capabilities: ["tools"],
          },
        ],
        audit: expect.objectContaining({
          action: "admin.aiProviderModelInventory.refresh",
          targetId: "provider-1",
          permission: "configuration.manage",
        }),
      }),
    );
    expect(JSON.stringify(refreshAndRecord.mock.calls)).not.toMatch(
      /secret|endpoint|locator/iu,
    );
  });
});
