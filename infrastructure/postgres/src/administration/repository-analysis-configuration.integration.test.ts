import { createHash, randomUUID } from "node:crypto";

import {
  type AdministrationTransactionRunner,
  type ConfigurationLifecycleAudit,
  ManageRepositoryAnalysisConfiguration,
} from "@caseweaver/administration";
import type {
  ApplicationTransaction,
  AuditStore,
} from "@caseweaver/application";
import {
  auditEventId,
  principalId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPostgresPersistence,
  type PostgresTransactionLookup,
} from "../index.js";
import { PostgresRepositoryAnalysisConfigurationStore } from "./repository-analysis-configuration-store.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "PostgreSQL repository-analysis configuration tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const transactions: AdministrationTransactionRunner = {
  transaction: async <T>(operation: () => Promise<T>): Promise<T> =>
    operation(),
};

beforeEach(async () => {
  await pool.query(
    "TRUNCATE TABLE workspaces, ai_catalog_snapshots RESTART IDENTITY CASCADE",
  );
  await pool.query("INSERT INTO workspaces (id) VALUES ('workspace-a')");
  await pool.query(
    "INSERT INTO principals (id, workspace_id) VALUES ('principal-a', 'workspace-a')",
  );
  await seedRepositoryAgentBinding();
  await seedVisionBinding();
  await seedTriggerConfiguration();
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL repository-analysis administration projections", () => {
  it("commits immutable repository, execution, and attachment projections without retaining private settings", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const repository = await persistence.unitOfWork.transaction(
        (transaction) =>
          manager(persistence, transaction).createCodeRepository(
            {
              displayName: "Support service",
              settings: {
                repository: {
                  mode: "remoteHttps",
                  remoteUrl: "https://git.example.invalid/support-service.git",
                  checkoutRef: { kind: "branch", name: "main" },
                },
              },
              projection: codeRepositoryProjection(),
              secretReferenceIds: ["secret-reference-a"],
              mutation: mutation("codeRepository.create", "a"),
            },
            context(),
          ),
      );
      const execution = await persistence.unitOfWork.transaction(
        (transaction) =>
          manager(persistence, transaction).createRepositoryExecutionPolicy(
            {
              displayName: "Restricted support analysis",
              settings: {
                sandboxImage: "registry.example.invalid/agent@sha256:abc",
              },
              projection: executionPolicyProjection(),
              mutation: mutation("repositoryExecutionPolicy.create", "b"),
            },
            context(),
          ),
      );
      const attachment = await persistence.unitOfWork.transaction(
        (transaction) =>
          manager(persistence, transaction).createAttachmentPolicy(
            {
              displayName: "Safe attachments",
              settings: { allowedMimeFamilies: ["image", "text"] },
              projection: attachmentPolicyProjection(),
              mutation: mutation("attachmentPolicy.create", "c"),
            },
            context(),
          ),
      );

      await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).transitionCodeRepository(
          {
            expectedRevision: repository.configuration.revision,
            lifecycle: "active",
            settings: {
              repository: {
                mode: "remoteHttps",
                remoteUrl: "https://git.example.invalid/support-service.git",
                checkoutRef: { kind: "branch", name: "main" },
              },
            },
            projection: codeRepositoryProjection(),
            secretReferenceIds: ["secret-reference-a"],
            mutation: mutation("codeRepository.activate", "d"),
          },
          context(),
        ),
      );

      const rows = await pool.query<{
        readonly mode: string;
        readonly refs: unknown;
        readonly checkout_credential_required: boolean;
        readonly maximum_duration_milliseconds: number;
        readonly maximum_output_tokens: number;
        readonly sandbox_policy_version_id: string;
        readonly maximum_attachment_bytes: string;
        readonly maximum_expanded_archive_bytes: string;
      }>(
        `SELECT repository.mode, repository.allowed_ref_kinds AS refs,
                repository.checkout_credential_required,
                execution.maximum_duration_milliseconds,
                execution.maximum_output_tokens,
                execution.sandbox_policy_version_id,
                attachment.maximum_attachment_bytes::text,
                attachment.maximum_expanded_archive_bytes::text
         FROM code_repository_versions AS repository
         CROSS JOIN repository_execution_policy_versions AS execution
         CROSS JOIN attachment_policy_versions AS attachment
         WHERE repository.workspace_id = 'workspace-a'
           AND execution.workspace_id = 'workspace-a'
           AND attachment.workspace_id = 'workspace-a'
         ORDER BY repository.created_at ASC
         LIMIT 1`,
      );
      expect(rows.rows[0]).toEqual({
        mode: "remoteHttps",
        refs: ["branch", "tag"],
        checkout_credential_required: true,
        maximum_duration_milliseconds: 60_000,
        maximum_output_tokens: 8_000,
        sandbox_policy_version_id: "sandbox-policy-v1",
        maximum_attachment_bytes: String(2 * 1024 * 1024 * 1024),
        maximum_expanded_archive_bytes: String(8 * 1024 * 1024 * 1024),
      });
      const safeProjection = await pool.query<{ readonly body: string }>(
        `SELECT jsonb_build_object(
           'mode', mode,
           'allowedRefKinds', allowed_ref_kinds,
           'hasCheckoutSecretReference', checkout_credential_required
         )::text AS body
         FROM code_repository_versions
         WHERE workspace_id = 'workspace-a'
         ORDER BY created_at ASC
         LIMIT 1`,
      );
      expect(safeProjection.rows[0]?.body).not.toContain("git.example.invalid");
      expect(safeProjection.rows[0]?.body).not.toContain("vault://");
      expect(attachment.version.id).toBeDefined();
      expect(execution.version.id).toBeDefined();
    } finally {
      await persistence.close();
    }
  });

  it("retains an inert schedule draft without a principal and enables only a successor pin with the server-owned principal", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const draft = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).createCaseAnalysisSchedule(
          {
            displayName: "Support intake",
            settings: { cadence: "interval" },
            projection: scheduleProjection(),
            mutation: mutation("caseAnalysisSchedule.create", "e"),
          },
          context(),
        ),
      );
      const draftRow = await pool.query<{
        readonly schedule_id: string;
        readonly enabled: boolean;
        readonly automated_principal_id: string | null;
        readonly configuration_version_id: string;
      }>(
        `SELECT schedule_id, enabled, automated_principal_id, configuration_version_id
         FROM case_analysis_intake_schedules
         WHERE workspace_id = 'workspace-a'`,
      );
      expect(draftRow.rows).toEqual([
        {
          schedule_id: "intake-schedule-a",
          enabled: false,
          automated_principal_id: null,
          configuration_version_id: draft.version.id,
        },
      ]);

      await pool.query(
        `UPDATE administration_configurations
         SET lifecycle = 'active'
         WHERE workspace_id = 'workspace-a' AND id = 'trigger-a'`,
      );
      const active = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).transitionCaseAnalysisSchedule(
          {
            expectedRevision: draft.configuration.revision,
            lifecycle: "active",
            settings: { cadence: "interval", enabled: true },
            projection: scheduleProjection(),
            mutation: mutation("caseAnalysisSchedule.activate", "f"),
          },
          context(),
        ),
      );
      const enabledRows = await pool.query<{
        readonly schedule_id: string;
        readonly enabled: boolean;
        readonly automated_principal_id: string | null;
        readonly configuration_version_id: string;
        readonly trigger_configuration_version_id: string;
      }>(
        `SELECT schedule_id, enabled, automated_principal_id, configuration_version_id,
                analysis_trigger_configuration_version_id AS trigger_configuration_version_id
         FROM case_analysis_intake_schedules
         WHERE workspace_id = 'workspace-a'
         ORDER BY configuration_version_id`,
      );
      expect(enabledRows.rows).toEqual(
        expect.arrayContaining([
          {
            schedule_id: "intake-schedule-a",
            enabled: true,
            automated_principal_id: "principal-a",
            configuration_version_id: active.version.id,
            trigger_configuration_version_id: "trigger-configuration-v1",
          },
        ]),
      );
      await expect(
        pool.query(
          `SELECT id FROM case_analysis_schedules
           WHERE workspace_id = 'workspace-a' AND id = 'intake-schedule-a'`,
        ),
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await persistence.close();
    }
  });
});

