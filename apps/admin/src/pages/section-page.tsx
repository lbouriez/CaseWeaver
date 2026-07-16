import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { useGetList, useRefresh } from "react-admin";
import { useApiClient } from "../api/context.js";
import type {
  AdminListItem,
  AdminResourceName,
  ConfigurationSurface,
} from "../api/contracts.js";
import { ActionConfirmationDialog } from "../components/action-confirmation-dialog.js";
import { ApiFailure } from "../components/api-failure.js";
import { PolicyProfileDraftForm } from "../components/policy-profile-draft-form.js";
import { PublicationWebhookLifecycleControl } from "../components/publication-webhook-lifecycle-control.js";
import { SourceScheduleLifecycleControl } from "../components/source-schedule-lifecycle-control.js";
import { AiConfigurationAuthoring } from "./ai-configuration-authoring.js";
import { ControlPlaneAuthoring } from "./control-plane-authoring.js";
import { DescriptorCatalog } from "./descriptor-catalog.js";
import { DiagnosticExportPanel } from "./diagnostic-export.js";
import { KnowledgeCollectionAuthoring } from "./knowledge-collection-authoring.js";
import { PrivacyPurgeDialog } from "./privacy-purge-dialog.js";
import { RoleAssignmentEditor } from "./role-assignment-editor.js";
import { SecretReferenceRegistration } from "./secret-reference-registration.js";
import { SourceScheduleDrafts } from "./source-schedule-drafts.js";

interface ResourcePanelProps {
  readonly resource: AdminResourceName;
  readonly title: string;
  readonly description: string;
  readonly configurationSurface?: ConfigurationSurface;
}

export type ResourceItemAction = Readonly<{
  readonly action:
    | "connector.activate"
    | "connector.disable"
    | "provider.activate"
    | "provider.disable"
    | "source.synchronize"
    | "source.fullRescan"
    | "secret.rotate"
    | "secret.revoke"
    | "dead-letter.retry"
    | "job.cancel"
    | "job.recover"
    | "publication.approve";
  readonly label: string;
}>;

export function itemActions(
  resource: AdminResourceName,
  item: AdminListItem,
  configurationSurface?: ConfigurationSurface,
): readonly ResourceItemAction[] {
  const actions: readonly ResourceItemAction[] = (() => {
    switch (resource) {
      case "connector-instances":
        return item.status === "active"
          ? [{ action: "connector.disable", label: "Disable" }]
          : [{ action: "connector.activate", label: "Activate" }];
      case "ai-provider-instances":
        return item.status === "active"
          ? [{ action: "provider.disable", label: "Disable" }]
          : [{ action: "provider.activate", label: "Activate" }];
      case "knowledge-sources":
        return item.status === "enabled"
          ? [
              { action: "source.synchronize", label: "Synchronize" },
              { action: "source.fullRescan", label: "Full rescan" },
            ]
          : [];
      case "secret-references":
        return item.status === "revoked"
          ? []
          : [
              { action: "secret.rotate", label: "Rotate" },
              { action: "secret.revoke", label: "Revoke" },
            ];
      case "dead-letters":
        return [{ action: "dead-letter.retry", label: "Retry" }];
      case "operation-jobs":
        return [
          { action: "job.cancel", label: "Cancel" },
          { action: "job.recover", label: "Recover" },
        ];
      case "publications":
        return item.status === "awaitingApproval"
          ? [{ action: "publication.approve", label: "Approve" }]
          : [];
      default:
        return [];
    }
  })();
  if (
    resource !== "connector-instances" &&
    resource !== "ai-provider-instances" &&
    resource !== "knowledge-sources" &&
    resource !== "publications"
  ) {
    return actions;
  }
  if (configurationSurface === undefined) return [];
  return actions.filter(({ action }) => {
    switch (action) {
      case "connector.activate":
      case "provider.activate":
        return (
          configurationSurface.mode === "managed" &&
          configurationSurface.workflows.includes("activate")
        );
      case "connector.disable":
      case "provider.disable":
        return (
          configurationSurface.mode === "managed" &&
          configurationSurface.workflows.includes("disable")
        );
      case "source.synchronize":
      case "source.fullRescan":
      case "publication.approve":
        return configurationSurface.operationalActions.includes(action);
      default:
        return false;
    }
  });
}

