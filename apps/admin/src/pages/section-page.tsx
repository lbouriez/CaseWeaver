import {
  Box,
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
import { useGetList } from "react-admin";
import { useApiClient } from "../api/context.js";
import type { AdminListItem, AdminResourceName } from "../api/contracts.js";
import { ActionConfirmationDialog } from "../components/action-confirmation-dialog.js";
import { ApiFailure } from "../components/api-failure.js";
import { DescriptorCatalog } from "./descriptor-catalog.js";

interface ResourcePanelProps {
  readonly resource: AdminResourceName;
  readonly title: string;
  readonly description: string;
}

export function ResourcePanel({
  resource,
  title,
  description,
}: ResourcePanelProps) {
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
            <ListItem disablePadding divider key={item.id}>
              <ListItemButton
                component="a"
                href={`#/${resource}/${item.id}/show`}
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
            </ListItem>
          ))}
        </List>
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
      {section === "integrations" ? (
        <DescriptorCatalog
          kind="connector"
          title="Connector configuration drafts"
        />
      ) : null}
      {section === "ai" ? (
        <DescriptorCatalog
          kind="ai-provider"
          title="AI provider configuration drafts"
        />
      ) : null}
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
              title={resourceTitle}
            />
          ),
        )}
      </Box>
    </Stack>
  );
}
