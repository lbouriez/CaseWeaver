import {
  Box,
  Button,
  CircularProgress,
  CssBaseline,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useMemo } from "react";
import {
  AppBar,
  type AppBarProps,
  CustomRoutes,
  Layout,
  type LayoutProps,
  Admin as ReactAdmin,
  Resource,
  type ResourceProps,
  useLogin,
  usePermissions,
} from "react-admin";
import { Link, Route } from "react-router-dom";

import { CaseWeaverApiClient } from "./api/api-client.js";
import { ApiClientProvider } from "./api/context.js";
import { createDataProvider } from "./api/data-provider.js";
import { createSessionAuthProvider } from "./auth/auth-provider.js";
import { visibleNavigation } from "./pages/navigation.js";
import {
  AdminResourceList,
  AdminResourceShow,
} from "./pages/resource-pages.js";
import { SectionPage } from "./pages/section-page.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { operatorTheme } from "./theme.js";

function OperatorLoginPage() {
  const login = useLogin();
  return (
    <Box
      sx={{
        alignItems: "center",
        display: "flex",
        justifyContent: "center",
        minHeight: "100vh",
        p: 3,
      }}
    >
      <Stack
        spacing={2}
        sx={{
          border: "1px solid",
          borderColor: "divider",
          maxWidth: 480,
          p: { xs: 3, md: 5 },
          width: "100%",
        }}
      >
        <Typography variant="overline">
          CaseWeaver / authorized operators only
        </Typography>
        <Typography variant="h3">Enter the control room.</Typography>
        <Typography color="text.secondary">
          Authentication is initiated by the CaseWeaver API. This browser never
          handles an OAuth token or identity-provider credential.
        </Typography>
        <Button onClick={() => void login({})} variant="contained">
          Continue with configured identity provider
        </Button>
      </Stack>
    </Box>
  );
}

function OperatorMenu() {
  const { permissions, isLoading } = usePermissions<readonly string[]>();
  const sections = visibleNavigation(permissions);

  return (
    <Box
      component="nav"
      aria-label="Control room sections"
      sx={{ display: "grid", gap: 0.5, p: 1.25 }}
    >
      {isLoading ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", px: 1 }}>
          <CircularProgress size={14} />
          <Typography variant="caption">Resolving access…</Typography>
        </Stack>
      ) : null}
      {sections.map((section) => (
        <Button
          component={Link}
          key={section.path}
          sx={{
            alignItems: "flex-start",
            color: "text.secondary",
            justifyContent: "flex-start",
            px: 1,
            textAlign: "left",
          }}
          to={section.path}
          variant="text"
        >
          <Box>
            <Typography
              component="span"
              sx={{ display: "block" }}
              variant="overline"
            >
              {section.kicker}
            </Typography>
            {section.label}
          </Box>
        </Button>
      ))}
    </Box>
  );
}