function supportsSourceScheduleLifecycle(
  resource: AdminResourceName,
  item: AdminListItem,
  configurationSurface: ConfigurationSurface | undefined,
): resource is "knowledge-sources" | "schedules" {
  if (resource !== "knowledge-sources" && resource !== "schedules")
    return false;
  if (configurationSurface?.mode !== "managed") return false;
  const workflow = item.status === "enabled" ? "disable" : "activate";
  return configurationSurface.workflows.includes(workflow);
}

function supportsPublicationWebhookLifecycle(
  resource: AdminResourceName,
  item: AdminListItem,
  configurationSurface: ConfigurationSurface | undefined,
): resource is "publication-profiles" | "webhook-endpoints" {
  if (resource !== "publication-profiles" && resource !== "webhook-endpoints") {
    return false;
  }
  if (configurationSurface?.mode !== "managed") return false;
  const workflow = item.status === "active" ? "disable" : "activate";
  return configurationSurface.workflows.includes(workflow);
}

/** Policy drafts have no browser fallback: the API must explicitly compose and
 * advertise the managed immutable-draft workflow for the resource. */
export function supportsPolicyProfileDraft(
  configurationSurface: ConfigurationSurface | undefined,
): boolean {
  return (
    configurationSurface?.mode === "managed" &&
    configurationSurface.workflows.includes("create_draft")
  );
}

export function ResourcePanel({
  resource,
  title,
  description,
  configurationSurface,
}: ResourcePanelProps) {
  const client = useApiClient();
  const { data, error, isLoading, refetch } = useGetList<AdminListItem>(
    resource,
    {
      pagination: { page: 1, perPage: 8 },
      sort: { field: "updatedAt", order: "DESC" },
      filter: {},
    },
  );

  return (
    <Paper
      component="section"
      elevation={0}
      sx={{ border: "1px solid", borderColor: "divider", minWidth: 0 }}
    >
      <Box sx={{ p: 2 }}>
        <Typography variant="overline">
          {resource.replaceAll("-", " / ")}
        </Typography>
        <Typography variant="h6">{title}</Typography>
        <Typography color="text.secondary" variant="body2">
          {description}
        </Typography>
      </Box>
      <Divider />
      {isLoading ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", p: 2 }}>
          <CircularProgress size={16} />
          <Typography variant="body2">Loading audited records…</Typography>
        </Stack>
      ) : null}
      {error === null || error === undefined ? null : (
        <Box sx={{ p: 2 }}>
          <ApiFailure error={error} retry={() => void refetch()} />
        </Box>
      )}
      {!isLoading &&
      (error === null || error === undefined) &&
      data?.length === 0 ? (
        <Box sx={{ p: 2 }}>
          <Typography color="text.secondary" variant="body2">
            No records were returned by the control plane.
          </Typography>
        </Box>
      ) : null}
      {data === undefined || data.length === 0 ? null : (
        <List dense disablePadding>
          {data.map((item) => (
            <ListItem
              alignItems="flex-start"
              disablePadding
              divider
              key={item.id}
              sx={{ flexWrap: "wrap" }}
            >
              <ListItemButton
                component="a"
                href={`#/${resource}/${item.id}/show`}
                sx={{ flex: "1 1 180px" }}
              >
                <ListItemText
                  primary={item.label}
                  secondary={
                    item.status === undefined
                      ? item.summary
                      : `${item.status}${item.version === undefined ? "" : ` · ${item.version}`}`
                  }
                />
              </ListItemButton>
              {itemActions(resource, item, configurationSurface).length ===
              0 ? null : (
                <Stack
                  direction="row"
                  spacing={0.5}
                  sx={{ alignItems: "center", p: 0.75 }}
                >
                  {itemActions(resource, item, configurationSurface).map(
                    ({ action, label }) => (
                      <ActionConfirmationDialog
                        action={action}
                        client={client}
                        key={action}
                        label={label}
                        target={{ resource, id: item.id }}
                      />
                    ),
                  )}
                </Stack>
              )}
              {supportsSourceScheduleLifecycle(
                resource,
                item,
                configurationSurface,
              ) ? (
                <Box sx={{ p: 0.75 }}>
                  <SourceScheduleLifecycleControl
                    client={client}
                    onCompleted={() => refetch().then(() => undefined)}
                    resource={resource}
                    resourceId={item.id}
                    status={item.status}
                  />
                </Box>
              ) : null}
              {supportsPublicationWebhookLifecycle(
                resource,
                item,
                configurationSurface,
              ) ? (
                <Box sx={{ p: 0.75 }}>
                  <PublicationWebhookLifecycleControl
                    client={client}
                    onCompleted={() => refetch().then(() => undefined)}
                    resource={resource}
                    resourceId={item.id}
                    status={item.status}
                  />
                </Box>
              ) : null}
              {resource === "privacy" && item.status === "eligible" ? (
                <Box sx={{ p: 0.75 }}>
                  <PrivacyPurgeDialog
                    client={client}
                    onCompleted={() => void refetch()}
                    snapshotId={item.id}
                  />
                </Box>
              ) : null}
            </ListItem>
          ))}
        </List>
      )}
      {configurationSurface === undefined ||
      configurationSurface.mode === "managed" ? null : (
        <Box sx={{ p: 2 }}>
          <Typography color="text.secondary" variant="body2">
            {configurationSurface.reason ??
              "This configuration surface is not available in this deployment."}
          </Typography>
        </Box>
      )}
    </Paper>
  );
}

