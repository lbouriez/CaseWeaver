import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  AdministrationConflictError,
  ActivateAiModelBinding,
  type ConfigurationDescriptor,
  canonicalizeConfiguration,
  IdempotencyConflictError,
  ManageKnowledgeScheduleConfiguration,
  ManageKnowledgeSourceConfiguration,
  ManagePlatformLinkConfiguration,
  ManagePublicationProfileConfiguration,
  ManageWebhookEndpointConfiguration,
  CreateAiModelBindingDraft,
  CreateAiModelBindingVersionDraft,
  CreateAiPriceOverride,
  DisableAiModelBinding,
  ReplaceAiBudgetPolicy,
  SetAiWorkspaceRoleDefault,
  ReplaceWorkspacePrincipalRoles,
  PreviewProviderCapabilityTest,
  RunProviderCapabilityTest,
  sha256Base64Url,
} from "@caseweaver/administration";
import { DefaultAiExecutionGateway } from "@caseweaver/ai-execution";
import {
  type ApplicationTransaction,
  ApprovePublication,
  CancelOperationalJob,
  type Clock,
  type IdGenerator,
  InspectDeadLetters,
  PurgeCaseSnapshot,
  QueryCostAttribution,
  QueueExpiredRetention,
  RecoverExpiredJob,
  RequestAnalysisWithPublication,
  RequestKnowledgeSourceSynchronization,
  RetryDeadLetter,
} from "@caseweaver/application";
import {
  auditEventId,
  principalId,
  sha256Digest,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import {
  resolveOpenTelemetryConfig,
  startOpenTelemetry,
} from "@caseweaver/observability";
import {
  createPostgresPersistence,
  createPostgresAiPersistence,
  PostgresConfigurationLifecycleStore,
  PostgresPlatformLinkConfigurationStore,
  PostgresPublicationProfileConfigurationStore,
  PostgresSourceScheduleConfigurationStore,
  PostgresWebhookEndpointConfigurationStore,
  type PostgresTransactionLookup,
} from "@caseweaver/postgres";
import { buildApi } from "./app.js";
import { parseApiConfig } from "./config.js";
import { createDatabaseReadiness } from "./database-readiness.js";
import { ConfiguredApiExecutionContextResolver } from "./execution-context.js";
import { createLogger } from "./logger.js";
import { PostgresDescriptorConfigurationLifecycle } from "./modules/administration/configuration-lifecycle-action.js";
import {
  AdministrationOperationDispatcher,
  digestIdempotencyKey,
} from "./modules/administration/operation-dispatcher.js";
import { AdministrationApiOperations } from "./modules/administration/operations.js";
import { ExistingOperationsPreflight } from "./modules/administration/operations-preflight.js";
import {
  runtimeDescriptorRegistration,
  runtimeDescriptorRegistrations,
} from "./modules/administration/runtime-descriptors.js";
import { PostgresSecretReferenceLifecycle } from "./modules/administration/secret-reference-lifecycle.js";
import {
  EnvironmentSecretResolver,
  providerCapabilityTestTemplates,
  registeredAiProviderDispatcher,
} from "./modules/administration/ai-runtime.js";
import { ensureBootstrapAdministrator } from "./modules/auth/bootstrap-administrator.js";
import { AesGcmEphemeralSecretProtector } from "./modules/auth/ephemeral-secret-protector.js";
import { StandardsOidcClient } from "./modules/auth/oidc-client.js";
import { AuthSessionService } from "./modules/auth/session-service.js";

function createIds(): IdGenerator {
  return {
    next: () => randomUUID(),
  };
}

const clock: Clock = {
  now: () => utcInstant(new Date()),
};

export async function startApi(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = parseApiConfig(env);
  const logger = createLogger(config);
  const databaseReadiness = createDatabaseReadiness(config);
  const persistence = createPostgresPersistence({
    databaseUrl: config.databaseUrl,
  });
  const aiExecutionPersistence = createPostgresAiPersistence({
    databaseUrl: config.databaseUrl,
  });
  const capabilityTestStores = persistence.providerCapabilityTestStores(
    providerCapabilityTestTemplates(),
  );
  const aiGateway = new DefaultAiExecutionGateway({
    bindingResolver: persistence.aiBindingResolver,
    providerDispatcher: registeredAiProviderDispatcher(),
    secretResolver: new EnvironmentSecretResolver(env),
    ledger: aiExecutionPersistence.ledger,
    budget: aiExecutionPersistence.budget,
    budgetPolicy: aiExecutionPersistence.budget,
    unitOfWork: aiExecutionPersistence.unitOfWork,
    operationIds: { next: () => randomUUID() },
    clock: { now: () => new Date().toISOString() },
  });
  const providerCapabilityTests = Object.freeze({
    preview: new PreviewProviderCapabilityTest(
      capabilityTestStores.configurations,
      capabilityTestStores.state,
      aiGateway,
      { now: () => new Date().toISOString() },
    ),
    run: new RunProviderCapabilityTest({
      configurations: capabilityTestStores.configurations,
      confirmations: capabilityTestStores.state,
      rateLimiter: capabilityTestStores.state,
      claims: capabilityTestStores.state,
      results: capabilityTestStores.state,
      preflight: aiGateway,
      gateway: aiGateway,
      clock: { now: () => new Date().toISOString() },
    }),
  });
  if (
    config.oidc !== undefined &&
    config.administrationBootstrap !== undefined
  ) {
    try {
      await ensureBootstrapAdministrator({
        unitOfWork: persistence.unitOfWork as typeof persistence.unitOfWork &
          PostgresTransactionLookup,
        auditStore: persistence.auditStore,
        workspaceId: config.workspaceId,
        principalId: config.principalId,
        issuer: config.oidc.issuer,
        subject: config.administrationBootstrap.oidcSubject,
        displayName: config.administrationBootstrap.displayName,
      });
    } catch {
      await persistence.close();
      await aiExecutionPersistence.close();
      throw new Error("Administration bootstrap failed.");
    }
  }
  const telemetry = await startOpenTelemetry(
    resolveOpenTelemetryConfig(env, "caseweaver-api"),
  );
  const ids = createIds();
  const requestAnalysis = new RequestAnalysisWithPublication(
    persistence.unitOfWork,
    persistence.analysisRequestStore,
    persistence.publicationIntentStore,
    persistence.outboxStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const approvePublication = new ApprovePublication(
    persistence.unitOfWork,
    persistence.publicationIntentStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const inspectDeadLetters = new InspectDeadLetters(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.authorizationGuard,
  );
  const retryDeadLetter = new RetryDeadLetter(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.outboxStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const cancelJob = new CancelOperationalJob(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const recoverExpiredJob = new RecoverExpiredJob(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.resourceLeaseStore,
    persistence.outboxStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const queryCosts = new QueryCostAttribution(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.authorizationGuard,
  );
  const purgeCaseSnapshot = new PurgeCaseSnapshot(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.outboxStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const queueRetention = new QueueExpiredRetention(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.outboxStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const requestKnowledgeSourceSynchronization =
    new RequestKnowledgeSourceSynchronization(
      persistence.unitOfWork,
      persistence.knowledgeSourceCommandStore,
      persistence.outboxStore,
      persistence.auditStore,
      persistence.authorizationGuard,
      ids,
      clock,
    );
  const administration =
    config.oidc === undefined
      ? undefined
      : await createAdministrationOperations(config, persistence, {
          retryDeadLetter,
          cancelJob,
          recoverJob: recoverExpiredJob,
          queueRetention,
          approvePublication,
          purgeCaseSnapshot,
          requestKnowledgeSourceSynchronization,
          providerCapabilityTests,
        });
  const app = buildApi({
    config,
    logger,
    readinessProbe: databaseReadiness.readinessProbe,
    publication: {
      context: new ConfiguredApiExecutionContextResolver(config),
      operations: {
        requestAnalysis: (command, context) =>
          requestAnalysis.execute(command, context),
        approvePublication: (intentId, context) =>
          approvePublication.execute(intentId, context),
      },
    },
    operations: {
      context: new ConfiguredApiExecutionContextResolver(config),
      operations: {
        inspectDeadLetters: (limit, context) =>
          inspectDeadLetters.execute(limit, context),
        retryDeadLetter: (jobId, mutation, context) =>
          retryDeadLetter.execute(jobId, mutation, context),
        cancelJob: (jobId, mutation, context) =>
          cancelJob.execute(jobId, mutation, context),
        recoverExpiredJob: (jobId, mutation, context) =>
          recoverExpiredJob.execute(jobId, mutation, context),
        queryCosts: (query, context) => queryCosts.execute(query, context),
        purgeCaseSnapshot: (snapshotId, reason, mutation, context) =>
          purgeCaseSnapshot.execute(snapshotId, reason, mutation, context),
        queueRetention: (mutation, context, limit) =>
          queueRetention.execute(mutation, context, limit),
      },
    },
    ...(administration === undefined ? {} : { administration }),
  });

  app.addHook("onClose", async () => {
    await persistence.close();
    await aiExecutionPersistence.close();
    await databaseReadiness.close();
    await telemetry?.shutdown();
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch {
    await app.close();
    throw new Error("API startup failed.");
  }
}

async function createAdministrationOperations(
  config: ReturnType<typeof parseApiConfig>,
  persistence: ReturnType<typeof createPostgresPersistence>,
  operationUseCases: Readonly<{
    readonly retryDeadLetter: RetryDeadLetter;
    readonly cancelJob: CancelOperationalJob;
    readonly recoverJob: RecoverExpiredJob;
    readonly queueRetention: QueueExpiredRetention;
    readonly approvePublication: ApprovePublication;
    readonly purgeCaseSnapshot: PurgeCaseSnapshot;
    readonly requestKnowledgeSourceSynchronization: RequestKnowledgeSourceSynchronization;
    readonly providerCapabilityTests: Readonly<{
      readonly preview: Pick<PreviewProviderCapabilityTest, "execute">;
      readonly run: Pick<RunProviderCapabilityTest, "execute">;
    }>;
  }>,
): Promise<AdministrationApiOperations> {
  if (config.oidc === undefined)
    throw new Error("OIDC configuration is required.");
  const oidc = new StandardsOidcClient({
    issuer: config.oidc.issuer,
    clientId: config.oidc.clientId,
    ...(config.oidc.clientSecret === undefined
      ? {}
      : { clientSecret: config.oidc.clientSecret }),
    redirectUri: config.oidc.callbackUrl,
    scopes: ["openid", "profile"],
  });
  const auth = new AuthSessionService({
    oidc,
    sessions: persistence.authSessionStore,
    sessionAuditMutations: persistence.authSessionAuditMutationStore,
    mappings: persistence.oidcIdentityMappingStore,
    protector: new AesGcmEphemeralSecretProtector(
      config.oidc.ephemeralKeyId,
      config.oidc.ephemeralEncryptionKey,
    ),
    ids: { next: () => randomUUID() },
    workspaceName: (id) =>
      persistence.administrationReadStore.workspaceName(id),
    permissionsFor: (input) =>
      persistence.administrationReadStore.permissionsFor(input),
    secureCookies: config.nodeEnv !== "development",
    allowedOrigins: config.allowedAdminOrigins,
  });
  await Promise.all(
    runtimeDescriptorRegistrations.map(({ descriptor }) =>
      persistence.descriptorRegistry.register(descriptor),
    ),
  );
  const secretReferences = new PostgresSecretReferenceLifecycle({
    unitOfWork: persistence.unitOfWork as typeof persistence.unitOfWork &
      PostgresTransactionLookup,
    auditStore: persistence.auditStore,
  });
  const configurationLifecycle = new PostgresDescriptorConfigurationLifecycle({
    unitOfWork: persistence.unitOfWork as typeof persistence.unitOfWork &
      PostgresTransactionLookup,
    auditStore: persistence.auditStore,
  });
  const createKnowledgeSourceDraft = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly displayName: string;
      readonly connectorInstanceId: string;
      readonly collectionId: string;
      readonly normalizationProfileVersion: string;
      readonly chunkingProfileVersion: string;
      readonly synchronizationPolicy: Readonly<Record<string, unknown>>;
      readonly deletionBehavior: "tombstone" | "retain";
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) => {
    const configurationId = serverConfigurationId("source", input.context);
    const settings = Object.freeze({
      connectorInstanceId: input.connectorInstanceId,
      collectionId: input.collectionId,
      normalizationProfileVersion: input.normalizationProfileVersion,
      chunkingProfileVersion: input.chunkingProfileVersion,
      synchronizationPolicy: input.synchronizationPolicy,
      deletionBehavior: input.deletionBehavior,
    });
    const requestDigest = sha256Base64Url(canonicalizeConfiguration(settings));
    const result = await persistence.unitOfWork.transaction(
      async (transaction) =>
        new ManageKnowledgeSourceConfiguration(
          { transaction: async (operation) => operation() },
          new PostgresSourceScheduleConfigurationStore(
            persistence.unitOfWork as typeof persistence.unitOfWork &
              PostgresTransactionLookup,
            transaction,
          ),
          configurationLifecycleAudit(persistence, transaction, input.context),
        ).create({
          workspaceId: input.workspaceId,
          displayName: input.displayName,
          settings,
          source: {
            sourceId: configurationId,
            connectorRegistrationId: input.connectorInstanceId,
            knowledgeCollectionId: input.collectionId,
            normalizationProfileVersion: input.normalizationProfileVersion,
            chunkingProfileVersion: input.chunkingProfileVersion,
            synchronizationPolicy: input.synchronizationPolicy,
            deletionBehavior: input.deletionBehavior,
          },
          mutation: {
            operation: "admin.knowledgeSource.draft.create",
            keyDigest: digestIdempotencyKey(
              input.context.idempotencyKey ?? input.context.requestId,
            ),
            requestDigest,
          },
        }),
    );
    return Object.freeze({
      id: result.configuration.id,
      revision: result.configuration.revision,
    });
  };
  const createKnowledgeScheduleDraft = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly displayName: string;
      readonly sourceId: string;
      readonly sourceConfigurationVersionId: string;
      readonly kind: "synchronize" | "fullRescan";
      readonly cadence:
        | Readonly<{
            readonly kind: "cron";
            readonly expression: string;
            readonly timezone: string;
            readonly jitterMs?: number;
            readonly overlapPolicy: "skip" | "queue";
          }>
        | Readonly<{
            readonly kind: "interval";
            readonly intervalMs: number;
            readonly jitterMs?: number;
            readonly overlapPolicy: "skip" | "queue";
          }>;
      readonly nextRunAt: string;
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) => {
    const configurationId = serverConfigurationId("schedule", input.context);
    const settings = Object.freeze({
      sourceId: input.sourceId,
      sourceConfigurationVersionId: input.sourceConfigurationVersionId,
      kind: input.kind,
      cadence: input.cadence,
      nextRunAt: input.nextRunAt,
    });
    const requestDigest = sha256Base64Url(canonicalizeConfiguration(settings));
    const result = await persistence.unitOfWork.transaction(
      async (transaction) =>
        new ManageKnowledgeScheduleConfiguration(
          { transaction: async (operation) => operation() },
          new PostgresSourceScheduleConfigurationStore(
            persistence.unitOfWork as typeof persistence.unitOfWork &
              PostgresTransactionLookup,
            transaction,
          ),
          configurationLifecycleAudit(persistence, transaction, input.context),
        ).create({
          workspaceId: input.workspaceId,
          displayName: input.displayName,
          settings,
          schedule: {
            scheduleId: configurationId,
            sourceId: input.sourceId,
            sourceConfigurationVersionId: input.sourceConfigurationVersionId,
            kind: input.kind,
            cadence: input.cadence,
            nextRunAt: input.nextRunAt,
          },
          mutation: {
            operation: "admin.knowledgeSchedule.draft.create",
            keyDigest: digestIdempotencyKey(
              input.context.idempotencyKey ?? input.context.requestId,
            ),
            requestDigest,
          },
        }),
    );
    return Object.freeze({
      id: result.configuration.id,
      revision: result.configuration.revision,
    });
  };
  const transitionKnowledgeSource = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly sourceId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) =>
    persistence.unitOfWork.transaction(async (transaction) => {
      const database = (
        persistence.unitOfWork as typeof persistence.unitOfWork &
          PostgresTransactionLookup
      ).get(transaction);
      const [configuration, source] = await Promise.all([
        database.administrationConfiguration.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.sourceId,
            },
          },
          select: { resourceType: true, currentVersionId: true },
        }),
        database.knowledgeSource.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.sourceId,
            },
          },
          select: {
            connectorRegistrationId: true,
            knowledgeCollectionId: true,
            normalizationProfileVersion: true,
            chunkingProfileVersion: true,
            synchronizationPolicy: true,
            deletionBehavior: true,
          },
        }),
      ]);
      if (
        configuration === null ||
        configuration.resourceType !== "knowledge-sources" ||
        configuration.currentVersionId === null ||
        source === null
      ) {
        throw new Error("resource.notFound");
      }
      if (input.lifecycle === "disabled") {
        const enabledSchedules = await database.knowledgeSchedule.count({
          where: {
            workspaceId: input.workspaceId,
            knowledgeSourceId: input.sourceId,
            enabled: true,
          },
        });
        if (enabledSchedules > 0) throw new AdministrationConflictError();
      }
      const version =
        await database.administrationConfigurationVersion.findUnique({
          where: { id: configuration.currentVersionId },
          select: { settings: true, displayName: true },
        });
      if (version === null) throw new Error("resource.notFound");
      const settings = storedConfigurationSettings(version.settings);
      const transitioned = await new ManageKnowledgeSourceConfiguration(
        { transaction: async (operation) => operation() },
        new PostgresSourceScheduleConfigurationStore(
          persistence.unitOfWork as typeof persistence.unitOfWork &
            PostgresTransactionLookup,
          transaction,
        ),
        configurationLifecycleAudit(persistence, transaction, input.context),
      ).transition({
        workspaceId: input.workspaceId,
        ...(version.displayName === null
          ? {}
          : { displayName: version.displayName }),
        settings,
        source: {
          sourceId: input.sourceId,
          connectorRegistrationId: source.connectorRegistrationId,
          knowledgeCollectionId: source.knowledgeCollectionId,
          normalizationProfileVersion: source.normalizationProfileVersion,
          chunkingProfileVersion: source.chunkingProfileVersion,
          synchronizationPolicy: storedConfigurationSettings(
            source.synchronizationPolicy,
          ),
          deletionBehavior: asDeletionBehavior(source.deletionBehavior),
        },
        expectedRevision: input.expectedRevision,
        lifecycle: input.lifecycle,
        beforeHash: configurationSettingsHash(settings),
        mutation: {
          operation: `admin.knowledgeSource.${input.lifecycle}`,
          keyDigest: digestIdempotencyKey(
            input.context.idempotencyKey ?? input.context.requestId,
          ),
          requestDigest: sha256Base64Url(
            canonicalizeConfiguration({
              sourceId: input.sourceId,
              expectedRevision: input.expectedRevision,
              lifecycle: input.lifecycle,
            }),
          ),
        },
      });
      return Object.freeze({
        revision: transitioned.configuration.revision,
        lifecycle: input.lifecycle === "active" ? "enabled" : "disabled",
      });
    });
  const transitionKnowledgeSchedule = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly scheduleId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) =>
    persistence.unitOfWork.transaction(async (transaction) => {
      const database = (
        persistence.unitOfWork as typeof persistence.unitOfWork &
          PostgresTransactionLookup
      ).get(transaction);
      const [configuration, schedule] = await Promise.all([
        database.administrationConfiguration.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.scheduleId,
            },
          },
          select: { resourceType: true, currentVersionId: true },
        }),
        database.knowledgeSchedule.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.scheduleId,
            },
          },
          select: {
            knowledgeSourceId: true,
            configurationVersion: true,
            scheduleKind: true,
            triggerKind: true,
            cronExpression: true,
            timezone: true,
            intervalMs: true,
            jitterMs: true,
            overlapPolicy: true,
            nextRunAt: true,
          },
        }),
      ]);
      if (
        configuration === null ||
        configuration.resourceType !== "schedules" ||
        configuration.currentVersionId === null ||
        schedule === null
      ) {
        throw new Error("resource.notFound");
      }
      const version =
        await database.administrationConfigurationVersion.findUnique({
          where: { id: configuration.currentVersionId },
          select: { settings: true, displayName: true },
        });
      if (version === null) throw new Error("resource.notFound");
      const settings = storedConfigurationSettings(version.settings);
      const transitioned = await new ManageKnowledgeScheduleConfiguration(
        { transaction: async (operation) => operation() },
        new PostgresSourceScheduleConfigurationStore(
          persistence.unitOfWork as typeof persistence.unitOfWork &
            PostgresTransactionLookup,
          transaction,
        ),
        configurationLifecycleAudit(persistence, transaction, input.context),
      ).transition({
        workspaceId: input.workspaceId,
        ...(version.displayName === null
          ? {}
          : { displayName: version.displayName }),
        settings,
        schedule: {
          scheduleId: input.scheduleId,
          sourceId: schedule.knowledgeSourceId,
          sourceConfigurationVersionId: schedule.configurationVersion,
          kind: asKnowledgeScheduleKind(schedule.scheduleKind),
          cadence: persistedScheduleCadence(schedule),
          nextRunAt: schedule.nextRunAt.toISOString(),
        },
        expectedRevision: input.expectedRevision,
        lifecycle: input.lifecycle,
        beforeHash: configurationSettingsHash(settings),
        mutation: {
          operation: `admin.knowledgeSchedule.${input.lifecycle}`,
          keyDigest: digestIdempotencyKey(
            input.context.idempotencyKey ?? input.context.requestId,
          ),
          requestDigest: sha256Base64Url(
            canonicalizeConfiguration({
              scheduleId: input.scheduleId,
              expectedRevision: input.expectedRevision,
              lifecycle: input.lifecycle,
            }),
          ),
        },
      });
      return Object.freeze({
        revision: transitioned.configuration.revision,
        lifecycle: input.lifecycle === "active" ? "enabled" : "disabled",
      });
    });
  const createPublicationProfile = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly displayName: string;
      readonly definition: Readonly<Record<string, unknown>>;
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) => {
    const profileId = serverConfigurationId("publication", input.context);
    const requestDigest = sha256Base64Url(
      canonicalizeConfiguration({
        displayName: input.displayName,
        definition: input.definition,
      }),
    );
    const result = await persistence.unitOfWork.transaction((transaction) =>
      new ManagePublicationProfileConfiguration(
        { transaction: async (operation) => operation() },
        new PostgresPublicationProfileConfigurationStore(
          persistence.unitOfWork as typeof persistence.unitOfWork &
            PostgresTransactionLookup,
          transaction,
        ),
        configurationLifecycleAudit(persistence, transaction, input.context),
      ).create({
        workspaceId: input.workspaceId,
        displayName: input.displayName,
        definition: input.definition,
        profile: { profileId },
        mutation: {
          operation: "admin.publicationProfile.draft.create",
          keyDigest: digestIdempotencyKey(
            input.context.idempotencyKey ?? input.context.requestId,
          ),
          requestDigest,
        },
      }),
    );
    return Object.freeze({
      id: result.configuration.id,
      revision: result.configuration.revision,
    });
  };
  const transitionPublicationProfile = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly profileId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) =>
    persistence.unitOfWork.transaction(async (transaction) => {
      const database = (
        persistence.unitOfWork as typeof persistence.unitOfWork &
          PostgresTransactionLookup
      ).get(transaction);
      const configuration =
        await database.administrationConfiguration.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.profileId,
            },
          },
          select: { resourceType: true, currentVersionId: true },
        });
      if (
        configuration === null ||
        configuration.resourceType !== "publication-profiles" ||
        configuration.currentVersionId === null
      ) {
        throw new Error("resource.notFound");
      }
      const version =
        await database.administrationConfigurationVersion.findUnique({
          where: { id: configuration.currentVersionId },
          select: { displayName: true, settings: true },
        });
      if (version === null) throw new Error("resource.notFound");
      const definition = publicationDefinition(
        version.settings,
        input.profileId,
      );
      const result = await new ManagePublicationProfileConfiguration(
        { transaction: async (operation) => operation() },
        new PostgresPublicationProfileConfigurationStore(
          persistence.unitOfWork as typeof persistence.unitOfWork &
            PostgresTransactionLookup,
          transaction,
        ),
        configurationLifecycleAudit(persistence, transaction, input.context),
      ).transition({
        workspaceId: input.workspaceId,
        ...(version.displayName === null
          ? {}
          : { displayName: version.displayName }),
        definition,
        profile: { profileId: input.profileId },
        expectedRevision: input.expectedRevision,
        lifecycle: input.lifecycle,
        beforeHash: configurationSettingsHash(definition),
        mutation: {
          operation: `admin.publicationProfile.${input.lifecycle}`,
          keyDigest: digestIdempotencyKey(
            input.context.idempotencyKey ?? input.context.requestId,
          ),
          requestDigest: sha256Base64Url(
            canonicalizeConfiguration({
              profileId: input.profileId,
              expectedRevision: input.expectedRevision,
              lifecycle: input.lifecycle,
            }),
          ),
        },
      });
      return Object.freeze({
        revision: result.configuration.revision,
        lifecycle: input.lifecycle,
      });
    });
  const createWebhookEndpoint = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly displayName: string;
      readonly connectorInstanceId: string;
      readonly verifiedEventTypes: readonly string[];
      readonly maximumBodyBytes: number;
      readonly maximumRequestsPerMinute: number;
      readonly analysisTriggerId?: string;
      readonly settings: Readonly<Record<string, unknown>>;
      readonly secretReferenceRegistrationIds: readonly string[];
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) => {
    const endpointId = serverConfigurationId("webhook", input.context);
    // The immutable generic version retains only the safe routing projection
    // necessary to activate an inert draft later. It deliberately carries
    // registration identities (not locators), no payload/header policy, and
    // no connector implementation.
    const settings = Object.freeze({
      ...input.settings,
      _caseweaverWebhookRouting: Object.freeze({
        connectorInstanceId: input.connectorInstanceId,
        verifiedEventTypes: [...input.verifiedEventTypes].sort(),
        maximumBodyBytes: input.maximumBodyBytes,
        maximumRequestsPerMinute: input.maximumRequestsPerMinute,
        ...(input.analysisTriggerId === undefined
          ? {}
          : { analysisTriggerId: input.analysisTriggerId }),
      }),
      secretReferenceRegistrationIds: [
        ...input.secretReferenceRegistrationIds,
      ].sort(),
    });
    const requestDigest = sha256Base64Url(
      canonicalizeConfiguration({
        displayName: input.displayName,
        connectorInstanceId: input.connectorInstanceId,
        verifiedEventTypes: input.verifiedEventTypes,
        maximumBodyBytes: input.maximumBodyBytes,
        maximumRequestsPerMinute: input.maximumRequestsPerMinute,
        analysisTriggerId: input.analysisTriggerId,
        settings,
      }),
    );
    const result = await persistence.unitOfWork.transaction(
      async (transaction) => {
        const locators = await resolveRegisteredSecretReferenceLocators({
          transaction,
          persistence,
          workspaceId: input.workspaceId,
          registrationIds: input.secretReferenceRegistrationIds,
        });
        return new ManageWebhookEndpointConfiguration(
          { transaction: async (operation) => operation() },
          new PostgresWebhookEndpointConfigurationStore(
            persistence.unitOfWork as typeof persistence.unitOfWork &
              PostgresTransactionLookup,
            transaction,
          ),
          configurationLifecycleAudit(persistence, transaction, input.context),
        ).create({
          workspaceId: input.workspaceId,
          displayName: input.displayName,
          projection: {
            endpointId,
            connectorRegistrationId: input.connectorInstanceId,
            verifiedEventTypes: input.verifiedEventTypes,
            maximumBodyBytes: input.maximumBodyBytes,
            maximumRequestsPerMinute: input.maximumRequestsPerMinute,
            ...(input.analysisTriggerId === undefined
              ? {}
              : { analysisTriggerId: input.analysisTriggerId }),
          },
          settings,
          secretReferenceLocators: locators,
          mutation: {
            operation: "admin.webhookEndpoint.draft.create",
            keyDigest: digestIdempotencyKey(
              input.context.idempotencyKey ?? input.context.requestId,
            ),
            requestDigest,
          },
        });
      },
    );
    return Object.freeze({
      id: result.configuration.id,
      revision: result.configuration.revision,
    });
  };
  const transitionWebhookEndpoint = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly endpointId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) =>
    persistence.unitOfWork.transaction(async (transaction) => {
      const database = (
        persistence.unitOfWork as typeof persistence.unitOfWork &
          PostgresTransactionLookup
      ).get(transaction);
      const configuration =
        await database.administrationConfiguration.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.endpointId,
            },
          },
          select: { resourceType: true, currentVersionId: true },
        });
      if (
        configuration === null ||
        configuration.resourceType !== "webhook-endpoints" ||
        configuration.currentVersionId === null
      ) {
        throw new Error("resource.notFound");
      }
      const version =
        await database.administrationConfigurationVersion.findUnique({
          where: { id: configuration.currentVersionId },
          select: { displayName: true, settings: true },
        });
      if (version === null) throw new Error("resource.notFound");
      const settings = storedConfigurationSettings(version.settings);
      const projection = webhookDraftProjection(settings, input.endpointId);
      const registrationIds = registeredSecretReferenceIds(settings);
      const locators = await resolveRegisteredSecretReferenceLocators({
        transaction,
        persistence,
        workspaceId: input.workspaceId,
        registrationIds,
      });
      const result = await new ManageWebhookEndpointConfiguration(
        { transaction: async (operation) => operation() },
        new PostgresWebhookEndpointConfigurationStore(
          persistence.unitOfWork as typeof persistence.unitOfWork &
            PostgresTransactionLookup,
          transaction,
        ),
        configurationLifecycleAudit(persistence, transaction, input.context),
      ).transition({
        workspaceId: input.workspaceId,
        ...(version.displayName === null
          ? {}
          : { displayName: version.displayName }),
        projection: {
          ...projection,
        },
        settings,
        secretReferenceLocators: locators,
        expectedRevision: input.expectedRevision,
        lifecycle: input.lifecycle,
        beforeHash: configurationSettingsHash(settings),
        mutation: {
          operation: `admin.webhookEndpoint.${input.lifecycle}`,
          keyDigest: digestIdempotencyKey(
            input.context.idempotencyKey ?? input.context.requestId,
          ),
          requestDigest: sha256Base64Url(
            canonicalizeConfiguration({
              endpointId: input.endpointId,
              expectedRevision: input.expectedRevision,
              lifecycle: input.lifecycle,
            }),
          ),
        },
      });
      return Object.freeze({
        revision: result.configuration.revision,
        lifecycle: input.lifecycle,
      });
    });
  const platformLinks = async (
    input: Readonly<{ readonly workspaceId: string }>,
  ) =>
    persistence
      .platformLinkReadStore({
        allowHttpLocalhost: config.nodeEnv === "development",
      })
      .find(input);
  const savePlatformLinks = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly apiPublicBaseUrl: string;
      readonly webhookPublicBaseUrl: string;
      readonly expectedRevision?: number;
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) =>
    persistence.unitOfWork.transaction(async (transaction) => {
      const database = (
        persistence.unitOfWork as typeof persistence.unitOfWork &
          PostgresTransactionLookup
      ).get(transaction);
      const existing = await database.administrationConfiguration.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: `platform-links:${input.workspaceId}`,
          },
        },
        select: { revision: true, lifecycle: true },
      });
      const manager = new ManagePlatformLinkConfiguration(
        { transaction: async (operation) => operation() },
        new PostgresPlatformLinkConfigurationStore(
          persistence.unitOfWork as typeof persistence.unitOfWork &
            PostgresTransactionLookup,
          transaction,
        ),
        configurationLifecycleAudit(persistence, transaction, input.context),
        { allowHttpLocalhost: config.nodeEnv === "development" },
      );
      const settings = {
        apiPublicBaseUrl: input.apiPublicBaseUrl,
        webhookPublicBaseUrl: input.webhookPublicBaseUrl,
      };
      const keyDigest = digestIdempotencyKey(
        input.context.idempotencyKey ?? input.context.requestId,
      );
      const requestDigest = sha256Base64Url(
        canonicalizeConfiguration(settings),
      );
      if (existing !== null && input.expectedRevision === undefined) {
        const creation = await database.idempotencyRecord.findUnique({
          where: {
            workspaceId_operation_keyDigest: {
              workspaceId: input.workspaceId,
              operation: "admin.platformLink.draft.create",
              keyDigest,
            },
          },
          select: { requestDigest: true },
        });
        if (creation !== null) {
          if (creation.requestDigest !== requestDigest) {
            throw new IdempotencyConflictError();
          }
          // The first save atomically created and activated this aggregate.
          // A lost response replays its terminal state without an extra version
          // or audit record, even though the browser does not yet know a revision.
          return Object.freeze({
            revision: existing.revision,
            lifecycle: existing.lifecycle,
          });
        }
      }
      const mutation = {
        operation: "admin.platformLink.configuration.changed",
        keyDigest,
        requestDigest,
      };
      // A first public-base save must be immediately usable. Retain a draft
      // version for immutable history, then activate its successor inside the
      // same outer PostgreSQL transaction with both audits committed atomically.
      const result =
        existing === null
          ? await (async () => {
              const created = await manager.create({
                workspaceId: input.workspaceId,
                settings,
                mutation: {
                  operation: "admin.platformLink.draft.create",
                  keyDigest,
                  requestDigest,
                },
              });
              return manager.transition({
                workspaceId: input.workspaceId,
                settings,
                expectedRevision: created.configuration.revision,
                mutation,
              });
            })()
          : await manager.transition({
              workspaceId: input.workspaceId,
              settings,
              expectedRevision: input.expectedRevision ?? -1,
              mutation,
            });
      return Object.freeze({
        revision: result.configuration.revision,
        lifecycle: result.configuration.lifecycle,
      });
    });
  const createAiBindingDraft = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly providerInstanceId: string;
      readonly catalogSnapshotId: string;
      readonly canonicalModel: string;
      readonly role: string;
      readonly requiredCapabilities?: readonly string[];
      readonly maximumInputTokens?: number;
      readonly maximumOutputTokens?: number;
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) => {
    const keyDigest = digestIdempotencyKey(
      input.context.idempotencyKey ?? input.context.requestId,
    );
    const bindingId = `ai-binding-${keyDigest.slice(0, 48)}`;
    const binding = await persistence.aiBindingDraftStore.load({
      workspaceId: input.workspaceId,
      bindingId,
      version: 1,
      role: input.role,
      providerInstanceId: input.providerInstanceId,
      catalogSnapshotId: input.catalogSnapshotId,
      canonicalModel: input.canonicalModel,
      ...(input.requiredCapabilities === undefined
        ? {}
        : { requiredCapabilities: input.requiredCapabilities }),
      ...(input.maximumInputTokens === undefined
        ? {}
        : { maximumInputTokens: input.maximumInputTokens }),
      ...(input.maximumOutputTokens === undefined
        ? {}
        : { maximumOutputTokens: input.maximumOutputTokens }),
    });
    if (binding === undefined) throw new Error("resource.notFound");
    const result = await new CreateAiModelBindingDraft(
      persistence.aiConfigurationStore,
    ).execute(
      {
        binding,
        mutation: {
          keyDigest,
          requestDigest: digestIdempotencyKey(
            canonicalizeConfiguration({
              providerInstanceId: input.providerInstanceId,
              catalogSnapshotId: input.catalogSnapshotId,
              canonicalModel: input.canonicalModel,
              role: input.role,
              requiredCapabilities: input.requiredCapabilities ?? [],
              maximumInputTokens: input.maximumInputTokens,
              maximumOutputTokens: input.maximumOutputTokens,
            }),
          ),
        },
      },
      aiConfigurationContext(input.context),
    );
    return Object.freeze({
      id: result.summary.bindingId,
      revision: result.summary.revision,
    });
  };
  const createAiBindingVersionDraft = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly bindingId: string;
      readonly expectedRevision: number;
      readonly providerInstanceId: string;
      readonly catalogSnapshotId: string;
      readonly canonicalModel: string;
      readonly requiredCapabilities?: readonly string[];
      readonly maximumInputTokens?: number;
      readonly maximumOutputTokens?: number;
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) => {
    const binding = await persistence.aiBindingDraftStore.loadNextVersion({
      workspaceId: input.workspaceId,
      bindingId: input.bindingId,
      providerInstanceId: input.providerInstanceId,
      catalogSnapshotId: input.catalogSnapshotId,
      canonicalModel: input.canonicalModel,
      ...(input.requiredCapabilities === undefined
        ? {}
        : { requiredCapabilities: input.requiredCapabilities }),
      ...(input.maximumInputTokens === undefined
        ? {}
        : { maximumInputTokens: input.maximumInputTokens }),
      ...(input.maximumOutputTokens === undefined
        ? {}
        : { maximumOutputTokens: input.maximumOutputTokens }),
    });
    if (binding === undefined) throw new Error("resource.notFound");
    const result = await new CreateAiModelBindingVersionDraft(
      persistence.aiConfigurationStore,
    ).execute(
      {
        binding,
        expectedRevision: input.expectedRevision,
        mutation: {
          keyDigest: digestIdempotencyKey(
            input.context.idempotencyKey ?? input.context.requestId,
          ),
          requestDigest: digestIdempotencyKey(
            canonicalizeConfiguration({
              bindingId: input.bindingId,
              expectedRevision: input.expectedRevision,
              providerInstanceId: input.providerInstanceId,
              catalogSnapshotId: input.catalogSnapshotId,
              canonicalModel: input.canonicalModel,
              requiredCapabilities: input.requiredCapabilities ?? [],
              maximumInputTokens: input.maximumInputTokens,
              maximumOutputTokens: input.maximumOutputTokens,
            }),
          ),
        },
      },
      aiConfigurationContext(input.context),
    );
    return Object.freeze({
      id: result.summary.bindingId,
      revision: result.summary.revision,
    });
  };
  const transitionAiBinding = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly bindingId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) => {
    const mutation = {
      keyDigest: digestIdempotencyKey(
        input.context.idempotencyKey ?? input.context.requestId,
      ),
      requestDigest: digestIdempotencyKey(
        canonicalizeConfiguration({
          bindingId: input.bindingId,
          expectedRevision: input.expectedRevision,
          lifecycle: input.lifecycle,
        }),
      ),
    };
    const result = await (input.lifecycle === "active"
      ? new ActivateAiModelBinding(persistence.aiConfigurationStore).execute(
          {
            bindingId: input.bindingId,
            expectedRevision: input.expectedRevision,
            mutation,
          },
          aiConfigurationContext(input.context),
        )
      : new DisableAiModelBinding(persistence.aiConfigurationStore).execute(
          {
            bindingId: input.bindingId,
            expectedRevision: input.expectedRevision,
            mutation,
          },
          aiConfigurationContext(input.context),
        ));
    return Object.freeze({
      revision: result.summary.revision,
      lifecycle: result.summary.lifecycle,
    });
  };
  const setAiRoleDefault = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly role: string;
      readonly bindingVersionId: string;
      readonly expectedRevision: number;
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) => {
    const result = await new SetAiWorkspaceRoleDefault(
      persistence.aiConfigurationStore,
    ).execute(
      {
        role: input.role as never,
        bindingVersionId: input.bindingVersionId,
        expectedRevision: input.expectedRevision,
        mutation: {
          keyDigest: digestIdempotencyKey(
            input.context.idempotencyKey ?? input.context.requestId,
          ),
          requestDigest: digestIdempotencyKey(
            canonicalizeConfiguration({
              role: input.role,
              bindingVersionId: input.bindingVersionId,
              expectedRevision: input.expectedRevision,
            }),
          ),
        },
      },
      aiConfigurationContext(input.context),
    );
    return Object.freeze({
      revision: result.summary.revision,
      bindingVersionId: result.summary.bindingVersionId,
    });
  };
  const createAiPriceOverride = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly overrideId?: string;
      readonly scope: "workspace" | "binding";
      readonly provider: string;
      readonly canonicalModel: string;
      readonly bindingVersionId?: string;
      readonly effectiveFrom: string;
      readonly effectiveTo?: string;
      readonly components: readonly Readonly<{
        readonly kind: string;
        readonly unit: string;
        readonly amount: string;
        readonly currency: string;
        readonly conditions?: Readonly<Record<string, unknown>>;
      }>[];
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) => {
    const keyDigest = digestIdempotencyKey(
      input.context.idempotencyKey ?? input.context.requestId,
    );
    const overrideId = `ai-price-${keyDigest.slice(0, 48)}`;
    const result = await new CreateAiPriceOverride(
      persistence.aiConfigurationStore,
    ).execute(
      {
        overrideId,
        scope: input.scope,
        provider: input.provider,
        canonicalModel: input.canonicalModel,
        ...(input.bindingVersionId === undefined
          ? {}
          : { bindingVersionId: input.bindingVersionId }),
        effectiveFrom: input.effectiveFrom,
        ...(input.effectiveTo === undefined
          ? {}
          : { effectiveTo: input.effectiveTo }),
        components: input.components as never,
        mutation: {
          keyDigest,
          requestDigest: digestIdempotencyKey(
            canonicalizeConfiguration({
              scope: input.scope,
              provider: input.provider,
              canonicalModel: input.canonicalModel,
              bindingVersionId: input.bindingVersionId,
              effectiveFrom: input.effectiveFrom,
              effectiveTo: input.effectiveTo,
              components: input.components,
            }),
          ),
        },
      },
      aiConfigurationContext(input.context),
    );
    return Object.freeze({ id: result.summary.id });
  };
  const replaceAiBudget = async (
    input: Readonly<{
      readonly workspaceId: string;
      readonly budgetPolicyId?: string;
      readonly scope: string;
      readonly scopeKey: string;
      readonly limitAmount: string;
      readonly currency: string;
      readonly hard: boolean;
      readonly expectedRevision: number;
      readonly context: import("./modules/administration/routes.js").AdminRequestContext;
    }>,
  ) => {
    const keyDigest = digestIdempotencyKey(
      input.context.idempotencyKey ?? input.context.requestId,
    );
    const policyId = `ai-budget-${keyDigest.slice(0, 47)}`;
    const result = await new ReplaceAiBudgetPolicy(
      persistence.aiConfigurationStore,
    ).execute(
      {
        budgetPolicyId: policyId,
        scope: input.scope as never,
        scopeKey: input.scopeKey,
        limitAmount: input.limitAmount,
        currency: input.currency,
        hard: input.hard,
        expectedRevision: input.expectedRevision,
        mutation: {
          keyDigest,
          requestDigest: digestIdempotencyKey(
            canonicalizeConfiguration({
              scope: input.scope,
              scopeKey: input.scopeKey,
              limitAmount: input.limitAmount,
              currency: input.currency,
              hard: input.hard,
              expectedRevision: input.expectedRevision,
            }),
          ),
        },
      },
      aiConfigurationContext(input.context),
    );
    return Object.freeze({
      id: result.summary.id,
      revision: result.summary.revision,
      active: result.summary.active,
    });
  };
  const dispatcher = new AdministrationOperationDispatcher({
    previews: persistence.administrationActionPreviewStore,
    preflight: new ExistingOperationsPreflight({
      unitOfWork: persistence.unitOfWork,
      operations: persistence.operationsStore,
      reads: persistence.administrationReadStore,
      privacyTargets: {
        exists: (input) =>
          persistence.administrationReadStore.caseSnapshotExists({
            workspaceId: input.workspaceId,
            id: input.caseSnapshotId,
          }),
      },
    }),
    useCases: operationUseCases,
    secretReferences,
    configurationLifecycle,
  });
  return new AdministrationApiOperations({
    auth,
    reads: persistence.administrationReadStore,
    resources: persistence.administrationResourceReadStore,
    descriptors: persistence.descriptorRegistry,
    unitOfWork: persistence.unitOfWork,
    auditStore: persistence.auditStore,
    authAudits: persistence.authAuditRecorder,
    auditWorkspaceId: config.workspaceId,
    diagnostics: {
      requests: persistence.diagnosticExportStore,
      artifacts: persistence.diagnosticExportArtifactStore,
    },
    dispatcher,
    createKnowledgeSourceDraft,
    createKnowledgeScheduleDraft,
    transitionKnowledgeSource,
    transitionKnowledgeSchedule,
    createPublicationProfile,
    transitionPublicationProfile,
    createWebhookEndpoint,
    transitionWebhookEndpoint,
    platformLinks,
    savePlatformLinks,
    createAiBindingDraft,
    createAiBindingVersionDraft,
    transitionAiBinding,
    setAiRoleDefault,
    createAiPriceOverride,
    replaceAiBudget,
    providerCapabilityTests: operationUseCases.providerCapabilityTests,
    replaceWorkspacePrincipalRoles: new ReplaceWorkspacePrincipalRoles(
      persistence.workspaceRoleAssignmentStore,
    ),
    workspaceRoleAssignments: persistence.workspaceRoleAssignmentStore,
    createDraft: async (input) =>
      persistence.unitOfWork.transaction(async (transaction) => {
        const kind =
          input.resourceType === "connector-instances"
            ? "connector"
            : "aiProvider";
        const registration = runtimeDescriptorRegistration(
          kind,
          input.descriptorType,
        );
        if (registration === undefined) throw new Error("resource.notFound");
        const descriptor = await persistence.descriptorRegistry.find({
          kind,
          type: input.descriptorType,
        });
        if (
          descriptor === undefined ||
          descriptor.version !== registration.descriptor.version
        ) {
          throw new Error("resource.notFound");
        }
        // Connector instance identity is a server-owned aggregate ID.  The
        // descriptor validator still receives a syntactically valid value
        // while calculating the idempotency digest, but a browser can never
        // choose the ID that the runtime will later use.
        const validationSettings =
          kind === "connector"
            ? { ...input.settings, connectorInstanceId: "server-managed" }
            : input.settings;
        const settingsForDigest = registration.validateSettings(
          await resolveRegisteredSecretReferences({
            transaction,
            persistence,
            workspaceId: input.workspaceId,
            descriptor,
            settings: validationSettings,
          }),
        );
        const requestDigest = sha256Base64Url(
          canonicalizeConfiguration({
            descriptorType: input.descriptorType,
            displayName: input.displayName,
            settings: settingsForDigest,
          }),
        );
        const identity = {
          operation: "admin.configuration.draft.create",
          keyDigest: sha256Base64Url(
            input.context.idempotencyKey ?? input.context.requestId,
          ),
          requestDigest,
        };
        const store = new PostgresConfigurationLifecycleStore(
          persistence.unitOfWork as typeof persistence.unitOfWork &
            PostgresTransactionLookup,
          transaction,
        );
        const replay = await store.findMutation({
          workspaceId: input.workspaceId,
          identity,
        });
        if (replay !== undefined) {
          if (replay.requestDigest !== requestDigest)
            throw new IdempotencyConflictError();
          const existing =
            await persistence.administrationReadStore.configuration({
              workspaceId: input.workspaceId,
              id: replay.resourceId,
            });
          if (existing === undefined) throw new Error("resource.notFound");
          return Object.freeze({
            id: existing.id,
            revision: existing.revision,
          });
        }
        const id = randomUUID();
        const settings =
          kind === "connector"
            ? registration.validateSettings(
                await resolveRegisteredSecretReferences({
                  transaction,
                  persistence,
                  workspaceId: input.workspaceId,
                  descriptor,
                  settings: {
                    ...input.settings,
                    connectorInstanceId: id,
                  },
                }),
              )
            : settingsForDigest;
        const canonicalSettings = canonicalizeConfiguration(settings);
        const created = await store.createDraft({
          workspaceId: input.workspaceId,
          resourceType: input.resourceType,
          configurationId: id,
          displayName: input.displayName,
          canonicalSettings,
          secretReferenceIds: registration.secretReferenceIds(settings),
          descriptor: {
            kind,
            type: descriptor.type,
            version: descriptor.version,
          },
        });
        await store.recordMutation({
          workspaceId: input.workspaceId,
          identity,
          result: { requestDigest, resourceId: id },
        });
        await persistence.auditStore.append(transaction, {
          id: auditEventId(randomUUID()),
          workspaceId: workspaceId(input.workspaceId),
          actorPrincipalId: principalId(input.context.principalId),
          action: "admin.configuration.draft.created",
          targetId: id,
          targetType: input.resourceType,
          permission: "configuration.manage",
          outcome: "succeeded",
          origin: "admin_ui",
          occurredAt: utcInstant(new Date()),
          requestId: input.context.requestId,
          correlationId: input.context.correlationId,
          ...(input.context.uiActionId === undefined
            ? {}
            : { uiActionId: input.context.uiActionId }),
          ...(input.context.idempotencyKey === undefined
            ? {}
            : {
                idempotencyKeyDigest: digestIdempotencyKey(
                  input.context.idempotencyKey,
                ),
              }),
        });
        return Object.freeze({
          id: created.configuration.id,
          revision: created.configuration.revision,
        });
      }),
    createSecretReference: async (input) =>
      secretReferences.register({
        workspaceId: input.workspaceId,
        reference: input.reference,
        context: input.context,
        idempotencyKeyDigest: digestIdempotencyKey(
          input.context.idempotencyKey ?? input.context.requestId,
        ),
      }),
  });
}

