import {
  Box,
  Button,
  CircularProgress,
  CssBaseline,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  AppBar,
  type AppBarProps,
  CustomRoutes,
  Layout,
  type LayoutProps,
  Admin as ReactAdmin,
  Resource,
  type ResourceProps,
  useAuthProvider,
  useLogin,
  usePermissions,
  useRefresh,
} from "react-admin";
import { Link, Route } from "react-router-dom";

import { CaseWeaverApiClient } from "./api/api-client.js";
import type { AuthenticatedSession, Session } from "./api/contracts.js";
import { ApiClientProvider } from "./api/context.js";
import { createDataProvider } from "./api/data-provider.js";
import {
  createSessionAuthProvider,
  type SessionAuthProvider,
} from "./auth/auth-provider.js";
import { visibleNavigation } from "./pages/navigation.js";
import {
  AdminResourceList,
  AdminResourceShow,
} from "./pages/resource-pages.js";
import { SectionPage } from "./pages/section-page.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { operatorTheme } from "./theme.js";

function OperatorSignInCard({
  authentication,
  onOauthLogin,
  onPasswordLogin,
  onRetry,
  unavailable = false,
}: {
  readonly authentication?: Extract<
    Session,
    { readonly authenticated: false }
  >["authentication"];
  readonly onOauthLogin?: () => void;
  readonly onPasswordLogin?: (login: string, password: string) => Promise<void>;
  readonly onRetry?: () => void;
  readonly unavailable?: boolean;
}) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (onPasswordLogin === undefined || submitting) return;
    setSubmitting(true);
    setFailed(false);
    void onPasswordLogin(login, password)
      .catch(() => setFailed(true))
      .finally(() => {
        setPassword("");
        setSubmitting(false);
      });
  };
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
        <Typography variant="h3">
          {unavailable ? "Console unavailable." : "Enter the control room."}
        </Typography>
        <Typography color="text.secondary">
          {unavailable
            ? "The control-plane session could not be checked. Retry when the API is available."
            : "Authentication is handled by the CaseWeaver API. This browser retains only the server-managed session cookie and never an OAuth token."}
        </Typography>
        {unavailable ? (
          <Button onClick={onRetry} variant="contained">
            Retry session check
          </Button>
        ) : null}
        {authentication?.password && onPasswordLogin !== undefined ? (
          <Box component="form" noValidate onSubmit={submitPassword}>
            <Stack spacing={1.5}>
              <TextField
                autoComplete="username"
                autoFocus
                disabled={submitting}
                label="Login"
                onChange={(event) => setLogin(event.target.value)}
                required
                value={login}
              />
              <TextField
                autoComplete="current-password"
                disabled={submitting}
                label="Password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
              <Button disabled={submitting} type="submit" variant="contained">
                Sign in
              </Button>
              {failed ? (
                <Typography color="error" role="alert" variant="caption">
                  Sign in was not completed. Check the login and password.
                </Typography>
              ) : null}
            </Stack>
          </Box>
        ) : null}
        {authentication?.oauth && onOauthLogin !== undefined ? (
          <Button onClick={onOauthLogin} variant="outlined">
            Continue with configured identity provider
          </Button>
        ) : null}
        {authentication !== undefined &&
        !authentication.password &&
        !authentication.oauth ? (
          <Typography color="error" variant="body2">
            No sign-in method is enabled for this console.
          </Typography>
        ) : null}
      </Stack>
    </Box>
  );
}

function OperatorLoginPage() {
  const login = useLogin();
  return <OperatorSignInCard onOauthLogin={() => void login({})} />;
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
  onSignOut,
  ...props
}: AppBarProps & {
  readonly title: string;
  readonly onSignOut: () => Promise<void>;
}) {
  return (
    <AppBar {...props} color="transparent" elevation={0}>
      <Box
        sx={{
          alignItems: "center",
          display: "flex",
          gap: 2,
          justifyContent: "space-between",
          minWidth: 0,
          width: "100%",
        }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <Typography noWrap variant="overline">
            CaseWeaver / self-hosted operator console
          </Typography>
          <Typography noWrap variant="h6">
            {title}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <WorkspaceSwitcher />
          <OperatorSignOutButton onSignOut={onSignOut} />
        </Stack>
      </Box>
    </AppBar>
  );
}

function OperatorSignOutButton({
  onSignOut,
}: {
  readonly onSignOut: () => Promise<void>;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <Stack spacing={0.25} sx={{ alignItems: "flex-end" }}>
      <Button
        aria-label="Sign out"
        disabled={signingOut}
        onClick={() => {
          setSigningOut(true);
          setFailed(false);
          void onSignOut()
            .catch(() => setFailed(true))
            .finally(() => setSigningOut(false));
        }}
        size="small"
        variant="outlined"
      >
        Sign out
      </Button>
      {failed ? (
        <Typography color="error" variant="caption">
          Sign out was not completed.
        </Typography>
      ) : null}
    </Stack>
  );
}

/** Server-authorized workspace selector; the browser does not grant itself access. */
function WorkspaceSwitcher() {
  const provider = useAuthProvider() as SessionAuthProvider;
  const refresh = useRefresh();
  const [session, setSession] = useState<AuthenticatedSession>();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    void provider.currentSession().then((value) => {
      if (active) setSession(value);
    });
    return () => {
      active = false;
    };
  }, [provider]);

  if (session === undefined || session.workspaces.length < 2) return null;
  return (
    <Stack spacing={0.25}>
      <Select
        aria-label="Active workspace"
        disabled={switching}
        onChange={(event) => {
          setSwitching(true);
          setError(false);
          void provider
            .switchWorkspace(String(event.target.value))
            .then((next) => {
              setSession(next);
              refresh();
            })
            .catch(() => setError(true))
            .finally(() => setSwitching(false));
        }}
        size="small"
        value={session.activeWorkspace.id}
      >
        {session.workspaces.map((workspace) => (
          <MenuItem key={workspace.id} value={workspace.id}>
            {workspace.name}
          </MenuItem>
        ))}
      </Select>
      {error ? (
        <Typography color="error" variant="caption">
          Workspace switch was not completed.
        </Typography>
      ) : null}
    </Stack>
  );
}

