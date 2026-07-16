import { describe, expect, it } from "vitest";

import {
  loadWorkerRuntimeConfiguration,
  WorkerConfigurationError,
} from "./production-bootstrap.js";

describe("worker production configuration", () => {
  it("requires a database URL and rejects unsafe operational bounds", () => {
    expect(() => loadWorkerRuntimeConfiguration({})).toThrow(
      WorkerConfigurationError,
    );
    expect(() =>
      loadWorkerRuntimeConfiguration({
        DATABASE_URL: "postgresql://caseweaver:caseweaver@localhost/test",
        WORKER_TEAM_SIZE: "0",
      }),
    ).toThrow(WorkerConfigurationError);
  });

  it("uses bounded defaults without returning deployment secret values", () => {
    const configuration = loadWorkerRuntimeConfiguration({
      DATABASE_URL: "postgresql://caseweaver:caseweaver@localhost/test",
      WORKER_TEAM_SIZE: "2",
      WORKER_GIT_TEMPORARY_DIRECTORY: "/var/lib/caseweaver/git-temp",
      OBJECT_STORAGE_KEY_DERIVATION_SECRET: "do-not-serialize-this-secret",
    });

    expect(configuration).toMatchObject({
      databaseUrl: "postgresql://caseweaver:caseweaver@localhost/test",
      workerTeamSize: 2,
      relayBatchSize: 25,
      gitTemporaryDirectory: "/var/lib/caseweaver/git-temp",
    });
    expect(JSON.stringify(configuration)).not.toContain(
      "do-not-serialize-this-secret",
    );
  });

  it("accepts only an explicit immutable local repository-agent host mapping", () => {
    expect(
      loadWorkerRuntimeConfiguration({
        DATABASE_URL: "postgresql://caseweaver:caseweaver@localhost/test",
        WORKER_REPOSITORY_AGENT_SOURCES_JSON:
          '[{"repositoryId":"support-service","directory":"/srv/repositories/support-service"}]',
        WORKER_REPOSITORY_AGENT_SANDBOX_IMAGE:
          "registry.example/repository-tools@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        WORKER_REPOSITORY_AGENT_DOCKER_SOCKET_PATH: "/var/run/docker.sock",
      }),
    ).toMatchObject({
      repositoryAgent: {
        sources: [
          {
            repositoryId: "support-service",
            directory: "/srv/repositories/support-service",
          },
        ],
        dockerSocketPath: "/var/run/docker.sock",
      },
    });
    expect(() =>
      loadWorkerRuntimeConfiguration({
        DATABASE_URL: "postgresql://caseweaver:caseweaver@localhost/test",
        WORKER_REPOSITORY_AGENT_SOURCES_JSON: "[]",
      }),
    ).toThrow(WorkerConfigurationError);
  });
});