function manager(
  persistence: ReturnType<typeof createPostgresPersistence>,
  transaction: ApplicationTransaction,
): ManageRepositoryAnalysisConfiguration {
  return new ManageRepositoryAnalysisConfiguration(
    transactions,
    new PostgresRepositoryAnalysisConfigurationStore(
      persistence.unitOfWork as PostgresTransactionLookup,
      transaction,
    ),
    audit(persistence.auditStore, transaction),
    { requireSuccessfulCandidate: async () => undefined },
  );
}

function audit(
  auditStore: AuditStore,
  transaction: ApplicationTransaction,
): ConfigurationLifecycleAudit {
  return {
    append: async (input) => {
      await auditStore.append(transaction, {
        id: auditEventId(randomUUID()),
        workspaceId: workspaceId("workspace-a"),
        actorPrincipalId: principalId("principal-a"),
        action: input.action,
        targetId: input.targetId,
        targetType: input.targetType,
        permission: input.permission,
        outcome: input.outcome,
        ...(input.beforeHash === undefined
          ? {}
          : { beforeHash: input.beforeHash }),
        afterHash: input.afterHash,
        origin: "admin_ui",
        occurredAt: utcInstant("2026-07-16T18:00:00.000Z"),
      });
    },
  };
}

function context() {
  return {
    workspaceId: "workspace-a",
    actorPrincipalId: "principal-a",
    sessionId: "session-a",
    occurredAt: "2026-07-16T18:00:00.000Z",
    origin: "admin_ui" as const,
  };
}

