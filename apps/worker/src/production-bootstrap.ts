import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import { DefaultAiExecutionGateway } from "@caseweaver/ai-execution";
import {
  EnvironmentAiSecretResolver,
  RegisteredAiModelTokenizerResolver,
  RegisteredAiProviderDispatcher,
} from "@caseweaver/ai-provider-runtime";
import { AiConfigurationError } from "@caseweaver/ai-sdk";
import {
  CaptureAnalysisTriggerCase,
  CaptureAndSubmitAnalysisTrigger,
  OutboxRelay,
  PurgeRetentionWorkItem,
  ReapExpiredRetentionWork,
  SchedulePublicationForCompletedAnalysis,
  SubmitCapturedAnalysisTrigger,
  type Clock,
  type IdGenerator,
} from "@caseweaver/application";
import { VerifiedAttachmentDerivativeEvidenceReader } from "@caseweaver/attachment-runtime";
import {
  EnvironmentConnectorSecretResolver,
  RuntimeConnectorCapabilityResolver,
} from "@caseweaver/connector-runtime";
import { createGitMarkdownRuntimeContribution } from "@caseweaver/connector-git-markdown";
import { createJitbitRuntimeContributions } from "@caseweaver/connector-jitbit";
import {
  CopilotSdkAgentProvider,
  CopilotSdkByokRuntimeClient,
} from "@caseweaver/copilot-sdk-agent";
import { utcInstant } from "@caseweaver/domain";
import { GitCliRepository } from "@caseweaver/git-repository-runtime";
import {
  createProductionKnowledgeTextProfileRegistry,
  KnowledgeSynchronizationCoordinator,
  KnowledgeIngestionService,
} from "@caseweaver/knowledge";
import {
  BlobStoreRetentionObjectStore,
  createProductionBlobStore,
  loadObjectStorageRuntimeConfiguration,
} from "@caseweaver/object-storage";
import {
  OpenAiCompatibleProvider,
  openAiCompatibleTokenizerContribution,
} from "@caseweaver/openai-compatible";
import {
  createPostgresAiPersistence,
  createPostgresAnalysisEvidenceRuntime,
  createPostgresAttachmentPersistence,
  createPostgresKnowledgeRuntime,
  createPostgresPersistence,
  createPostgresRepositoryRuntime,
  createPostgresRetrievalPersistence,
  PostgresAnalysisRetrievalEvidencePort,
  PostgresAnalysisTriggerRequestStore,
  type PostgresTransactionLookup,
} from "@caseweaver/postgres";
import {
  FrozenSnapshotAttachmentEvidencePort,
  PinnedAnalysisPromptBuilderResolver,
} from "@caseweaver/analysis";
import {
  PublicationExecutor,
  StructuredAnalysisPublicationRenderer,
} from "@caseweaver/publication";
import {
  PgBossDurableMessageQueue,
  runPgBossMigrations,
} from "@caseweaver/queue-postgres";
import { RetrievalService } from "@caseweaver/retrieval";

import { RuntimeCaseSourceSnapshotCapture } from "./feature-handlers/analysis-trigger.js";
import { NormalizedCaseSnapshotProjector } from "./feature-handlers/normalized-case-projector.js";
import {
  createProductionAnalysisExecutionService,
  createLocalGitOciPinnedRepositoryRuntimeResolver,
  PinnedRepositoryInvestigationPort,
} from "./modules/analysis/index.js";
import { RuntimePublicationDestinationResolver } from "./modules/publication/index.js";
import { createWorkerProcess, type WorkerProcess } from "./process.js";
import { createProductionWorkerCommandHandlers } from "./production-composition.js";
import { createWorkerCommandDispatcher } from "./runtime.js";

export type { WorkerProcess } from "./process.js";

const clock: Clock = {
  now: () => utcInstant(new Date()),
};

const ids: IdGenerator = {
  next: () => randomUUID(),
};

