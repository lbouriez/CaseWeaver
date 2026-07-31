import { createHash } from "node:crypto";

import type { AiConfigurationAuditRecord } from "@caseweaver/administration";
import {
  AdministrationConflictError,
  AdministrationNotFoundError,
} from "@caseweaver/administration";
import {
  createImmutableBinding,
  importLiteLlmCatalog,
} from "@caseweaver/ai-config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresAiBindingDraftStore } from "./ai-binding-draft-store.js";
import { PostgresAiConfigurationStore } from "./ai-configuration-store.js";
import { PostgresProviderModelInventoryStore } from "./provider-model-inventory-store.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "AI configuration store integration tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const timestamp = "2026-07-15T12:00:00.000Z";
const digest = (character: string) => character.repeat(64);

function client(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
}

function mutation(character: string) {
  return Object.freeze({
    keyDigest: digest(character),
    requestDigest: digest(character.toUpperCase()),
  });
}

function audit(
  action: AiConfigurationAuditRecord["action"],
  targetType: string,
  targetId: string,
  keyDigest: string,
): AiConfigurationAuditRecord {
  return Object.freeze({
    workspaceId: "ai-workspace-a",
    actorPrincipalId: "ai-principal-a",
    action,
    targetType,
    targetId,
    permission: "configuration.manage",
    outcome: "succeeded",
    occurredAt: timestamp,
    origin: "admin_ui",
    idempotencyKeyDigest: keyDigest,
    afterHash: digest("f"),
    requestId: "request-a",
    correlationId: "correlation-a",
  });
}

function catalog() {
  const raw = new TextEncoder().encode(
    JSON.stringify({
      "test-provider/model-a": {
        litellm_provider: "test-provider",
        mode: "chat",
        max_input_tokens: 100,
        max_output_tokens: 50,
        input_cost_per_token: 0.001,
        output_cost_per_token: 0.002,
      },
    }),
  );
  return importLiteLlmCatalog({
    snapshotId: "ai-catalog-a",
    rawBytes: raw,
    upstreamUrl: "https://catalog.example.test/model_prices.json",
    upstreamCommitSha: "deadbeef",
    fetchedAt: timestamp,
    verifiedSha256: createHash("sha256").update(raw).digest("hex"),
  });
}

async function seedBase(database: PrismaClient): Promise<void> {
  await database.workspace.create({ data: { id: "ai-workspace-a" } });
  await database.principal.create({
    data: { id: "ai-principal-a", workspaceId: "ai-workspace-a" },
  });
  await database.aiProviderInstance.create({
    data: {
      id: "provider-a",
      workspaceId: "ai-workspace-a",
      providerType: "test-provider",
      lifecycle: "active",
    },
  });
  await database.aiProviderInstanceVersion.create({
    data: {
      id: "provider-a:1",
      workspaceId: "ai-workspace-a",
      providerInstanceId: "provider-a",
      version: 1,
      endpoint: "https://provider.example.test",
      wireApi: "chatCompletions",
      parameters: {},
      secretReference: "secret-ref-a",
    },
  });
}

function binding(
  snapshot: ReturnType<typeof catalog>,
  inventorySnapshotId: string,
  version = 1,
) {
  const model = snapshot.models[0];
  if (model === undefined)
    throw new Error("Catalog fixture did not contain its model.");
  return createImmutableBinding({
    workspaceId: "ai-workspace-a",
    bindingId: "binding-a",
    version,
    role: "analysis",
    providerInstanceVersionId: "provider-a:1",
    providerType: "test-provider",
    endpoint: "https://provider.example.test",
    canonicalModel: "test-provider/model-a",
    wireApi: "chatCompletions",
    secretReference: "secret-ref-a",
    catalogModel: { ...model, snapshotId: inventorySnapshotId },
    maximumInputTokens: 100,
    maximumOutputTokens: 50,
  });
}