function createOperatorLayout(title: string, onSignOut: () => Promise<void>) {
  function AppBarWithTitle(props: AppBarProps) {
    return <OperatorAppBar {...props} onSignOut={onSignOut} title={title} />;
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
  "secret-references",
  "connector-instances",
  "knowledge-sources",
  "schedules",
  "publication-profiles",
  "webhook-endpoints",
  "ai-provider-instances",
  "ai-catalog-snapshots",
  "ai-models",
  "ai-bindings",
  "ai-role-defaults",
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
  "retention",
  "privacy",
  "diagnostics",
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
  useEffect(() => {
    document.title = config.uiTitle;
  }, [config.uiTitle]);

  return (
    <ApiClientProvider client={client}>
      <CssBaseline />
      <OperatorSessionGate
        authProvider={authProvider}
        client={client}
        renderAuthenticated={(onSignOut) => (
          <AdminShell
            authProvider={authProvider}
            config={config}
            dataProvider={dataProvider}
            onSignOut={onSignOut}
          />
        )}
      />
    </ApiClientProvider>
  );
}

type SessionGateClient = Pick<CaseWeaverApiClient, "session">;
type SessionGateAuth = Pick<
  SessionAuthProvider,
  "login" | "logout" | "passwordLogin"
>;

type SessionGateState =
  | { readonly phase: "checking" }
  | {
      readonly phase: "anonymous";
      readonly authentication: Extract<
        Session,
        { readonly authenticated: false }
      >["authentication"];
    }
  | { readonly phase: "authenticated" }
  | { readonly phase: "unavailable" };

/**
 * The console owns the initial cookie-session decision before React-Admin mounts.
 * React-Admin retains its normal server-backed authorization checks afterwards.
 */
export function OperatorSessionGate({
  authProvider,
  client,
  renderAuthenticated,
}: {
  readonly authProvider: SessionGateAuth;
  readonly client: SessionGateClient;
  readonly renderAuthenticated: (onSignOut: () => Promise<void>) => ReactNode;
}) {
  const [state, setState] = useState<SessionGateState>({ phase: "checking" });

  const checkSession = useCallback(async () => {
    setState({ phase: "checking" });
    try {
      const session = await client.session();
      setState(
        session.authenticated
          ? { phase: "authenticated" }
          : { phase: "anonymous", authentication: session.authentication },
      );
    } catch {
      setState({ phase: "unavailable" });
    }
  }, [client]);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  const signOut = useCallback(async () => {
    await authProvider.logout({});
    await checkSession();
  }, [authProvider, checkSession]);
  const passwordLogin = useCallback(
    async (login: string, password: string) => {
      await authProvider.passwordLogin(login, password);
      setState({ phase: "authenticated" });
    },
    [authProvider],
  );

  if (state.phase === "checking") {
    return (
      <Box
        aria-label="Checking operator session"
        sx={{
          alignItems: "center",
          display: "flex",
          justifyContent: "center",
          minHeight: "100vh",
        }}
      >
        <CircularProgress />
      </Box>
    );
  }
  if (state.phase === "anonymous") {
    return (
      <OperatorSignInCard
        authentication={state.authentication}
        onOauthLogin={
          state.authentication.oauth
            ? () => void authProvider.login({})
            : undefined
        }
        onPasswordLogin={
          state.authentication.password ? passwordLogin : undefined
        }
      />
    );
  }
  if (state.phase === "unavailable") {
    return (
      <OperatorSignInCard onRetry={() => void checkSession()} unavailable />
    );
  }
  return renderAuthenticated(signOut);
}

function AdminShell({
  authProvider,
  config,
  dataProvider,
  onSignOut,
}: {
  readonly authProvider: ReturnType<typeof createSessionAuthProvider>;
  readonly config: RuntimeConfig;
  readonly dataProvider: ReturnType<typeof createDataProvider>;
  readonly onSignOut: () => Promise<void>;
}) {
  const layout = useMemo(
    () => createOperatorLayout(config.uiTitle, onSignOut),
    [config.uiTitle, onSignOut],
  );
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
              lead="Create registered connector drafts and inspect source, schedule, publication, and webhook state. The control plane labels every unavailable or deployment-owned workflow explicitly."
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
