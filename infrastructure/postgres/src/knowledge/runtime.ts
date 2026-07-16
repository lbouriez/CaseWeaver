import { Pool } from "pg";

import { PostgresKnowledgeIngestionStore } from "./index.js";
import {
  PostgresKnowledgeSourceExecutionStore,
  PostgresPinnedKnowledgeSourceConfigurationResolver,
} from "./runtime-execution.js";

/**
 * Owns the raw PostgreSQL pool used by the fenced knowledge runtime. Prisma
 * remains responsible for control-plane transactions; this pool is dedicated
 * to ingestion's bulk/vector and lease operations and is closed with its host.
 */
export interface PostgresKnowledgeRuntime {
  readonly sourceConfigurations: PostgresPinnedKnowledgeSourceConfigurationResolver;
  readonly executions: PostgresKnowledgeSourceExecutionStore;
  readonly ingestion: PostgresKnowledgeIngestionStore;
  close(): Promise<void>;
}

export function createPostgresKnowledgeRuntime(
  input: Readonly<{ readonly databaseUrl: string }>,
): PostgresKnowledgeRuntime {
  const pool = new Pool({ connectionString: input.databaseUrl });
  return Object.freeze({
    sourceConfigurations:
      new PostgresPinnedKnowledgeSourceConfigurationResolver(pool),
    executions: new PostgresKnowledgeSourceExecutionStore(pool),
    ingestion: new PostgresKnowledgeIngestionStore(pool),
    close: async () => pool.end(),
  });
}
