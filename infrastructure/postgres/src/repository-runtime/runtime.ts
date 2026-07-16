import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import {
  PostgresRepositoryRuntimeConfigurationResolver,
  type RepositoryRuntimeConfigurationResolver,
  type RepositoryRuntimeExecutionConfigurationResolver,
} from "./repository-runtime-configuration-resolver.js";

/**
 * Narrow lifecycle owner for immutable repository-runtime configuration. The
 * worker receives a resolver only; it cannot use this client for mutable
 * administration queries or public read models.
 */
export interface PostgresRepositoryRuntime {
  /** Broker/provider-only projection, including the opaque checkout locator. */
  readonly resolver: RepositoryRuntimeConfigurationResolver;
  /** Analysis execution projection; it contains no checkout locator. */
  readonly executionResolver: RepositoryRuntimeExecutionConfigurationResolver;
  close(): Promise<void>;
}

export function createPostgresRepositoryRuntime(input: {
  readonly databaseUrl: string;
}): PostgresRepositoryRuntime {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: input.databaseUrl }),
  });
  const resolver = new PostgresRepositoryRuntimeConfigurationResolver(client);
  return Object.freeze({
    resolver,
    executionResolver: resolver,
    close: async () => client.$disconnect(),
  });
}
