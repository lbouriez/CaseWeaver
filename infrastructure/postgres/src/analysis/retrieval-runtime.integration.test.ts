import type { AnalysisExecution } from "@caseweaver/analysis";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { PostgresAnalysisEvidenceAdapterError } from "./evidence-adapters.js";
import { PostgresAnalysisRetrievalRuntimeResolver } from "./retrieval-runtime.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "PostgreSQL retrieval runtime tests require a disposable DATABASE_URL ending in a test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const resolver = new PostgresAnalysisRetrievalRuntimeResolver(client);

function execution(workspaceId: string): AnalysisExecution {
  return {
    workspaceId,
    analysisJobId: "analysis-job-a",
    analysisIdentityId: "analysis-identity-a",
    analysisAttemptId: "analysis-attempt-a",
    snapshot: {
      id: "snapshot-a",
      revision: "revision-a",
      capturedAt: "2026-07-15T00:00:00.000Z",
      title: "Case",
      summary: "Summary",
      contentHash: "a".repeat(64),
      messages: [],
    },
    profile: {
      id: "analysis-profile-a",
      version: "analysis-version-a",
      analysisBindingVersionId: "analysis-binding-a",
      prompt: {
        template: {
          id: "prompt-a",
          version: "1",
          systemInstruction: "Analyze.",
        },
        schemaVersion: "case-analysis.v1",
        budgets: {
          case: { maximumCharacters: 100, maximumTokens: 100 },
          attachments: { maximumCharacters: 100, maximumTokens: 100 },
          knowledge: { maximumCharacters: 100, maximumTokens: 100 },
          repository: { maximumCharacters: 100, maximumTokens: 100 },
        },
      },
      retrieval: {
        policy: "required",
        profileId: "retrieval-profile-a",
        profileVersion: "retrieval-version-old",
        collectionIds: ["collection-a"],
        maximumQueryCharacters: 100,
      },
      attachments: { policy: "disabled" },
      repository: {
        policy: "disabled",
        maximumContextCharacters: 100,
        maximumEvidenceCharacters: 100,
      },
      generation: {
        maximumInputTokens: 100,
        maximumOutputTokens: 100,
        budget: { currency: "USD", hard: true },
      },
      repair: { maximumAttempts: 0, maximumInputCharacters: 100 },
    },
  };
}

function settings(sourceId: string, contextTokenBindingVersionId: string) {
  return {
    collections: [
      {
        id: "collection-a",
        embeddingBindingVersionId: "embedding-binding-a",
        embeddingProfileVersion: "embedding-profile-a",
        dimensions: 3,
      },
    ],
    policy: {
      rankConstant: 10,
      lexicalWeight: 1,
      vectorWeight: 1,
      maximumFinalResults: 5,
      maximumCharacters: 500,
      maximumTokens: 100,
      defaultSourceQuota: {
        maximumCandidates: 5,
        maximumFinalResults: 5,
      },
      sourceQuotas: [],
    },
    queryEmbedding: {
      maximumInputTokens: 20,
      budget: { currency: "USD", hard: true },
    },
    contextTokenBindingVersionId,
    authorizedSourceIds: [sourceId],
  };
}

async function resetDatabase(): Promise<void> {
  await pool.query("TRUNCATE TABLE workspaces RESTART IDENTITY CASCADE");
}

async function seed(): Promise<void> {
  await pool.query(
    "INSERT INTO workspaces (id) VALUES ('workspace-a'), ('workspace-b')",
  );
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, revision
     ) VALUES (
       'retrieval-profile-a', 'workspace-a', 'retrieval-profiles', 'active', 2
     )`,
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references
     ) VALUES
       ('retrieval-version-old', 'workspace-a', 'retrieval-profile-a', 1, $1::jsonb, '[]'::jsonb),
       ('retrieval-version-current', 'workspace-a', 'retrieval-profile-a', 2, $2::jsonb, '[]'::jsonb)`,
    [
      JSON.stringify(settings("source-old", "analysis-binding-old")),
      JSON.stringify(settings("source-current", "analysis-binding-current")),
    ],
  );
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = 'retrieval-version-current'
     WHERE workspace_id = 'workspace-a' AND id = 'retrieval-profile-a'`,
  );
}

beforeEach(async () => {
  await resetDatabase();
  await seed();
});

afterAll(async () => {
  await client.$disconnect();
  await pool.end();
});

describe("PostgresAnalysisRetrievalRuntimeResolver", () => {
  it("uses the exact old configuration version after the aggregate has rotated", async () => {
    await expect(
      resolver.resolve({
        execution: execution("workspace-a"),
        profileId: "retrieval-profile-a",
        profileVersion: "retrieval-version-old",
        collectionIds: ["collection-a"],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      profile: {
        id: "retrieval-profile-a",
        version: "retrieval-version-old",
        contextTokenBindingVersionId: "analysis-binding-old",
      },
      access: { authorizedSourceIds: ["source-old"] },
    });
  });

  it("fails closed for a cross-workspace execution and disabled aggregate", async () => {
    await expect(
      resolver.resolve({
        execution: execution("workspace-b"),
        profileId: "retrieval-profile-a",
        profileVersion: "retrieval-version-old",
        collectionIds: ["collection-a"],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject<PostgresAnalysisEvidenceAdapterError>({
      code: "analysis.retrievalRuntimeUnavailable",
      retryable: false,
    });

    await pool.query(
      `UPDATE administration_configurations
       SET lifecycle = 'disabled'
       WHERE workspace_id = 'workspace-a' AND id = 'retrieval-profile-a'`,
    );
    await expect(
      resolver.resolve({
        execution: execution("workspace-a"),
        profileId: "retrieval-profile-a",
        profileVersion: "retrieval-version-old",
        collectionIds: ["collection-a"],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject<PostgresAnalysisEvidenceAdapterError>({
      code: "analysis.retrievalRuntimeUnavailable",
      retryable: false,
    });
  });
});