export interface WorkerRuntimeConfiguration {
  readonly databaseUrl: string;
  readonly relayBatchSize: number;
  readonly relayPollIntervalMs: number;
  readonly workerTeamSize: number;
  readonly attachmentEvidenceMaximumBytes: number;
  readonly attachmentEvidenceMaximumCharacters: number;
  readonly gitTemporaryDirectory?: string;
  readonly gitRemoteCacheDirectory?: string;
  /** Optional, explicit repository-agent host boundary. */
  readonly repositoryAgent?: Readonly<{
    readonly sources: readonly Readonly<{
      readonly repositoryId: string;
      readonly directory: string;
    }>[];
    readonly sandboxImage: string;
    readonly dockerSocketPath?: string;
  }>;
}

export class WorkerConfigurationError extends Error {
  public readonly code = "worker.invalidConfiguration";
  public readonly retryable = false;

  public constructor() {
    super("Worker runtime configuration is invalid.");
    this.name = "WorkerConfigurationError";
  }
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WorkerConfigurationError();
  }
  return parsed;
}

function optionalAbsoluteDirectory(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value) || /[\r\n\0]/u.test(value)) {
    throw new WorkerConfigurationError();
  }
  return value;
}

function repositoryAgentConfiguration(
  environment: NodeJS.ProcessEnv,
): WorkerRuntimeConfiguration["repositoryAgent"] {
  const sourcesValue = environment.WORKER_REPOSITORY_AGENT_SOURCES_JSON;
  const image = environment.WORKER_REPOSITORY_AGENT_SANDBOX_IMAGE;
  const socketPath = environment.WORKER_REPOSITORY_AGENT_DOCKER_SOCKET_PATH;
  if (
    sourcesValue === undefined &&
    image === undefined &&
    socketPath === undefined
  ) {
    return undefined;
  }
  if (sourcesValue === undefined || image === undefined || image.length === 0) {
    throw new WorkerConfigurationError();
  }
  if (
    image.length > 500 ||
    /[\s\r\n\0]/u.test(image) ||
    !/@sha256:[a-f0-9]{64}$/iu.test(image)
  ) {
    throw new WorkerConfigurationError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourcesValue);
  } catch {
    throw new WorkerConfigurationError();
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 100) {
    throw new WorkerConfigurationError();
  }
  const repositories = new Set<string>();
  const sources = parsed.map((value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !("repositoryId" in value) ||
      !("directory" in value) ||
      typeof value.repositoryId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value.repositoryId) ||
      typeof value.directory !== "string"
    ) {
      throw new WorkerConfigurationError();
    }
    if (repositories.has(value.repositoryId))
      throw new WorkerConfigurationError();
    repositories.add(value.repositoryId);
    const directory = optionalAbsoluteDirectory(value.directory);
    if (directory === undefined) throw new WorkerConfigurationError();
    return Object.freeze({ repositoryId: value.repositoryId, directory });
  });
  const dockerSocketPath = optionalAbsoluteDirectory(socketPath);
  return Object.freeze({
    sources: Object.freeze(sources),
    sandboxImage: image,
    ...(dockerSocketPath === undefined ? {} : { dockerSocketPath }),
  });
}

