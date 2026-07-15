import type { Permission } from "@caseweaver/security";

import type { AdministrationAction, AdministrationResource } from "./dto.js";

export interface AdministrationResourcePolicy {
  readonly permission: Permission;
  readonly readAction: string;
  readonly sensitiveRead: boolean;
}

export interface AdministrationActionPolicy {
  readonly permission: Permission;
  readonly actionCode: string;
  readonly target: AdministrationResource;
}

const resourcePolicies: Readonly<
  Record<AdministrationResource, AdministrationResourcePolicy>
> = {
  overview: {
    permission: "operations.inspect",
    readAction: "admin.overview.read",
    sensitiveRead: false,
  },
  "secret-references": {
    permission: "credential.readMetadata",
    readAction: "admin.secretReference.list",
    sensitiveRead: true,
  },
  "connector-instances": {
    permission: "configuration.read",
    readAction: "admin.connectorInstance.list",
    sensitiveRead: false,
  },
  "knowledge-sources": {
    permission: "configuration.read",
    readAction: "admin.knowledgeSource.list",
    sensitiveRead: false,
  },
  schedules: {
    permission: "configuration.read",
    readAction: "admin.schedule.list",
    sensitiveRead: false,
  },
  "publication-profiles": {
    permission: "configuration.read",
    readAction: "admin.publicationProfile.list",
    sensitiveRead: false,
  },
  "webhook-endpoints": {
    permission: "configuration.read",
    readAction: "admin.webhookEndpoint.list",
    sensitiveRead: true,
  },
  "ai-provider-instances": {
    permission: "configuration.read",
    readAction: "admin.aiProviderInstance.list",
    sensitiveRead: false,
  },
  "ai-catalog-snapshots": {
    permission: "configuration.read",
    readAction: "admin.aiCatalogSnapshot.list",
    sensitiveRead: false,
  },
  "ai-models": {
    permission: "configuration.read",
    readAction: "admin.aiModel.list",
    sensitiveRead: false,
  },
  "ai-bindings": {
    permission: "configuration.read",
    readAction: "admin.aiBinding.list",
    sensitiveRead: false,
  },
  "ai-role-defaults": {
    permission: "configuration.read",
    readAction: "admin.aiRoleDefault.list",
    sensitiveRead: false,
  },
  "ai-pricing-overrides": {
    permission: "configuration.read",
    readAction: "admin.aiPricingOverride.list",
    sensitiveRead: false,
  },
  "ai-budgets": {
    permission: "configuration.read",
    readAction: "admin.aiBudget.list",
    sensitiveRead: false,
  },
  collections: {
    permission: "configuration.read",
    readAction: "admin.collection.list",
    sensitiveRead: false,
  },
  "retrieval-profiles": {
    permission: "configuration.read",
    readAction: "admin.retrievalProfile.list",
    sensitiveRead: false,
  },
  "prompt-profiles": {
    permission: "configuration.read",
    readAction: "admin.promptProfile.list",
    sensitiveRead: false,
  },
  "analysis-profiles": {
    permission: "configuration.read",
    readAction: "admin.analysisProfile.list",
    sensitiveRead: false,
  },
  analyses: {
    permission: "analysis.read",
    readAction: "admin.analysis.list",
    sensitiveRead: true,
  },
  publications: {
    permission: "analysis.read",
    readAction: "admin.publication.list",
    sensitiveRead: true,
  },
  "operation-jobs": {
    permission: "operations.inspect",
    readAction: "admin.operationJob.list",
    sensitiveRead: true,
  },
  "dead-letters": {
    permission: "operations.inspect",
    readAction: "admin.deadLetter.list",
    sensitiveRead: true,
  },
  costs: {
    permission: "cost.read",
    readAction: "admin.cost.list",
    sensitiveRead: true,
  },
  retention: {
    permission: "operations.inspect",
    readAction: "admin.retention.list",
    sensitiveRead: false,
  },
  privacy: {
    permission: "privacy.delete",
    readAction: "admin.privacy.list",
    sensitiveRead: true,
  },
  diagnostics: {
    permission: "diagnostics.export",
    readAction: "admin.diagnostics.list",
    sensitiveRead: true,
  },
  "audit-events": {
    permission: "audit.read",
    readAction: "admin.auditEvent.list",
    sensitiveRead: true,
  },
  workspaces: {
    permission: "workspace.manage",
    readAction: "admin.workspace.list",
    sensitiveRead: false,
  },
  principals: {
    permission: "identity.manage",
    readAction: "admin.principal.list",
    sensitiveRead: true,
  },
  "role-assignments": {
    permission: "identity.manage",
    readAction: "admin.roleAssignment.list",
    sensitiveRead: true,
  },
  platform: {
    permission: "configuration.read",
    readAction: "admin.platform.read",
    sensitiveRead: false,
  },
};

const actionPolicies: Readonly<
  Record<AdministrationAction, AdministrationActionPolicy>
> = {
  "connector.test": {
    permission: "connector.manage",
    actionCode: "admin.connector.test",
    target: "connector-instances",
  },
  "connector.activate": {
    permission: "configuration.manage",
    actionCode: "admin.connector.activate",
    target: "connector-instances",
  },
  "connector.disable": {
    permission: "configuration.manage",
    actionCode: "admin.connector.disable",
    target: "connector-instances",
  },
  "provider.test": {
    permission: "configuration.manage",
    actionCode: "admin.provider.test",
    target: "ai-provider-instances",
  },
  "provider.activate": {
    permission: "configuration.manage",
    actionCode: "admin.provider.activate",
    target: "ai-provider-instances",
  },
  "provider.disable": {
    permission: "configuration.manage",
    actionCode: "admin.provider.disable",
    target: "ai-provider-instances",
  },
  "source.synchronize": {
    permission: "connector.manage",
    actionCode: "admin.knowledgeSource.synchronize",
    target: "knowledge-sources",
  },
  "source.fullRescan": {
    permission: "connector.manage",
    actionCode: "admin.knowledgeSource.fullRescan",
    target: "knowledge-sources",
  },
  "dead-letter.retry": {
    permission: "operations.retry",
    actionCode: "admin.deadLetter.retry",
    target: "dead-letters",
  },
  "job.cancel": {
    permission: "analysis.cancel",
    actionCode: "admin.operationJob.cancel",
    target: "operation-jobs",
  },
  "job.recover": {
    permission: "operations.recover",
    actionCode: "admin.operationJob.recover",
    target: "operation-jobs",
  },
  "retention.reap": {
    permission: "retention.run",
    actionCode: "admin.retention.reap",
    target: "retention",
  },
  "privacy.purge": {
    permission: "privacy.delete",
    actionCode: "admin.privacy.purge",
    target: "privacy",
  },
  "diagnostics.export": {
    permission: "diagnostics.export",
    actionCode: "admin.diagnostics.export",
    target: "diagnostics",
  },
  "secret.rotate": {
    permission: "credential.manage",
    actionCode: "admin.secretReference.rotate",
    target: "secret-references",
  },
  "secret.revoke": {
    permission: "credential.manage",
    actionCode: "admin.secretReference.revoke",
    target: "secret-references",
  },
  "publication.approve": {
    permission: "publication.approve",
    actionCode: "admin.publication.approve",
    target: "publications",
  },
};

export function policyForResource(
  resource: AdministrationResource,
): AdministrationResourcePolicy {
  return resourcePolicies[resource];
}

export function policyForAction(
  action: AdministrationAction,
): AdministrationActionPolicy {
  return actionPolicies[action];
}
