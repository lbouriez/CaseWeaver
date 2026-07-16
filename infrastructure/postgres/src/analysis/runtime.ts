import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import {
  PostgresSnapshotAttachmentReferenceStore,
  type AnalysisRetrievalRuntimeResolver,
} from "./evidence-adapters.js";
import { PostgresAnalysisRetrievalRuntimeResolver } from "./retrieval-runtime.js";

/**
 * Owns the Prisma client required by the narrow immutable-analysis evidence
 * readers. It intentionally exposes only feature ports, never Prisma, so a
 * worker host cannot accidentally turn this into a mutable administration
 * lookup.
 */
export interface PostgresAnalysisEvidenceRuntime {
  readonly attachmentReferences: PostgresSnapshotAttachmentReferenceStore;
  readonly retrievalRuntime: AnalysisRetrievalRuntimeResolver;
  close(): Promise<void>;
}

export function createPostgresAnalysisEvidenceRuntime(input: {
  readonly databaseUrl: string;
}): PostgresAnalysisEvidenceRuntime {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: input.databaseUrl }),
  });
  return Object.freeze({
    attachmentReferences: new PostgresSnapshotAttachmentReferenceStore(client),
    retrievalRuntime: new PostgresAnalysisRetrievalRuntimeResolver(client),
    close: async () => client.$disconnect(),
  });
}