/**
 * The browser submits only a registered opaque metadata ID for descriptor
 * secret slots. The actual external-backend locator is resolved inside the
 * transaction, never returned, and never placed in audit data. This keeps
 * descriptor forms generic while preventing arbitrary secret locators from
 * becoming active configuration.
 */
async function resolveRegisteredSecretReferences(
  input: Readonly<{
    readonly transaction: ApplicationTransaction;
    readonly persistence: ReturnType<typeof createPostgresPersistence>;
    readonly workspaceId: string;
    readonly descriptor: ConfigurationDescriptor;
    readonly settings: Readonly<Record<string, unknown>>;
  }>,
): Promise<Readonly<Record<string, unknown>>> {
  const selected = input.descriptor.secretSlots.flatMap((slot) => {
    const value = input.settings[slot.name];
    return typeof value === "string" && value.trim().length > 0
      ? [[slot.name, value.trim()] as const]
      : [];
  });
  if (selected.length === 0) return input.settings;
  const identifiers = [...new Set(selected.map(([, id]) => id))];
  const registrations = await (
    input.persistence.unitOfWork as typeof input.persistence.unitOfWork &
      PostgresTransactionLookup
  )
    .get(input.transaction)
    .credentialRegistration.findMany({
      where: {
        workspaceId: input.workspaceId,
        id: { in: identifiers },
        lifecycle: "active",
      },
      select: { id: true, secretReference: true },
    });
  const references = new Map(
    registrations.map((registration) => [
      registration.id,
      registration.secretReference,
    ]),
  );
  if (references.size !== identifiers.length) {
    throw new Error("secretReference.invalid");
  }
  return Object.freeze({
    ...input.settings,
    ...Object.fromEntries(
      selected.map(([slot, id]) => [slot, references.get(id) as string]),
    ),
  });
}