/** Parses only trusted host configuration; it never returns secrets to a transport. */
export function loadWorkerRuntimeConfiguration(
  environment: NodeJS.ProcessEnv,
): WorkerRuntimeConfiguration {
  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new WorkerConfigurationError();
  }
  const gitTemporaryDirectory = optionalAbsoluteDirectory(
    environment.WORKER_GIT_TEMPORARY_DIRECTORY,
  );
  const gitRemoteCacheDirectory = optionalAbsoluteDirectory(
    environment.WORKER_GIT_REMOTE_CACHE_DIRECTORY,
  );
  const repositoryAgent = repositoryAgentConfiguration(environment);
  return Object.freeze({
    databaseUrl,
    relayBatchSize: boundedInteger(
      environment.WORKER_OUTBOX_RELAY_BATCH_SIZE,
      25,
      1,
      100,
    ),
    relayPollIntervalMs: boundedInteger(
      environment.WORKER_OUTBOX_RELAY_POLL_INTERVAL_MS,
      1_000,
      100,
      3_600_000,
    ),
    workerTeamSize: boundedInteger(environment.WORKER_TEAM_SIZE, 1, 1, 64),
    attachmentEvidenceMaximumBytes: boundedInteger(
      environment.WORKER_ATTACHMENT_EVIDENCE_MAXIMUM_BYTES,
      1_048_576,
      1,
      16 * 1024 * 1024,
    ),
    attachmentEvidenceMaximumCharacters: boundedInteger(
      environment.WORKER_ATTACHMENT_EVIDENCE_MAXIMUM_CHARACTERS,
      250_000,
      1,
      1_000_000,
    ),
    ...(gitTemporaryDirectory === undefined ? {} : { gitTemporaryDirectory }),
    ...(gitRemoteCacheDirectory === undefined
      ? {}
      : { gitRemoteCacheDirectory }),
    ...(repositoryAgent === undefined ? {} : { repositoryAgent }),
  });
}

function createAiRuntime(input: {
  readonly databaseUrl: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly bindingResolver: ReturnType<
    typeof createPostgresPersistence
  >["aiBindingResolver"];
  readonly repositoryAgent?: CopilotSdkAgentProvider;
}) {
  const persistence = createPostgresAiPersistence({
    databaseUrl: input.databaseUrl,
  });
  const gateway = new DefaultAiExecutionGateway({
    bindingResolver: input.bindingResolver,
    providerDispatcher: new RegisteredAiProviderDispatcher([
      {
        providerType: "openai-compatible",
        dispatcher: new OpenAiCompatibleProvider(),
      },
      ...(input.repositoryAgent === undefined
        ? []
        : [
            {
              providerType: "copilot-sdk-agent",
              dispatcher: input.repositoryAgent,
            },
          ]),
    ]),
    secretResolver: new EnvironmentAiSecretResolver(input.environment),
    ledger: persistence.ledger,
    budget: persistence.budget,
    budgetPolicy: persistence.budget,
    unitOfWork: persistence.unitOfWork,
    operationIds: { next: () => randomUUID() },
    clock: { now: () => new Date().toISOString() },
  });
  return Object.freeze({
    gateway,
    tokenizers: new RegisteredAiModelTokenizerResolver([
      openAiCompatibleTokenizerContribution,
    ]),
    close: persistence.close,
  });
}

function createRetrievalTokenCounter(input: {
  readonly runtime: Awaited<
    ReturnType<
      ReturnType<
        typeof createPostgresAnalysisEvidenceRuntime
      >["retrievalRuntime"]["resolve"]
    >
  >;
  readonly workspaceId: string;
  readonly bindingResolver: ReturnType<
    typeof createPostgresPersistence
  >["aiBindingResolver"];
  readonly tokenizers: RegisteredAiModelTokenizerResolver;
  readonly signal: AbortSignal;
}) {
  const requirements = [
    {
      bindingVersionId: input.runtime.profile.contextTokenBindingVersionId,
      role: "analysis" as const,
      purpose: "context" as const,
    },
    ...input.runtime.profile.collections.map((collection) => ({
      bindingVersionId: collection.embeddingBindingVersionId,
      role: "embedding" as const,
      purpose: "embedding" as const,
    })),
    ...(input.runtime.profile.reranker === undefined
      ? []
      : [
          {
            bindingVersionId: input.runtime.profile.reranker.bindingVersionId,
            role: "reranker" as const,
            purpose: "reranking" as const,
          },
        ]),
  ];
  return Promise.all(
    requirements.map(async (requirement) => {
      if (input.signal.aborted)
        throw new AiConfigurationError("AI execution was cancelled.");
      const binding = await input.bindingResolver.resolve({
        workspaceId: input.workspaceId,
        role: requirement.role,
        bindingVersionId: requirement.bindingVersionId,
      });
      if (binding.role !== requirement.role) {
        throw new AiConfigurationError(
          "The retained retrieval binding role is invalid.",
        );
      }
      return Object.freeze({
        ...requirement,
        tokenizer: input.tokenizers.resolve(binding),
      });
    }),
  ).then((resolved) => {
    const byKey = new Map(
      resolved.map((entry) => [
        `${entry.bindingVersionId}:${entry.purpose}`,
        entry.tokenizer,
      ]),
    );
    return Object.freeze({
      count(input_: {
        readonly text: string;
        readonly bindingVersionId: string;
        readonly purpose: "embedding" | "reranking" | "context";
      }): number {
        const tokenizer = byKey.get(
          `${input_.bindingVersionId}:${input_.purpose}`,
        );
        if (tokenizer === undefined) {
          throw new AiConfigurationError(
            "The retained retrieval tokenizer is unavailable.",
          );
        }
        return tokenizer.count(input_.text);
      },
    });
  });
}

