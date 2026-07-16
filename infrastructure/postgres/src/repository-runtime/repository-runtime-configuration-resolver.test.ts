import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  PostgresRepositoryRuntimeConfigurationError,
  PostgresRepositoryRuntimeConfigurationResolver,
} from "./repository-runtime-configuration-resolver.js";

const pin = Object.freeze({
  workspaceId: "workspace-a",
  runtimeVersionId: "repository-runtime-old",
  repositoryId: "support-service",
  pinnedCommit: "a".repeat(40),
});

function settings(overrides: Record<string, unknown> = {}) {
  return {
    repositoryId: "support-service",
    pinnedCommit: "a".repeat(40),
    bindingVersionId: "repository-agent-binding-a",
    allowedTools: ["listFiles", "readFile"],
    sandbox: {
      timeoutMs: 120_000,
      maximumCpuMilliseconds: 120_000,
      maximumMemoryBytes: 512 * 1024 * 1024,
      maximumOutputBytes: 1_048_576,
      maximumToolCalls: 30,
    },
    agent: {
      maximumTurns: 8,
      maximumInputTokensPerTurn: 4_096,
      maximumOutputTokensPerTurn: 1_024,
      maximumInstructionCharacters: 64_000,
      budget: { currency: "USD", hard: true },
    },
    ...overrides,
  };
}

function clientFor(input: {
  readonly resourceType?: string;
  readonly lifecycle?: string;
  readonly settings?: object;
  readonly secretReferences?: readonly unknown[];
  readonly credential?: boolean;
}) {
  const calls: unknown[] = [];
  const database = {
    administrationConfigurationVersion: {
      async findUnique(query: unknown) {
        calls.push(query);
        return {
          id: "repository-runtime-old",
          workspaceId: "workspace-a",
          settings: input.settings ?? settings(),
          secretReferences: input.secretReferences ?? ["vault:checkout/a"],
          configuration: {
            resourceType: input.resourceType ?? "repository-runtimes",
            lifecycle: input.lifecycle ?? "active",
          },
        };
      },
    },
    credentialRegistration: {
      async findFirst(query: unknown) {
        calls.push(query);
        return input.credential === false ? null : { id: "credential-a" };
      },
    },
  };
  const client = {
    $transaction: async (operation: (value: typeof database) => unknown) =>
      operation(database),
  } as unknown as PrismaClient;
  return { client, calls };
}

describe("PostgresRepositoryRuntimeConfigurationResolver", () => {
  it("reads the exact retained version and never follows a mutable current version", async () => {
    const fake = clientFor({});
    const resolver = new PostgresRepositoryRuntimeConfigurationResolver(
      fake.client,
    );

    await expect(
      resolver.resolve(pin, new AbortController().signal),
    ).resolves.toMatchObject({
      runtimeVersionId: "repository-runtime-old",
      repository: {
        repositoryId: "support-service",
        pinnedCommit: "a".repeat(40),
        checkoutSecretReference: "vault:checkout/a",
      },
      execution: {
        bindingVersionId: "repository-agent-binding-a",
        budget: { currency: "USD", hard: true },
      },
    });
    expect(fake.calls[0]).toMatchObject({
      where: {
        workspaceId_id: {
          workspaceId: "workspace-a",
          id: "repository-runtime-old",
        },
      },
    });
    expect(JSON.stringify(fake.calls[0])).not.toContain("currentVersionId");
    await expect(
      resolver.resolveExecution(pin, new AbortController().signal),
    ).resolves.toMatchObject({
      repositoryId: "support-service",
      pinnedCommit: "a".repeat(40),
    });
    await resolver
      .resolveExecution(pin, new AbortController().signal)
      .then((projection) =>
        expect(JSON.stringify(projection)).not.toContain("vault:checkout/a"),
      );
  });

  it("fails closed for disabled, mismatched, malformed, revoked, or unknown-pricing runtime state", async () => {
    const attempts = [
      new PostgresRepositoryRuntimeConfigurationResolver(
        clientFor({ lifecycle: "disabled" }).client,
      ),
      new PostgresRepositoryRuntimeConfigurationResolver(
        clientFor({ settings: settings({ repositoryId: "other-service" }) })
          .client,
      ),
      new PostgresRepositoryRuntimeConfigurationResolver(
        clientFor({ secretReferences: [] }).client,
      ),
      new PostgresRepositoryRuntimeConfigurationResolver(
        clientFor({ credential: false }).client,
      ),
      new PostgresRepositoryRuntimeConfigurationResolver(
        clientFor({
          settings: settings({
            agent: {
              maximumTurns: 1,
              maximumInputTokensPerTurn: 1,
              maximumOutputTokensPerTurn: 1,
              maximumInstructionCharacters: 1,
              budget: {
                currency: "USD",
                hard: true,
                allowUnknownPricing: true,
              },
            },
          }),
        }).client,
      ),
    ];

    for (const resolver of attempts) {
      const attempt = resolver.resolve(pin, new AbortController().signal);
      await expect(attempt).rejects.toBeInstanceOf(
        PostgresRepositoryRuntimeConfigurationError,
      );
      await attempt.catch((error: unknown) => {
        expect(error).toMatchObject({
          code: "analysis.repositoryRuntimeUnavailable",
          retryable: false,
          message: "The immutable repository runtime is unavailable.",
        });
        expect(String(error)).not.toContain("vault:checkout/a");
      });
    }
  });
});