/**
 * Resolves only opaque registration identities inside the owning database
 * transaction. The returned locators are passed straight to a server-side
 * projection and never enter a DTO, configuration read model, audit, or log.
 */
async function resolveRegisteredSecretReferenceLocators(
  input: Readonly<{
    readonly transaction: ApplicationTransaction;
    readonly persistence: ReturnType<typeof createPostgresPersistence>;
    readonly workspaceId: string;
    readonly registrationIds: readonly string[];
  }>,
): Promise<readonly string[]> {
  const ids = [...new Set(input.registrationIds)].sort();
  if (ids.length === 0) return Object.freeze([]);
  const registrations = await (
    input.persistence.unitOfWork as typeof input.persistence.unitOfWork &
      PostgresTransactionLookup
  )
    .get(input.transaction)
    .credentialRegistration.findMany({
      where: {
        workspaceId: input.workspaceId,
        id: { in: ids },
        lifecycle: "active",
      },
      select: { id: true, secretReference: true },
    });
  if (registrations.length !== ids.length) {
    throw new Error("secretReference.invalid");
  }
  const byId = new Map(
    registrations.map((entry) => [entry.id, entry.secretReference]),
  );
  const resolved = ids.map((id) => byId.get(id));
  if (resolved.some((value) => value === undefined)) {
    throw new Error("secretReference.invalid");
  }
  return Object.freeze(resolved as string[]);
}