function OperatorAppBar({
  title,
  ...props
}: AppBarProps & { readonly title: string }) {
  return (
    <AppBar {...props} color="transparent" elevation={0}>
      <Box sx={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Typography noWrap variant="overline">
          CaseWeaver / self-hosted operator console
        </Typography>
        <Typography noWrap variant="h6">
          {title}
        </Typography>
      </Box>
    </AppBar>
  );
}

function createOperatorLayout(title: string) {
  function AppBarWithTitle(props: AppBarProps) {
    return <OperatorAppBar {...props} title={title} />;
  }

  function OperatorLayout(props: LayoutProps) {
    return <Layout {...props} appBar={AppBarWithTitle} menu={OperatorMenu} />;
  }
  return OperatorLayout;
}

function Overview() {
  return (
    <SectionPage
      lead="A compact, server-audited view of queue health, operator signals, and budget conditions. Rendering this page never invokes a connector or model."
      section="overview"
      title="System pulse"
    />
  );
}

const resources: readonly ResourceProps[] = [
  "connector-instances",
  "knowledge-sources",
  "schedules",
  "publication-profiles",
  "webhook-endpoints",
  "ai-provider-instances",
  "ai-models",
  "ai-bindings",
  "ai-pricing-overrides",
  "ai-budgets",
  "collections",
  "retrieval-profiles",
  "prompt-profiles",
  "analysis-profiles",
  "analyses",
  "publications",
  "operation-jobs",
  "dead-letters",
  "costs",
  "audit-events",
  "workspaces",
  "principals",
  "role-assignments",
].map((name) => ({
  name,
  list: AdminResourceList,
  show: AdminResourceShow,
  options: { menu: false },
}));

export function OperatorApp({ config }: { readonly config: RuntimeConfig }) {
  const client = useMemo(() => new CaseWeaverApiClient(config), [config]);
  const authProvider = useMemo(
    () => createSessionAuthProvider(client),
    [client],
  );
  const dataProvider = useMemo(() => createDataProvider(client), [client]);
  const layout = useMemo(
    () => createOperatorLayout(config.uiTitle),
    [config.uiTitle],
  );

  useEffect(() => {
    document.title = config.uiTitle;
  }, [config.uiTitle]);

  return (
    <ApiClientProvider client={client}>
      <CssBaseline />
      <AdminShell
        authProvider={authProvider}
        config={config}
        dataProvider={dataProvider}
        layout={layout}
      />
    </ApiClientProvider>
  );
}

function AdminShell({
  authProvider,
  config,
  dataProvider,
  layout,
}: {
  readonly authProvider: ReturnType<typeof createSessionAuthProvider>;
  readonly config: RuntimeConfig;
  readonly dataProvider: ReturnType<typeof createDataProvider>;
  readonly layout: ReturnType<typeof createOperatorLayout>;
}) {
  return (
    <ReactAdmin
      authProvider={authProvider}
      dashboard={Overview}
      dataProvider={dataProvider}
      disableTelemetry
      layout={layout}
      loginPage={OperatorLoginPage}
      requireAuth
      theme={operatorTheme}
      title={config.uiTitle}
    >
      {resources.map((resource) => (
        <Resource {...resource} key={resource.name} />
      ))}
      <CustomRoutes>
        <Route
          element={
            <SectionPage
              lead="Configure registered connectors, knowledge sources, schedules, publication profiles, and verified webhook endpoints through the API."
              section="integrations"
              title="Integrations"
            />
          }
          path="/integrations"
        />
        <Route
          element={
            <SectionPage
              lead="Discover configured provider instances, immutable bindings, pricing state, and budget policy without contacting a provider from the browser."
              section="ai"
              title="AI configuration"
            />
          }
          path="/ai"
        />
        <Route
          element={
            <SectionPage
              lead="Inspect collections, source synchronization, retrieval profiles, prompts, analysis profiles, and immutable analysis records."
              section="knowledge"
              title="Knowledge & Analysis"
            />
          }
          path="/knowledge-analysis"
        />
        <Route
          element={
            <SectionPage
              lead="Review destination policy, publication intents, approvals, attempts, receipts, and reconciliation state."
              section="publication"
              title="Publication"
            />
          }
          path="/publication"
        />
        <Route
          element={
            <SectionPage
              lead="Observe durable work, dead letters, costs, retention, privacy, diagnostics, and auditable recovery."
              section="operations"
              title="Operations"
            />
          }
          path="/operations"
        />
        <Route
          element={
            <SectionPage
              lead="Inspect server-resolved workspaces, principals, role assignments, and the effective authority surface."
              section="access"
              title="Access"
            />
          }
          path="/access"
        />
        <Route
          element={
            <SectionPage
              lead="View deployment-owned public URLs, authentication posture, runtime capability, and readiness without exposing secrets."
              section="platform"
              title="Platform"
            />
          }
          path="/platform"
        />
      </CustomRoutes>
    </ReactAdmin>
  );
}