async function refreshProviderInventory(
  database: PrismaClient,
  mutationCharacter: string,
): Promise<string> {
  const inventoryStore = new PostgresProviderModelInventoryStore(database);
  const storedMutation = mutation(mutationCharacter);
  const recorded = await inventoryStore.refreshAndRecord({
    workspaceId: "ai-workspace-a",
    providerInstanceId: "provider-a",
    providerInstanceVersionId: "provider-a:1",
    providerType: "test-provider",
    wireApi: "chatCompletions",
    models: [
      {
        canonicalModel: "test-provider/model-a",
        supportedRoles: ["analysis", "chat", "keywordExtraction"],
        capabilities: [],
        maximumInputTokens: 100,
        maximumOutputTokens: 50,
      },
    ],
    mutation: storedMutation,
    audit: audit(
      "admin.aiProviderModelInventory.refresh",
      "ai-provider-instance",
      "provider-a",
      storedMutation.keyDigest,
    ),
  });
  const inventory = await database.aiProviderModelInventorySnapshot.findUnique({
    where: {
      workspaceId_id: {
        workspaceId: "ai-workspace-a",
        id: recorded.summary.id,
      },
    },
    select: { catalogSnapshotId: true },
  });
  if (inventory === null)
    throw new Error("Provider inventory was not recorded.");
  return inventory.catalogSnapshotId;
}