function publicationDefinition(
  value: unknown,
  profileId: string,
): Readonly<Record<string, unknown>> {
  const settings = storedConfigurationSettings(value);
  const { id, version, ...definition } = settings;
  if (id !== profileId || typeof version !== "string") {
    throw new Error("resource.notFound");
  }
  return Object.freeze(definition);
}

function registeredSecretReferenceIds(
  settings: Readonly<Record<string, unknown>>,
): readonly string[] {
  const value = settings.secretReferenceRegistrationIds;
  if (
    !Array.isArray(value) ||
    value.length > 30 ||
    !value.every(
      (entry) =>
        typeof entry === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(entry),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("resource.notFound");
  }
  return Object.freeze([...value]);
}

function webhookDraftProjection(
  settings: Readonly<Record<string, unknown>>,
  endpointId: string,
): Readonly<{
  readonly endpointId: string;
  readonly connectorRegistrationId: string;
  readonly verifiedEventTypes: readonly string[];
  readonly maximumBodyBytes: number;
  readonly maximumRequestsPerMinute: number;
  readonly analysisTriggerId?: string;
}> {
  const routing = settings._caseweaverWebhookRouting;
  if (
    routing === null ||
    typeof routing !== "object" ||
    Array.isArray(routing)
  ) {
    throw new Error("resource.notFound");
  }
  const value = routing as Readonly<Record<string, unknown>>;
  const connectorRegistrationId = value.connectorInstanceId;
  const maximumBodyBytes = value.maximumBodyBytes;
  const maximumRequestsPerMinute = value.maximumRequestsPerMinute;
  const analysisTriggerId = value.analysisTriggerId;
  if (
    typeof connectorRegistrationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(connectorRegistrationId) ||
    typeof maximumBodyBytes !== "number" ||
    !Number.isSafeInteger(maximumBodyBytes) ||
    maximumBodyBytes < 1 ||
    maximumBodyBytes > 10 * 1024 * 1024 ||
    typeof maximumRequestsPerMinute !== "number" ||
    !Number.isSafeInteger(maximumRequestsPerMinute) ||
    maximumRequestsPerMinute < 1 ||
    maximumRequestsPerMinute > 10_000 ||
    (analysisTriggerId !== undefined &&
      (typeof analysisTriggerId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(analysisTriggerId)))
  ) {
    throw new Error("resource.notFound");
  }
  return Object.freeze({
    endpointId,
    connectorRegistrationId,
    verifiedEventTypes: persistedWebhookEventTypes(value.verifiedEventTypes),
    maximumBodyBytes,
    maximumRequestsPerMinute,
    ...(analysisTriggerId === undefined ? {} : { analysisTriggerId }),
  });
}

function persistedWebhookEventTypes(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 100 ||
    !value.every(
      (entry) =>
        typeof entry === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(entry),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("resource.notFound");
  }
  return Object.freeze([...value]);
}

/**
 * Resource configuration identifiers are server-issued from the scoped
 * idempotency boundary. This prevents a browser from selecting an identifier
 * that later becomes a runtime-facing registration, while retries resolve to
 * the same immutable draft.
 */
function serverConfigurationId(
  prefix: "source" | "schedule" | "publication" | "webhook",
  context: import("./modules/administration/routes.js").AdminRequestContext,
): string {
  return `${prefix}-${digestIdempotencyKey(
    context.idempotencyKey ?? context.requestId,
  ).slice(0, 48)}`;
}

/**
 * Maps a package-level lifecycle audit plan onto the transaction that owns its
 * source/schedule projection. Actor, workspace and request metadata are
 * derived from the resolved server session, never from a browser payload.
 */
function configurationLifecycleAudit(
  persistence: ReturnType<typeof createPostgresPersistence>,
  transaction: ApplicationTransaction,
  context: import("./modules/administration/routes.js").AdminRequestContext,
) {
  return Object.freeze({
    append: async (
      input: Readonly<{
        readonly action: string;
        readonly targetType: string;
        readonly targetId: string;
        readonly permission: import("@caseweaver/security").Permission;
        readonly outcome: "succeeded";
        readonly beforeHash?: string;
        readonly afterHash: string;
      }>,
    ) =>
      persistence.auditStore.append(transaction, {
        id: auditEventId(randomUUID()),
        workspaceId: workspaceId(context.workspaceId),
        actorPrincipalId: principalId(context.principalId),
        action: input.action,
        targetId: input.targetId,
        targetType: input.targetType,
        permission: input.permission,
        outcome: input.outcome,
        ...(input.beforeHash === undefined
          ? {}
          : { beforeHash: sha256Digest(input.beforeHash) }),
        afterHash: sha256Digest(input.afterHash),
        origin: "admin_ui",
        occurredAt: utcInstant(new Date()),
        requestId: context.requestId,
        correlationId: context.correlationId,
        ...(context.uiActionId === undefined
          ? {}
          : { uiActionId: context.uiActionId }),
        idempotencyKeyDigest: digestIdempotencyKey(
          context.idempotencyKey ?? context.requestId,
        ),
      }),
  });
}

function aiConfigurationContext(
  context: import("./modules/administration/routes.js").AdminRequestContext,
) {
  return Object.freeze({
    workspaceId: context.workspaceId,
    actorPrincipalId: context.principalId,
    occurredAt: new Date().toISOString(),
    origin: "admin_ui" as const,
    requestId: context.requestId,
    correlationId: context.correlationId,
    ...(context.uiActionId === undefined
      ? {}
      : { uiActionId: context.uiActionId }),
  });
}

/** Immutable configuration JSON is only re-hydrated inside the transaction
 * that creates its successor version. It is never returned through transport. */
function storedConfigurationSettings(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("resource.notFound");
  }
  return value as Readonly<Record<string, unknown>>;
}