export async function runWorkerQueueMigration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const configuration = loadWorkerRuntimeConfiguration(environment);
  await runPgBossMigrations({ connectionString: configuration.databaseUrl });
}

/**
 * Production-only composition. Every registered handler receives a real
 * PostgreSQL/object-storage/connector/AI dependency. No feature silently
 * substitutes test fixtures or current configuration for retained pins.
 */
export async function createProductionWorkerRuntimeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WorkerProcess> {
  const configuration = loadWorkerRuntimeConfiguration(environment);
  const persistence = createPostgresPersistence({
    databaseUrl: configuration.databaseUrl,
  });
  const knowledgeRuntime = createPostgresKnowledgeRuntime({
    databaseUrl: configuration.databaseUrl,
  });
  const retrievalPersistence = createPostgresRetrievalPersistence({
    databaseUrl: configuration.databaseUrl,
  });
  const analysisEvidenceRuntime = createPostgresAnalysisEvidenceRuntime({
    databaseUrl: configuration.databaseUrl,
  });
  const repositoryRuntime = createPostgresRepositoryRuntime({
    databaseUrl: configuration.databaseUrl,
  });
  const attachmentPersistence = createPostgresAttachmentPersistence({
    databaseUrl: configuration.databaseUrl,
  });
  let started = false;
  try {
    const repositoryAgent =
      configuration.repositoryAgent === undefined
        ? undefined
        : new CopilotSdkAgentProvider({
            client: new CopilotSdkByokRuntimeClient(),
            runtimeResolver:
              await createLocalGitOciPinnedRepositoryRuntimeResolver({
                configurations: repositoryRuntime.resolver,
                sources: configuration.repositoryAgent.sources,
                sandboxImage: configuration.repositoryAgent.sandboxImage,
                ...(configuration.repositoryAgent.dockerSocketPath === undefined
                  ? {}
                  : {
                      dockerSocketPath:
                        configuration.repositoryAgent.dockerSocketPath,
                    }),
                ...(configuration.gitTemporaryDirectory === undefined
                  ? {}
                  : {
                      temporaryDirectory: configuration.gitTemporaryDirectory,
                    }),
              }),
            limits: {
              maximumTurns: 100,
              maximumCpuMilliseconds: 15 * 60_000,
              maximumMemoryBytes: 8 * 1024 * 1024 * 1024,
              maximumOutputBytes: 10 * 1024 * 1024,
              maximumToolCalls: 1_000,
              timeoutMs: 15 * 60_000,
              maximumAggregateInputTokens: 100_000_000,
              maximumAggregateOutputTokens: 100_000_000,
            },
          });
    const blobs = await createProductionBlobStore(
      loadObjectStorageRuntimeConfiguration(
        environment as Parameters<
          typeof loadObjectStorageRuntimeConfiguration
        >[0],
      ),
    );
    const ai = createAiRuntime({
      databaseUrl: configuration.databaseUrl,
      environment,
      bindingResolver: persistence.aiBindingResolver,
      repositoryAgent,
    });
    const gitRepository = new GitCliRepository({
      ...(configuration.gitTemporaryDirectory === undefined
        ? {}
        : { temporaryDirectory: configuration.gitTemporaryDirectory }),
      ...(configuration.gitRemoteCacheDirectory === undefined
        ? {}
        : { remoteCacheDirectory: configuration.gitRemoteCacheDirectory }),
      environment,
    });
    const connectors = new RuntimeConnectorCapabilityResolver(
      persistence.runtimeConnectorConfigurationResolver,
      [
        createGitMarkdownRuntimeContribution({
          repositoryFactory: { create: () => gitRepository },
        }),
        ...createJitbitRuntimeContributions({}),
      ],
      new EnvironmentConnectorSecretResolver(environment),
    );
    const knowledgeIngestion = new KnowledgeIngestionService({
      store: knowledgeRuntime.ingestion,
      profiles: createProductionKnowledgeTextProfileRegistry(),
      ai: ai.gateway,
      ids: { next: () => randomUUID() },
      clock: { now: () => new Date().toISOString() },
    });
    const knowledge = Object.freeze({
      connectors,
      sourceConfigurations: knowledgeRuntime.sourceConfigurations,
      coordinator: new KnowledgeSynchronizationCoordinator({
        resolver: knowledgeRuntime.sourceConfigurations,
        executions: knowledgeRuntime.executions,
        ingestion: knowledgeIngestion,
        leaseMs: 60_000,
      }),
    });
    const attachments = new FrozenSnapshotAttachmentEvidencePort({
      references: analysisEvidenceRuntime.attachmentReferences,
      content: new VerifiedAttachmentDerivativeEvidenceReader(
        attachmentPersistence.repository,
        blobs,
        configuration.attachmentEvidenceMaximumBytes,
      ),
      maximumEvidenceCharacters:
        configuration.attachmentEvidenceMaximumCharacters,
    });
    const retrieval = new PostgresAnalysisRetrievalEvidencePort({
      runtime: analysisEvidenceRuntime.retrievalRuntime,
      retrieval: {
        async create(input) {
          const tokens = await createRetrievalTokenCounter({
            runtime: input.runtime,
            workspaceId: input.execution.workspaceId,
            bindingResolver: persistence.aiBindingResolver,
            tokenizers: ai.tokenizers,
            signal: input.signal,
          });
          return new RetrievalService({
            search: retrievalPersistence.search,
            snapshots: retrievalPersistence.snapshots,
            ai: ai.gateway,
            tokens,
          });
        },
      },
      clock: { now: () => new Date().toISOString() },
    });
    const prompts = new PinnedAnalysisPromptBuilderResolver({
      async resolve(input) {
        if (input.signal.aborted) {
          throw new AiConfigurationError("AI execution was cancelled.");
        }
        const binding = await persistence.aiBindingResolver.resolve({
          workspaceId: input.workspaceId,
          role: "analysis",
          bindingVersionId: input.bindingVersionId,
        });
        return { count: (text) => ai.tokenizers.resolve(binding).count(text) };
      },
    });
    const analysis = createProductionAnalysisExecutionService({
      store: persistence.analysisExecutionStore,
      attachments,
      retrieval,
      prompts,
      ai: ai.gateway,
      ids: {
        next: () => randomUUID(),
      },
      clock: { now: () => new Date().toISOString() },
      repository: new PinnedRepositoryInvestigationPort(
        ai.gateway,
        repositoryRuntime.executionResolver,
      ),
    });
    const triggerStore = new PostgresAnalysisTriggerRequestStore(
      persistence.unitOfWork as typeof persistence.unitOfWork &
        PostgresTransactionLookup,
    );
    const trigger = new CaptureAndSubmitAnalysisTrigger(
      new CaptureAnalysisTriggerCase(
        persistence.unitOfWork,
        triggerStore,
        new RuntimeCaseSourceSnapshotCapture(
          connectors,
          new NormalizedCaseSnapshotProjector(clock),
        ),
        clock,
      ),
      new SubmitCapturedAnalysisTrigger(persistence.unitOfWork, triggerStore, {
        store: persistence.analysisRequestStore,
        outbox: persistence.outboxStore,
        audit: persistence.auditStore,
        ids,
        clock,
      }),
    );
    const publication = Object.freeze({
      trigger,
      executor: new PublicationExecutor({
        unitOfWork: persistence.unitOfWork,
        store: persistence.publicationExecutionStore,
        leases: persistence.resourceLeaseStore,
        destinations: new RuntimePublicationDestinationResolver(connectors),
        renderer: new StructuredAnalysisPublicationRenderer(),
        clock,
        leaseMs: 60_000,
      }),
      completedAnalysis: new SchedulePublicationForCompletedAnalysis(
        persistence.unitOfWork,
        persistence.publicationIntentStore,
        clock,
      ),
    });
    const operations = Object.freeze({
      retention: Object.freeze({
        reaper: new ReapExpiredRetentionWork(
          persistence.unitOfWork,
          persistence.operationsStore,
          persistence.outboxStore,
          persistence.auditStore,
          ids,
          clock,
        ),
        purge: new PurgeRetentionWorkItem(
          persistence.unitOfWork,
          persistence.operationsStore,
          new BlobStoreRetentionObjectStore(blobs),
          persistence.auditStore,
          ids,
          clock,
        ),
      }),
    });
    const handlers = createProductionWorkerCommandHandlers({
      knowledge,
      diagnostics: {
        requests: persistence.diagnosticExportStore,
        source: persistence.diagnosticExportSource,
        artifacts: persistence.diagnosticExportArtifactStore,
        digest: {
          sha256: async (content) =>
            createHash("sha256").update(content).digest("hex"),
        },
        clock: { now: () => new Date().toISOString() },
      },
      analysis: { create: () => analysis },
      publication: {
        trigger: {
          trigger: (command, signal) => trigger.execute(command, signal),
        },
        executor: publication.executor,
        completedAnalysis: {
          complete: (event) => publication.completedAnalysis.execute(event),
        },
      },
      operations,
    });
    const queue = new PgBossDurableMessageQueue({
      connectionString: configuration.databaseUrl,
    });
    const process = createWorkerProcess({
      queue,
      dispatcher: createWorkerCommandDispatcher(handlers),
      relay: new OutboxRelay(
        persistence.unitOfWork,
        persistence.outboxStore,
        queue,
        clock,
      ),
      relayBatchSize: configuration.relayBatchSize,
      relayPollIntervalMs: configuration.relayPollIntervalMs,
      workerTeamSize: configuration.workerTeamSize,
    });
    let stopped = false;
    return Object.freeze({
      async start(): Promise<void> {
        await persistence.unitOfWork.transaction(async () => undefined);
        await process.start();
        started = true;
      },
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        const failures: unknown[] = [];
        if (started) {
          try {
            await process.stop();
          } catch (error) {
            failures.push(error);
          }
        }
        for (const close of [
          ai.close,
          attachmentPersistence.close,
          analysisEvidenceRuntime.close,
          repositoryRuntime.close,
          retrievalPersistence.close,
          knowledgeRuntime.close,
          persistence.close,
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Worker shutdown failed.");
        }
      },
      runRelayOnce: () => process.runRelayOnce(),
    });
  } catch (error) {
    const failures: unknown[] = [error];
    for (const close of [
      attachmentPersistence.close,
      analysisEvidenceRuntime.close,
      repositoryRuntime.close,
      retrievalPersistence.close,
      knowledgeRuntime.close,
      persistence.close,
    ]) {
      try {
        await close();
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    throw new AggregateError(failures, "Worker production composition failed.");
  }
}