beforeEach(async () => {
  await pool.query(
    "TRUNCATE TABLE ai_catalog_snapshots, workspaces RESTART IDENTITY CASCADE",
  );
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL AI configuration authoring", () => {
  it("returns a bounded server-side catalog filter rather than relying on a first model page", async () => {
    const database = client();
    try {
      const configuration = new PostgresAiConfigurationStore(database);
      const bindings = new PostgresAiBindingDraftStore(database);
      await seedBase(database);
      const imported = catalog();
      const catalogMutation = mutation("0");
      await configuration.importCatalogAndRecord({
        workspaceId: "ai-workspace-a",
        catalog: imported,
        mutation: catalogMutation,
        audit: audit(
          "admin.aiCatalog.import",
          "ai-catalog-snapshot",
          imported.id,
          catalogMutation.keyDigest,
        ),
      });
      await expect(
        bindings.listOptions({
          workspaceId: "ai-workspace-a",
          providerInstanceId: "provider-a",
          role: "analysis",
        }),
      ).resolves.toMatchObject({ models: [] });
      const unverifiedBindingMutation = mutation("y");
      await expect(
        configuration.createBindingDraftAndRecord({
          binding: binding(imported, imported.id),
          mutation: unverifiedBindingMutation,
          audit: audit(
            "admin.aiBinding.draft.create",
            "ai-model-binding",
            "binding-a",
            unverifiedBindingMutation.keyDigest,
          ),
        }),
      ).rejects.toBeInstanceOf(AdministrationNotFoundError);
      const inventorySnapshotId = await refreshProviderInventory(database, "z");

      await expect(
        bindings.listOptions({
          workspaceId: "ai-workspace-a",
          providerInstanceId: "provider-a",
          role: "analysis",
          search: "MODEL-A",
        }),
      ).resolves.toMatchObject({
        wireApi: "chatCompletions",
        models: [
          {
            catalogSnapshotId: inventorySnapshotId,
            canonicalModel: "test-provider/model-a",
          },
        ],
      });
      await expect(
        bindings.listOptions({
          workspaceId: "ai-workspace-a",
          providerInstanceId: "provider-a",
          role: "analysis",
          search: "absent-model",
        }),
      ).resolves.toMatchObject({ models: [] });
    } finally {
      await database.$disconnect();
    }
  });

  it("records a same-content trusted refresh without duplicate models, prices, or cache invalidation", async () => {
    const database = client();
    try {
      const store = new PostgresAiConfigurationStore(database);
      await seedBase(database);
      const imported = catalog();
      const firstMutation = mutation("1");
      const secondMutation = mutation("2");

      await store.importCatalogAndRecord({
        workspaceId: "ai-workspace-a",
        catalog: imported,
        mutation: firstMutation,
        audit: audit(
          "admin.aiCatalog.import",
          "ai-catalog-snapshot",
          imported.id,
          firstMutation.keyDigest,
        ),
      });
      const refreshed = await store.importCatalogAndRecord({
        workspaceId: "ai-workspace-a",
        catalog: imported,
        mutation: secondMutation,
        audit: audit(
          "admin.aiCatalog.import",
          "ai-catalog-snapshot",
          imported.id,
          secondMutation.keyDigest,
        ),
      });

      expect(refreshed).toMatchObject({
        idempotency: "created",
        summary: { id: imported.id, modelCount: 1 },
      });
      await expect(
        Promise.all([
          database.aiCatalogSnapshot.count(),
          database.aiCatalogModel.count(),
          database.aiCatalogPriceComponent.count(),
          database.administrationAiConfigurationChangeOutbox.count(),
          database.auditEvent.count({
            where: { action: "admin.aiCatalog.import" },
          }),
        ]),
      ).resolves.toEqual([1, 1, 2, 1, 2]);
    } finally {
      await database.$disconnect();
    }
  });

  it("commits a pinned catalog, immutable binding draft, idempotency result, audit, and cache invalidation atomically", async () => {
    const database = client();
    try {
      const store = new PostgresAiConfigurationStore(
        database,
        (() => {
          let value = 0;
          return () => `generated-${++value}`;
        })(),
      );
      await seedBase(database);
      const imported = catalog();
      const catalogMutation = mutation("a");
      await store.importCatalogAndRecord({
        workspaceId: "ai-workspace-a",
        catalog: imported,
        mutation: catalogMutation,
        audit: audit(
          "admin.aiCatalog.import",
          "ai-catalog-snapshot",
          imported.id,
          catalogMutation.keyDigest,
        ),
      });
      const inventorySnapshotId = await refreshProviderInventory(database, "k");
      const draftMutation = mutation("b");
      const created = await store.createBindingDraftAndRecord({
        binding: binding(imported, inventorySnapshotId),
        mutation: draftMutation,
        audit: audit(
          "admin.aiBinding.draft.create",
          "ai-model-binding",
          "binding-a",
          draftMutation.keyDigest,
        ),
      });
      expect(created).toMatchObject({
        idempotency: "created",
        summary: {
          bindingVersionId: "binding-a:1",
          revision: 1,
          lifecycle: "draft",
        },
      });
      await expect(
        store.createBindingDraftAndRecord({
          binding: binding(imported, inventorySnapshotId),
          mutation: draftMutation,
          audit: audit(
            "admin.aiBinding.draft.create",
            "ai-model-binding",
            "binding-a",
            draftMutation.keyDigest,
          ),
        }),
      ).resolves.toMatchObject({ idempotency: "replayed" });

      await expect(
        database.auditEvent.findMany({
          where: { workspaceId: "ai-workspace-a" },
          select: {
            action: true,
            actorPrincipalId: true,
            idempotencyKeyDigest: true,
          },
        }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "admin.aiBinding.draft.create",
            actorPrincipalId: "ai-principal-a",
            idempotencyKeyDigest: draftMutation.keyDigest,
          }),
        ]),
      );
      await expect(
        database.administrationAiConfigurationChangeOutbox.findMany({
          where: { workspaceId: "ai-workspace-a" },
          select: {
            aggregateId: true,
            currentVersionId: true,
            resourceType: true,
          },
          orderBy: { aggregateId: "asc" },
        }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            aggregateId: "ai-catalog-a",
            currentVersionId: "ai-catalog-a",
            resourceType: "ai-catalog-snapshots",
          }),
          expect.objectContaining({
            aggregateId: "binding-a",
            currentVersionId: "binding-a:1:r1",
            resourceType: "ai-bindings",
          }),
        ]),
      );
    } finally {
      await database.$disconnect();
    }
  });

  it("locks binding lifecycle changes and prevents a stale concurrent revision from committing", async () => {
    const database = client();
    try {
      const store = new PostgresAiConfigurationStore(database);
      await seedBase(database);
      const imported = catalog();
      const catalogMutation = mutation("c");
      await store.importCatalogAndRecord({
        workspaceId: "ai-workspace-a",
        catalog: imported,
        mutation: catalogMutation,
        audit: audit(
          "admin.aiCatalog.import",
          "ai-catalog-snapshot",
          imported.id,
          catalogMutation.keyDigest,
        ),
      });
      const inventorySnapshotId = await refreshProviderInventory(database, "l");
      const draftMutation = mutation("d");
      await store.createBindingDraftAndRecord({
        binding: binding(imported, inventorySnapshotId),
        mutation: draftMutation,
        audit: audit(
          "admin.aiBinding.draft.create",
          "ai-model-binding",
          "binding-a",
          draftMutation.keyDigest,
        ),
      });
      const activateMutation = mutation("e");
      await store.transitionBindingAndRecord({
        workspaceId: "ai-workspace-a",
        bindingId: "binding-a",
        expectedRevision: 1,
        lifecycle: "active",
        mutation: activateMutation,
        audit: audit(
          "admin.aiBinding.activate",
          "ai-model-binding",
          "binding-a",
          activateMutation.keyDigest,
        ),
      });
      const firstDefaultMutation = mutation("default-one");
      await store.setRoleDefaultAndRecord({
        workspaceId: "ai-workspace-a",
        role: "analysis",
        bindingVersionId: "binding-a:1",
        expectedRevision: 0,
        mutation: firstDefaultMutation,
        audit: audit(
          "admin.aiRoleDefault.set",
          "ai-workspace-role-default",
          "analysis",
          firstDefaultMutation.keyDigest,
        ),
      });
      const versionDraftMutation = mutation("f");
      const secondVersion = binding(imported, inventorySnapshotId, 2);
      await store.createBindingVersionDraftAndRecord({
        binding: secondVersion,
        expectedRevision: 2,
        mutation: versionDraftMutation,
        audit: audit(
          "admin.aiBinding.version.draft.create",
          "ai-model-binding",
          "binding-a",
          versionDraftMutation.keyDigest,
        ),
      });
      await expect(
        database.aiModelBinding.findUnique({
          where: {
            workspaceId_id: { workspaceId: "ai-workspace-a", id: "binding-a" },
          },
          select: {
            lifecycle: true,
            revision: true,
            activeVersionId: true,
            draftVersionId: true,
          },
        }),
      ).resolves.toEqual({
        lifecycle: "active",
        revision: 3,
        activeVersionId: "binding-a:1",
        draftVersionId: "binding-a:2",
      });
      const promoteMutation = mutation("g");
      await store.transitionBindingAndRecord({
        workspaceId: "ai-workspace-a",
        bindingId: "binding-a",
        expectedRevision: 3,
        lifecycle: "active",
        mutation: promoteMutation,
        audit: audit(
          "admin.aiBinding.activate",
          "ai-model-binding",
          "binding-a",
          promoteMutation.keyDigest,
        ),
      });
      const budgetMutation = mutation("i");
      await store.replaceBudgetPolicyAndRecord({
        workspaceId: "ai-workspace-a",
        policy: {
          id: "budget-a",
          scope: "workspace",
          scopeKey: "all",
          limitAmount: "10",
          currency: "USD",
          hard: true,
        },
        expectedRevision: 0,
        mutation: budgetMutation,
        audit: audit(
          "admin.aiBudgetPolicy.replace",
          "ai-budget-policy",
          "workspace:all",
          budgetMutation.keyDigest,
        ),
      });
      await expect(
        database.aiWorkspaceBindingDefault.findUnique({
          where: {
            workspaceId_role: {
              workspaceId: "ai-workspace-a",
              role: "analysis",
            },
          },
          select: { modelBindingVersionId: true, revision: true },
        }),
      ).resolves.toEqual({ modelBindingVersionId: "binding-a:2", revision: 2 });
      await expect(
        database.aiBudgetPolicy.findUnique({
          where: {
            workspaceId_id: { workspaceId: "ai-workspace-a", id: "budget-a" },
          },
          select: { active: true, revision: true, supersedesPolicyId: true },
        }),
      ).resolves.toEqual({
        active: true,
        revision: 1,
        supersedesPolicyId: null,
      });
      const staleMutation = mutation("j");
      await expect(
        store.transitionBindingAndRecord({
          workspaceId: "ai-workspace-a",
          bindingId: "binding-a",
          expectedRevision: 4,
          lifecycle: "disabled",
          mutation: staleMutation,
          audit: audit(
            "admin.aiBinding.disable",
            "ai-model-binding",
            "binding-a",
            staleMutation.keyDigest,
          ),
        }),
      ).rejects.toBeInstanceOf(AdministrationConflictError);
      await expect(
        database.aiModelBinding.findUnique({
          where: {
            workspaceId_id: { workspaceId: "ai-workspace-a", id: "binding-a" },
          },
          select: { lifecycle: true },
        }),
      ).resolves.toEqual({ lifecycle: "active" });
      await expect(
        database.auditEvent.count({
          where: { action: "admin.aiBinding.disable" },
        }),
      ).resolves.toBe(0);
    } finally {
      await database.$disconnect();
    }
  });
});