function asDeletionBehavior(value: string): "tombstone" | "retain" {
  if (value === "tombstone" || value === "retain") return value;
  throw new Error("resource.notFound");
}

function asKnowledgeScheduleKind(value: string): "synchronize" | "fullRescan" {
  if (value === "synchronize" || value === "fullRescan") return value;
  throw new Error("resource.notFound");
}

function asSafeMilliseconds(value: bigint | null): number | undefined {
  if (value === null) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 86_400_000) {
    throw new Error("resource.notFound");
  }
  return number;
}

function persistedScheduleCadence(
  input: Readonly<{
    readonly triggerKind: string;
    readonly cronExpression: string | null;
    readonly timezone: string | null;
    readonly intervalMs: bigint | null;
    readonly jitterMs: bigint | null;
    readonly overlapPolicy: string;
  }>,
):
  | Readonly<{
      readonly kind: "cron";
      readonly expression: string;
      readonly timezone: string;
      readonly jitterMs?: number;
      readonly overlapPolicy: "skip" | "queue";
    }>
  | Readonly<{
      readonly kind: "interval";
      readonly intervalMs: number;
      readonly jitterMs?: number;
      readonly overlapPolicy: "skip" | "queue";
    }> {
  const overlapPolicy =
    input.overlapPolicy === "skip" || input.overlapPolicy === "queue"
      ? input.overlapPolicy
      : undefined;
  if (overlapPolicy === undefined) throw new Error("resource.notFound");
  const jitterMs = asSafeMilliseconds(input.jitterMs);
  if (input.triggerKind === "cron") {
    if (input.cronExpression === null || input.timezone === null) {
      throw new Error("resource.notFound");
    }
    return Object.freeze({
      kind: "cron",
      expression: input.cronExpression,
      timezone: input.timezone,
      ...(jitterMs === undefined ? {} : { jitterMs }),
      overlapPolicy,
    });
  }
  if (input.triggerKind !== "interval") throw new Error("resource.notFound");
  const intervalMs = asSafeMilliseconds(input.intervalMs);
  if (intervalMs === undefined || intervalMs < 1) {
    throw new Error("resource.notFound");
  }
  return Object.freeze({
    kind: "interval",
    intervalMs,
    ...(jitterMs === undefined ? {} : { jitterMs }),
    overlapPolicy,
  });
}

function configurationSettingsHash(
  settings: Readonly<Record<string, unknown>>,
): ReturnType<typeof sha256Digest> {
  return sha256Digest(
    createHash("sha256")
      .update(canonicalizeConfiguration(settings), "utf8")
      .digest("hex"),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  void startApi().catch(() => {
    process.stderr.write("API startup failed.\n");
    process.exitCode = 1;
  });
}