const sectionResources = {
  overview: [
    [
      "overview",
      "System pulse",
      "Bounded health, work, budget, and audit signals.",
    ],
  ],
  integrations: [
    [
      "secret-references",
      "Secret references",
      "External-secret metadata and lifecycle only; values are never displayed.",
    ],
    [
      "connector-instances",
      "Connector instances",
      "Versioned connectors and health.",
    ],
    [
      "knowledge-sources",
      "Knowledge sources",
      "Source state and latest synchronization.",
    ],
    ["schedules", "Schedules", "Due work and bounded trigger policy."],
    [
      "webhook-endpoints",
      "Webhooks",
      "Opaque endpoints and verified delivery health.",
    ],
  ],
  ai: [
    [
      "ai-provider-instances",
      "Provider instances",
      "Configured runtime endpoints.",
    ],
    ["ai-bindings", "Model bindings", "Immutable role bindings and versions."],
    [
      "ai-catalog-snapshots",
      "Catalog snapshots",
      "Registered provider-neutral catalog records.",
    ],
    [
      "ai-role-defaults",
      "Role defaults",
      "Resolved defaults from immutable bindings.",
    ],
    [
      "ai-pricing-overrides",
      "Pricing",
      "Effective pricing and unknown-price states.",
    ],
    ["ai-budgets", "Budgets", "Hard and soft budget policy."],
  ],
  knowledge: [
    ["collections", "Collections", "Embedding spaces and indexed knowledge."],
    ["retrieval-profiles", "Retrieval profiles", "Bounded evidence policy."],
    ["prompt-profiles", "Prompt profiles", "Versioned prompt constraints."],
    [
      "analysis-profiles",
      "Analysis profiles",
      "Immutable analysis configuration.",
    ],
    ["analyses", "Analyses", "Durable analysis records and snapshots."],
  ],
  publication: [
    [
      "publication-profiles",
      "Publication profiles",
      "Versioned destination policy.",
    ],
    [
      "publications",
      "Publication state",
      "Intents, approvals, attempts, and receipts.",
    ],
  ],
  operations: [
    ["operation-jobs", "Jobs", "Leased work and recovery state."],
    [
      "dead-letters",
      "Dead letters",
      "Failed work requiring controlled recovery.",
    ],
    ["costs", "Costs", "Attributed and unknown-price operation costs."],
    [
      "retention",
      "Retention",
      "Server-owned retention state and bounded reaping.",
    ],
    ["privacy", "Privacy", "Tombstoned records and controlled deletion state."],
    [
      "diagnostics",
      "Diagnostics",
      "Redacted, server-generated diagnostic posture.",
    ],
    ["audit-events", "Audit", "Append-only administrative activity."],
  ],
  access: [
    ["workspaces", "Workspaces", "Server-authorized workspace membership."],
    ["principals", "Principals", "Resolved operator identities."],
    ["role-assignments", "Role assignments", "Permission-bearing assignments."],
  ],
  platform: [
    [
      "platform",
      "Runtime capability",
      "Deployment-owned configuration and readiness.",
    ],
  ],
} satisfies Readonly<
  Record<string, readonly [AdminResourceName, string, string][]>
