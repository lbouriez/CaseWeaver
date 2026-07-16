import type { AnalysisProductionDependencies } from "./production-factory.js";
import { createProductionAnalysisExecutionService } from "./production-factory.js";
import { describe, expect, it } from "vitest";

function dependencies(): AnalysisProductionDependencies {
  return {
    store: {
      async claim() {
        return { kind: "notFound" } as const;
      },
      async complete() {
        throw new Error("not reached");
      },
      async fail() {
        throw new Error("not reached");
      },
    },
    attachments: {
      async resolve() {
        throw new Error("not reached");
      },
    },
    retrieval: {
      async retrieve() {
        throw new Error("not reached");
      },
    },
    prompts: {
      async resolve() {
        throw new Error("not reached");
      },
    },
    ai: {
      async execute() {
        throw new Error("not reached");
      },
    },
    ids: {
      next() {
        return "unused";
      },
    },
    clock: {
      now() {
        return "2026-07-15T00:00:00.000Z";
      },
    },
    repository: {
      async investigate() {
        throw new Error("not reached");
      },
    },
  };
}

describe("createProductionAnalysisExecutionService", () => {
  it("constructs the feature service only from caller-supplied ports", async () => {
    const service = createProductionAnalysisExecutionService(dependencies());

    await expect(
      service.execute(
        {} as Parameters<typeof service.execute>[0],
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "notFound" });
  });
});