function codeRepositoryProjection() {
  return {
    repositoryId: "repository-a",
    mode: "remoteHttps" as const,
    allowedRefKinds: ["branch", "tag"] as const,
    configuredCheckoutRef: { kind: "branch" as const, name: "main" },
  };
}

function executionPolicyProjection() {
  return {
    executionPolicyId: "execution-policy-a",
    repositoryAgentBindingVersionId: "repository-agent-binding-v1",
    sandboxPolicyVersionId: "sandbox-policy-v1",
    allowedTools: ["listFiles", "readFile", "searchFiles"] as const,
    networkDisabled: true as const,
    maximumDurationMs: 60_000,
    maximumTurns: 12,
    maximumToolCalls: 50,
    maximumOutputTokens: 8_000,
    maximumCpuMilliseconds: 60_000,
    maximumMemoryBytes: 512 * 1024 * 1024,
    maximumOutputBytes: 2 * 1024 * 1024,
  };
}

function attachmentPolicyProjection() {
  return {
    attachmentPolicyId: "attachment-policy-a",
    processorSecurityPolicyVersionId: "processor-policy-v1",
    visionBindingVersionId: "vision-binding-v1",
    maximumAttachmentCount: 25,
    maximumAttachmentBytes: 2 * 1024 * 1024 * 1024,
    maximumArchiveEntries: 500,
    maximumExpandedArchiveBytes: 8 * 1024 * 1024 * 1024,
    maximumArchiveDepth: 4,
  };
}

function scheduleProjection() {
  return {
    scheduleId: "intake-schedule-a",
    triggerId: "trigger-a",
    triggerConfigurationVersionId: "trigger-configuration-v1",
    cadence: {
      kind: "interval" as const,
      intervalMs: 60_000,
      jitterMs: 1_000,
      overlapPolicy: "queue" as const,
    },
    nextRunAt: "2026-07-16T19:00:00.000Z",
  };
}