>;

export function SectionPage({
  section,
  title,
  lead,
}: {
  readonly section: keyof typeof sectionResources;
  readonly title: string;
  readonly lead: string;
}) {
  const client = useApiClient();
  const refresh = useRefresh();
  const [secretReferenceRefresh, setSecretReferenceRefresh] = useState(0);
  const [configurationSurfaces, setConfigurationSurfaces] =
    useState<readonly ConfigurationSurface[]>();
  useEffect(() => {
    const abort = new AbortController();
    void client
      .configurationSurfaces(abort.signal)
      .then(setConfigurationSurfaces)
      // An unavailable registry must never fabricate a client-side workflow.
      .catch(() => setConfigurationSurfaces(undefined));
    return () => abort.abort();
  }, [client]);
  const surfaceFor = (resource: AdminResourceName) =>
    configurationSurfaces?.find((surface) => surface.surface === resource);
  const connectorSurface = surfaceFor("connector-instances");
  const providerSurface = surfaceFor("ai-provider-instances");
  const sourceSurface = surfaceFor("knowledge-sources");
  const scheduleSurface = surfaceFor("schedules");
  const publicationProfileSurface = surfaceFor("publication-profiles");
  const webhookEndpointSurface = surfaceFor("webhook-endpoints");
  const aiBindingSurface = surfaceFor("ai-bindings");
  const aiRoleDefaultSurface = surfaceFor("ai-role-defaults");
  const aiPricingSurface = surfaceFor("ai-pricing-overrides");
  const aiBudgetSurface = surfaceFor("ai-budgets");
  const collectionSurface = surfaceFor("collections");
  const retrievalProfileSurface = surfaceFor("retrieval-profiles");
  const promptProfileSurface = surfaceFor("prompt-profiles");
  const platformSurface = surfaceFor("platform");
  const retrievalProfileDraftEnabled = supportsPolicyProfileDraft(
    retrievalProfileSurface,
  );
  const promptProfileDraftEnabled =
    supportsPolicyProfileDraft(promptProfileSurface);
  return (
    <Stack spacing={3} sx={{ maxWidth: 1480 }}>
      <Box>
        <Typography variant="overline">CaseWeaver / control plane</Typography>
        <Typography variant="h3">{title}</Typography>
        <Typography
          color="text.secondary"
          sx={{ maxWidth: 760 }}
          variant="body1"
        >
          {lead}
        </Typography>
      </Box>
      {section === "knowledge" ? (
        <Alert
          action={
            <Button component="a" href="#/collections" size="small">
              Open collections
            </Button>
          }
          severity="info"
        >
          Create a workspace-scoped collection here, then use it in an
          integration source draft. The Collections screen lists the immutable
          spaces already created in this workspace.
        </Alert>
      ) : null}
      {section === "knowledge" ? (
        <KnowledgeCollectionAuthoring
          enabled={
            collectionSurface?.mode === "managed" &&
            collectionSurface.workflows.includes("create")
          }
          onCreated={() => refresh()}
        />
      ) : null}
      {section === "integrations" || section === "ai" ? (
        <SecretReferenceRegistration
          onRegistered={() =>
            setSecretReferenceRefresh((current) => current + 1)
          }
        />
      ) : null}
      {section === "integrations" && connectorSurface?.mode === "managed" ? (
        <DescriptorCatalog
          key={`connector-${secretReferenceRefresh}`}
          kind="connector"
          title="Connector configuration drafts"
        />
      ) : null}
      {section === "integrations" ? (
        <SourceScheduleDrafts
          scheduleEnabled={
            scheduleSurface?.mode === "managed" &&
            scheduleSurface.workflows.includes("create_draft")
          }
          sourceEnabled={
            sourceSurface?.mode === "managed" &&
            sourceSurface.workflows.includes("create_draft")
          }
        />
      ) : null}
      {section === "integrations" ||
      section === "publication" ||
      section === "platform" ? (
        <ControlPlaneAuthoring
          client={client}
          key={`control-plane-authoring-${secretReferenceRefresh}`}
          onCompleted={() => refresh()}
          platformEnabled={
            section === "platform" &&
            platformSurface?.mode === "managed" &&
            platformSurface.workflows.includes("create_draft")
          }
          publicationEnabled={
            section === "publication" &&
            publicationProfileSurface?.mode === "managed" &&
            publicationProfileSurface.workflows.includes("create_draft")
          }
          webhookEnabled={
            section === "integrations" &&
            webhookEndpointSurface?.mode === "managed" &&
            webhookEndpointSurface.workflows.includes("create_draft")
          }
        />
      ) : null}
      {section === "ai" && providerSurface?.mode === "managed" ? (
        <DescriptorCatalog
          key={`ai-provider-${secretReferenceRefresh}`}
          kind="ai-provider"
          title="AI provider configuration drafts"
        />
      ) : null}
      {section === "ai" ? (
        <AiConfigurationAuthoring
          bindingsEnabled={
            aiBindingSurface?.mode === "managed" &&
            aiBindingSurface.workflows.includes("create_draft")
          }
          budgetsEnabled={
            aiBudgetSurface?.mode === "managed" &&
            aiBudgetSurface.workflows.includes("replace")
          }
          pricingEnabled={
            aiPricingSurface?.mode === "managed" &&
            aiPricingSurface.workflows.includes("create")
          }
          rolesEnabled={
            aiRoleDefaultSurface?.mode === "managed" &&
            aiRoleDefaultSurface.workflows.includes("replace")
          }
        />
      ) : null}
      {section === "knowledge" &&
      (retrievalProfileDraftEnabled || promptProfileDraftEnabled) ? (
        <Stack spacing={3}>
          {retrievalProfileDraftEnabled ? (
            <PolicyProfileDraftForm
              client={client}
              onCompleted={() => refresh()}
              resource="retrieval-profiles"
            />
          ) : null}
          {promptProfileDraftEnabled ? (
            <PolicyProfileDraftForm
              client={client}
              onCompleted={() => refresh()}
              resource="prompt-profiles"
            />
          ) : null}
        </Stack>
      ) : null}
      {section === "operations" ? <DiagnosticExportPanel /> : null}
      {section === "access" ? <RoleAssignmentEditor /> : null}
      {section === "operations" ? (
        <Paper
          component="section"
          elevation={0}
          sx={{ border: "1px solid", borderColor: "divider", p: 2 }}
        >
          <Typography variant="overline">Guarded operation</Typography>
          <Typography gutterBottom variant="h6">
            Queue retention reap
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 2 }} variant="body2">
            Confirmation remains disabled until the API returns a durable impact
            preview.
          </Typography>
          <ActionConfirmationDialog
            action="retention.reap"
            client={client}
            label="Request retention preview"
            target={{ resource: "platform" }}
          />
        </Paper>
      ) : null}
      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 330px), 1fr))",
        }}
      >
        {sectionResources[section].map(
          ([resource, resourceTitle, description]) => (
            <ResourcePanel
              description={description}
              key={resource}
              resource={resource}
              configurationSurface={surfaceFor(resource)}
              title={resourceTitle}
            />
          ),
        )}
      </Box>
    </Stack>
  );
}