function mutation(operation: string, suffix: string) {
  return {
    operation,
    keyDigest: digest(`key:${operation}:${suffix}`),
    requestDigest: digest(`request:${operation}:${suffix}`),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function seedRepositoryAgentBinding(): Promise<void> {
  await pool.query(
    `INSERT INTO ai_catalog_snapshots (
       id, upstream_url, upstream_commit_sha, fetched_at, sha256, raw_entries
     ) VALUES (
       'catalog-snapshot-a', 'https://catalog.example.invalid/models', 'fixture-commit',
       '2026-07-16T18:00:00.000Z',
       'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       '{}'::jsonb
     )`,
  );
  await pool.query(
    `INSERT INTO ai_catalog_models (
       id, catalog_snapshot_id, canonical_model, provider, supported_roles,
       capabilities, raw_entry
     ) VALUES (
       'catalog-model-a', 'catalog-snapshot-a', 'repository-agent', 'fixture',
       '["repositoryAgent"]'::jsonb, '["repositoryAgent", "tools"]'::jsonb,
       '{}'::jsonb
     )`,
  );
  await pool.query(
    `INSERT INTO ai_provider_instances (
       id, workspace_id, provider_type, lifecycle
     ) VALUES ('provider-a', 'workspace-a', 'fixture', 'active')`,
  );
  await pool.query(
    `INSERT INTO ai_provider_instance_versions (
       id, workspace_id, provider_instance_id, version, endpoint, wire_api,
       parameters, secret_reference
     ) VALUES (
       'provider-version-a', 'workspace-a', 'provider-a', 1,
       'https://provider.example.invalid', 'responses', '{}'::jsonb, 'env:TEST'
     )`,
  );
  await pool.query(
    `INSERT INTO ai_model_bindings (
       id, workspace_id, role, lifecycle, revision
     ) VALUES (
       'repository-agent-binding-a', 'workspace-a', 'repositoryAgent', 'active', 1
     )`,
  );
  await pool.query(
    `INSERT INTO ai_model_binding_versions (
       id, workspace_id, model_binding_id, version, provider_instance_version_id,
       catalog_snapshot_id, catalog_model_id, canonical_model, wire_api, parameters,
       capabilities, secret_reference
     ) VALUES (
       'repository-agent-binding-v1', 'workspace-a', 'repository-agent-binding-a', 1,
       'provider-version-a', 'catalog-snapshot-a', 'catalog-model-a', 'repository-agent',
       'responses', '{}'::jsonb, '["repositoryAgent", "tools"]'::jsonb, 'env:TEST'
     )`,
  );
  await pool.query(
    `UPDATE ai_model_bindings
     SET active_version_id = 'repository-agent-binding-v1'
     WHERE workspace_id = 'workspace-a' AND id = 'repository-agent-binding-a'`,
  );
}

async function seedVisionBinding(): Promise<void> {
  await pool.query(
    `INSERT INTO ai_model_bindings (
       id, workspace_id, role, lifecycle, revision, active_version_id
     ) VALUES (
       'vision-binding-a', 'workspace-a', 'vision', 'active', 1, NULL
     )`,
  );
  await pool.query(
    `INSERT INTO ai_model_binding_versions (
       id, workspace_id, model_binding_id, version, provider_instance_version_id,
       catalog_snapshot_id, catalog_model_id, canonical_model, wire_api, parameters,
       capabilities, secret_reference
     ) VALUES (
       'vision-binding-v1', 'workspace-a', 'vision-binding-a', 1,
       'provider-version-a', 'catalog-snapshot-a', 'catalog-model-a',
       'vision-model', 'responses', '{}'::jsonb, '["vision"]'::jsonb, 'env:TEST'
     )`,
  );
  await pool.query(
    `UPDATE ai_model_bindings
     SET active_version_id = 'vision-binding-v1'
     WHERE workspace_id = 'workspace-a' AND id = 'vision-binding-a'`,
  );
}

async function seedTriggerConfiguration(): Promise<void> {
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, current_version_id
     ) VALUES ('trigger-a', 'workspace-a', 'case-analysis-triggers', 'draft', NULL)`,
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references
     ) VALUES (
       'trigger-configuration-v1', 'workspace-a', 'trigger-a', 1,
       '{}'::jsonb, '[]'::jsonb
     )`,
  );
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = 'trigger-configuration-v1'
     WHERE workspace_id = 'workspace-a' AND id = 'trigger-a'`,
  );
}
