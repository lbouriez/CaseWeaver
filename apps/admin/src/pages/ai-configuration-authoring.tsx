import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApiClient } from "../api/context.js";
import type { AdminDetail, AdminListItem } from "../api/contracts.js";
import { ApiFailure } from "../components/api-failure.js";
import { AuthoringFieldLabel } from "../components/authoring-field-label.js";

const roles = [
  "embedding",
  "vision",
  "analysis",
  "repositoryAgent",
  "keywordExtraction",
  "reranker",
  "chat",
] as const;

type AiRole = (typeof roles)[number];
type Lists = Readonly<{
  readonly providers: readonly AdminListItem[];
  readonly snapshots: readonly AdminListItem[];
  readonly models: readonly AdminListItem[];
  readonly bindings: readonly AdminListItem[];
  readonly defaults: readonly AdminListItem[];
  readonly budgets: readonly AdminListItem[];
}>;

function revision(value: string | undefined, fallback = 0): number {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : fallback;
}

function active(items: readonly AdminListItem[]): readonly AdminListItem[] {
  return items.filter((item) => item.status === "active");
}

/**
 * Resource-specific AI controls. Every select is populated by API read models;
 * the browser never receives endpoint, wire API, parameters, pricing rules,
 * resolved credentials, or a provider/model-name branch.
 */
export function AiConfigurationAuthoring({
  bindingsEnabled,
  rolesEnabled,
  pricingEnabled,
  budgetsEnabled,
}: {
  readonly bindingsEnabled: boolean;
  readonly rolesEnabled: boolean;
  readonly pricingEnabled: boolean;
  readonly budgetsEnabled: boolean;
}) {
  const client = useApiClient();
  const [lists, setLists] = useState<Lists>();
  const [loadError, setLoadError] = useState<unknown>();
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [snapshotId, setSnapshotId] = useState("");
  const [model, setModel] = useState("");
  const [role, setRole] = useState<AiRole>("analysis");
  const [inputTokens, setInputTokens] = useState("");
  const [outputTokens, setOutputTokens] = useState("");
  const [defaultBindingVersionId, setDefaultBindingVersionId] = useState("");
  const [defaultRole, setDefaultRole] = useState<AiRole>("analysis");
  const [priceModel, setPriceModel] = useState("");
  const [priceAmount, setPriceAmount] = useState("0.001");
  const [priceCurrency, setPriceCurrency] = useState("USD");
  const [budgetId, setBudgetId] = useState("");
  const [budgetScope, setBudgetScope] = useState<
    "operation" | "analysis" | "day" | "workspace"
  >("workspace");
  const [budgetScopeKey, setBudgetScopeKey] = useState("workspace");
  const [budgetAmount, setBudgetAmount] = useState("10");
  const [budgetCurrency, setBudgetCurrency] = useState("USD");
  const [budgetHard, setBudgetHard] = useState(true);
  const [testProviderId, setTestProviderId] = useState("");
  const [testOperation, setTestOperation] = useState<string>();
  const [createdBinding, setCreatedBinding] = useState<AdminDetail>();
  const [successorBindingId, setSuccessorBindingId] = useState("");
  const [confirmation, setConfirmation] =
    useState<
      Readonly<{
        readonly providerId: string;
        readonly operation: string;
        readonly confirmationId: string;
        readonly impact: string;
      }>
    >();

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const [providers, snapshots, models, bindings, defaults, budgets] =
        await Promise.all([
          client.list("ai-provider-instances", { limit: 200 }, { signal }),
          client.list("ai-catalog-snapshots", { limit: 200 }, { signal }),
          client.list("ai-models", { limit: 200 }, { signal }),
          client.list("ai-bindings", { limit: 200 }, { signal }),
          client.list("ai-role-defaults", { limit: 200 }, { signal }),
          client.list("ai-budgets", { limit: 200 }, { signal }),
        ]);
      const next = Object.freeze({
        providers: providers.items,
        snapshots: snapshots.items,
        models: models.items,
        bindings: bindings.items,
        defaults: defaults.items,
        budgets: budgets.items,
      });
      setLists(next);
      const availableProviders = active(next.providers);
      setProviderId((current) =>
        availableProviders.some((item) => item.id === current)
          ? current
          : (availableProviders[0]?.id ?? ""),
      );
      setTestProviderId((current) =>
        availableProviders.some((item) => item.id === current)
          ? current
          : (availableProviders[0]?.id ?? ""),
      );
      setSnapshotId((current) =>
        next.snapshots.some((item) => item.id === current)
          ? current
          : (next.snapshots[0]?.id ?? ""),
      );
      setModel((current) =>
        next.models.some((item) => item.label === current)
          ? current
          : (next.models[0]?.label ?? ""),
      );
      setPriceModel((current) =>
        next.models.some((item) => item.label === current)
          ? current
          : (next.models[0]?.label ?? ""),
      );
    },
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(undefined);
    void reload(controller.signal).catch((nextError: unknown) => {
      if (!controller.signal.aborted) setLoadError(nextError);
    });
    return () => controller.abort();
  }, [reload]);

  const chosenPriceModel = useMemo(
    () => lists?.models.find((item) => item.label === priceModel),
    [lists?.models, priceModel],
  );
  const selectedBudget = lists?.budgets.find((item) => item.id === budgetId);

  const submit = async (operation: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await operation());
      await reload();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  const requestCapabilityPreview = async () => {
    if (testProviderId.length === 0) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    setConfirmation(undefined);
    try {
      const operations =
        await client.providerCapabilityTestOperations(testProviderId);
      const operation = operations.items[0]?.operation;
      if (operation === undefined)
        throw new Error("No provider test is registered.");
      setTestOperation(operation);
      const preview = await client.previewProviderCapabilityTest(
        testProviderId,
        operation,
      );
      if (
        !preview.canConfirm ||
        preview.confirmationId === undefined ||
        preview.impact === undefined
      ) {
        setResult(
          preview.reasonCode === "pricing.unknown"
            ? "The server denied this test because price is unknown."
            : "The server denied this test because no active budget policy applies.",
        );
        return;
      }
      setConfirmation({
        providerId: testProviderId,
        operation,
        confirmationId: preview.confirmationId,
        impact: preview.impact,
      });
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  if (!bindingsEnabled && !rolesEnabled && !pricingEnabled && !budgetsEnabled) {
    return null;
  }
  return (
    <Stack spacing={3}>
      {loadError === undefined ? null : <ApiFailure error={loadError} />}
      {error === undefined ? null : <ApiFailure error={error} />}
      {result === undefined ? null : <Alert severity="success">{result}</Alert>}
      {bindingsEnabled ? (
        <Paper
          component="section"
          elevation={0}
          sx={{ border: "1px solid", borderColor: "divider", p: 2 }}
        >
          <Stack spacing={2}>
            <Box>
              <Typography variant="overline">
                Immutable model binding
              </Typography>
              <Typography variant="h5">Create a model binding draft</Typography>
              <Typography color="text.secondary" variant="body2">
                Provider and catalog identifiers are selected from audited read
                models. The server resolves all runtime-only values and
                validates provider/model compatibility.
              </Typography>
            </Box>
            <TextField
              label="Active provider instance"
              onChange={(event) => setProviderId(event.target.value)}
              select
              value={providerId}
            >
              <MenuItem disabled value="">
                Select an active provider
              </MenuItem>
              {active(lists?.providers ?? []).map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Catalog snapshot"
              onChange={(event) => setSnapshotId(event.target.value)}
              select
              value={snapshotId}
            >
              <MenuItem disabled value="">
                Select a catalog snapshot
              </MenuItem>
              {(lists?.snapshots ?? []).map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Catalog model"
              onChange={(event) => setModel(event.target.value)}
              select
              value={model}
            >
              <MenuItem disabled value="">
                Select a catalog model
              </MenuItem>
              {(lists?.models ?? []).map((item) => (
                <MenuItem key={item.id} value={item.label}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
            <AuthoringFieldLabel
              description="A CaseWeaver role describes the capability this immutable binding may serve. The API validates the selected server-discovered provider, catalog model, and role together."
              label="Binding role"
            />
            <TextField
              label="Role"
              onChange={(event) => setRole(event.target.value as AiRole)}
              select
              value={role}
            >
              {roles.map((entry) => (
                <MenuItem key={entry} value={entry}>
                  {entry}
                </MenuItem>
              ))}
            </TextField>
            <AuthoringFieldLabel
              description="An optional upper bound on input tokens for calls through this binding. Leave it empty only when the server-side binding policy permits an unbounded input limit."
              label="Maximum input tokens"
            />
            <TextField
              label="Maximum input tokens (optional)"
              onChange={(event) => setInputTokens(event.target.value)}
              type="number"
              value={inputTokens}
            />
            <AuthoringFieldLabel
              description="An optional upper bound on output tokens for calls through this binding. The server applies the final capability and budget checks at execution time."
              label="Maximum output tokens"
            />
            <TextField
              label="Maximum output tokens (optional)"
              onChange={(event) => setOutputTokens(event.target.value)}
              type="number"
              value={outputTokens}
            />
            <Button
              disabled={busy || !providerId || !snapshotId || !model}
              onClick={() =>
                void submit(async () => {
                  const created = await client.createAiBindingDraft({
                    providerInstanceId: providerId,
                    catalogSnapshotId: snapshotId,
                    canonicalModel: model,
                    role,
                    ...(inputTokens.trim() === ""
                      ? {}
                      : { maximumInputTokens: Number(inputTokens) }),
                    ...(outputTokens.trim() === ""
                      ? {}
                      : { maximumOutputTokens: Number(outputTokens) }),
                  });
                  setCreatedBinding(created);
                  return `Binding draft ${created.label} was created. Activate it from its server-read revision in the bindings list.`;
                })
              }
              variant="contained"
            >
              Create binding draft
            </Button>
            {createdBinding === undefined ? null : (
              <Stack spacing={1}>
                <Alert severity="info">
                  {createdBinding.label} is an inert draft.
                </Alert>
                <Button
                  disabled={busy || createdBinding.status !== "draft"}
                  onClick={() =>
                    void submit(async () => {
                      const saved = await client.transitionAiBinding(
                        createdBinding.id,
                        {
                          expectedRevision: revision(createdBinding.version, 1),
                          lifecycle: "active",
                        },
                      );
                      setCreatedBinding(saved);
                      return `${saved.label} is active.`;
                    })
                  }
                  variant="outlined"
                >
                  Activate binding draft
                </Button>
              </Stack>
            )}
            <Typography color="text.secondary" variant="body2">
              To revise an existing binding, select it below. The server creates
              a successor immutable version; the original remains referenced by
              existing work.
            </Typography>
            <TextField
              label="Existing binding to revise"
              onChange={(event) => setSuccessorBindingId(event.target.value)}
              select
              value={successorBindingId}
            >
              <MenuItem value="">Select an existing binding</MenuItem>
              {(lists?.bindings ?? []).map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label} · revision {item.version ?? "?"}
                </MenuItem>
              ))}
            </TextField>
            {successorBindingId === "" ? null : (
              <Button
                disabled={busy}
                onClick={() =>
                  void submit(async () => {
                    const selected = lists?.bindings.find(
                      (item) => item.id === successorBindingId,
                    );
                    if (selected === undefined)
                      throw new Error(
                        "The selected binding is no longer available.",
                      );
                    const lifecycle =
                      selected.status === "active" ? "disabled" : "active";
                    const saved = await client.transitionAiBinding(
                      selected.id,
                      {
                        expectedRevision: revision(selected.version, -1),
                        lifecycle,
                      },
                    );
                    return `${saved.label} is ${lifecycle}.`;
                  })
                }
                variant="outlined"
              >
                {lists?.bindings.find((item) => item.id === successorBindingId)
                  ?.status === "active"
                  ? "Disable selected binding"
                  : "Activate selected binding"}
              </Button>
            )}
            <Button
              disabled={
                busy ||
                !successorBindingId ||
                !providerId ||
                !snapshotId ||
                !model
              }
              onClick={() =>
                void submit(async () => {
                  const selected = lists?.bindings.find(
                    (item) => item.id === successorBindingId,
                  );
                  const created = await client.createAiBindingVersionDraft(
                    successorBindingId,
                    {
                      expectedRevision: revision(selected?.version, -1),
                      providerInstanceId: providerId,
                      catalogSnapshotId: snapshotId,
                      canonicalModel: model,
                      role,
                      ...(inputTokens.trim() === ""
                        ? {}
                        : { maximumInputTokens: Number(inputTokens) }),
                      ...(outputTokens.trim() === ""
                        ? {}
                        : { maximumOutputTokens: Number(outputTokens) }),
                    },
                  );
                  setCreatedBinding(created);
                  return `Successor binding draft ${created.label} was created.`;
                })
              }
              variant="outlined"
            >
              Create successor binding version
            </Button>
          </Stack>
        </Paper>
      ) : null}
      {rolesEnabled ? (
        <Paper
          component="section"
          elevation={0}
          sx={{ border: "1px solid", borderColor: "divider", p: 2 }}
        >
          <Stack spacing={2}>
            <Typography variant="h5">Set workspace role default</Typography>
            <AuthoringFieldLabel
              description="The workspace default selects which immutable model binding version is used for a CaseWeaver capability when no more specific server policy overrides it."
              label="Default role"
            />
            <TextField
              label="Role"
              onChange={(event) => setDefaultRole(event.target.value as AiRole)}
              select
              value={defaultRole}
            >
              {roles.map((entry) => (
                <MenuItem key={entry} value={entry}>
                  {entry}
                </MenuItem>
              ))}
            </TextField>
            <AuthoringFieldLabel
              description="A binding version is immutable. Selecting it pins the workspace default to that exact reviewed configuration rather than silently following later binding changes."
              label="Default binding version"
            />
            <TextField
              label="Binding version"
              onChange={(event) =>
                setDefaultBindingVersionId(event.target.value)
              }
              select
              value={defaultBindingVersionId}
            >
              <MenuItem disabled value="">
                Select an immutable binding version
              </MenuItem>
              {(lists?.bindings ?? []).flatMap((item) =>
                item.summary === undefined
                  ? []
                  : [
                      <MenuItem key={item.id} value={item.summary}>
                        {item.label} · {item.summary}
                      </MenuItem>,
                    ],
              )}
            </TextField>
            <Button
              disabled={busy || !defaultBindingVersionId}
              onClick={() =>
                void submit(async () => {
                  const current = lists?.defaults.find(
                    (item) => item.id === defaultRole,
                  );
                  const saved = await client.setAiRoleDefault(defaultRole, {
                    bindingVersionId: defaultBindingVersionId,
                    expectedRevision: revision(current?.version),
                  });
                  return `${saved.label} was updated.`;
                })
              }
              variant="contained"
            >
              Save role default
            </Button>
          </Stack>
        </Paper>
      ) : null}
      {pricingEnabled ? (
        <Paper
          component="section"
          elevation={0}
          sx={{ border: "1px solid", borderColor: "divider", p: 2 }}
        >
          <Stack spacing={2}>
            <Typography variant="h5">
              Add a workspace pricing override
            </Typography>
            <TextField
              label="Catalog model"
              onChange={(event) => setPriceModel(event.target.value)}
              select
              value={priceModel}
            >
              <MenuItem disabled value="">
                Select a catalog model
              </MenuItem>
              {(lists?.models ?? []).map((item) => (
                <MenuItem key={item.id} value={item.label}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
            <AuthoringFieldLabel
              description="Enter the price for one input token in the selected currency. The API uses it for cost attribution; unknown pricing is never treated as zero."
              label="Input token price"
            />
            <TextField
              label="Input price amount"
              onChange={(event) => setPriceAmount(event.target.value)}
              value={priceAmount}
            />
            <AuthoringFieldLabel
              description="Use the three-letter currency code that matches the entered price. The API validates the policy before it becomes effective."
              examples={["USD", "CAD"]}
              label="Price currency"
            />
            <TextField
              label="Currency"
              onChange={(event) =>
                setPriceCurrency(event.target.value.toUpperCase())
              }
              value={priceCurrency}
            />
            <Button
              disabled={busy || chosenPriceModel === undefined}
              onClick={() =>
                void submit(async () => {
                  const saved = await client.createAiPriceOverride({
                    scope: "workspace",
                    provider: chosenPriceModel?.summary ?? "",
                    canonicalModel: priceModel,
                    effectiveFrom: new Date().toISOString(),
                    components: [
                      {
                        kind: "input",
                        unit: "token",
                        amount: priceAmount,
                        currency: priceCurrency,
                      },
                    ],
                  });
                  return `${saved.label} was created.`;
                })
              }
              variant="contained"
            >
              Create pricing override
            </Button>
          </Stack>
        </Paper>
      ) : null}
      {budgetsEnabled ? (
        <Paper
          component="section"
          elevation={0}
          sx={{ border: "1px solid", borderColor: "divider", p: 2 }}
        >
          <Stack spacing={2}>
            <Typography variant="h5">Replace budget policy</Typography>
            <TextField
              label="Existing policy (optional)"
              onChange={(event) => setBudgetId(event.target.value)}
              select
              value={budgetId}
            >
              <MenuItem value="">Create a policy</MenuItem>
              {(lists?.budgets ?? []).map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
            <AuthoringFieldLabel
              description="Scope determines where the API evaluates this cost limit: one operation, one analysis, a day, or the whole workspace."
              label="Budget scope"
            />
            <TextField
              label="Scope"
              onChange={(event) =>
                setBudgetScope(event.target.value as typeof budgetScope)
              }
              select
              value={budgetScope}
            >
              {(["operation", "analysis", "day", "workspace"] as const).map(
                (entry) => (
                  <MenuItem key={entry} value={entry}>
                    {entry}
                  </MenuItem>
                ),
              )}
            </TextField>
            <AuthoringFieldLabel
              description="The scope key identifies the server-owned subject within the selected budget scope. It is a budget-policy key, never an authorization grant."
              label="Budget scope key"
            />
            <TextField
              label="Scope key"
              onChange={(event) => setBudgetScopeKey(event.target.value)}
              value={budgetScopeKey}
            />
            <AuthoringFieldLabel
              description="The maximum monetary amount permitted in this scope and currency. The API attributes actual costs and continues to reject unknown pricing."
              label="Budget limit amount"
            />
            <TextField
              label="Limit amount"
              onChange={(event) => setBudgetAmount(event.target.value)}
              value={budgetAmount}
            />
            <AuthoringFieldLabel
              description="Use the three-letter currency code in which the budget limit is expressed."
              examples={["USD", "CAD"]}
              label="Budget currency"
            />
            <TextField
              label="Currency"
              onChange={(event) =>
                setBudgetCurrency(event.target.value.toUpperCase())
              }
              value={budgetCurrency}
            />
            <Stack spacing={0.5}>
              <AuthoringFieldLabel
                description="A hard limit causes the API to deny work that would exceed the policy. A non-hard policy remains visible for monitoring and server-owned handling."
                label="Hard budget limit"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={budgetHard}
                    onChange={(event) => setBudgetHard(event.target.checked)}
                  />
                }
                label="Hard limit"
              />
            </Stack>
            <Button
              disabled={busy}
              onClick={() =>
                void submit(async () => {
                  const saved = await client.replaceAiBudget({
                    ...(budgetId === "" ? {} : { budgetPolicyId: budgetId }),
                    scope: budgetScope,
                    scopeKey: budgetScopeKey,
                    limitAmount: budgetAmount,
                    currency: budgetCurrency,
                    hard: budgetHard,
                    expectedRevision: revision(selectedBudget?.version),
                  });
                  return `${saved.label} was saved.`;
                })
              }
              variant="contained"
            >
              Save budget policy
            </Button>
          </Stack>
        </Paper>
      ) : null}
      {bindingsEnabled ? (
        <Paper
          component="section"
          elevation={0}
          sx={{ border: "1px solid", borderColor: "divider", p: 2 }}
        >
          <Stack spacing={2}>
            <Typography variant="h5">
              Metered provider capability test
            </Typography>
            <Typography color="text.secondary" variant="body2">
              The server supplies the fixed test template, cost confirmation,
              budget enforcement, timeout, rate limit, and audit record. No
              prompt, model response, or credential is shown here.
            </Typography>
            <TextField
              label="Active provider instance"
              onChange={(event) => setTestProviderId(event.target.value)}
              select
              value={testProviderId}
            >
              <MenuItem disabled value="">
                Select an active provider
              </MenuItem>
              {active(lists?.providers ?? []).map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
            {confirmation === undefined ? (
              <Button
                disabled={busy || !testProviderId}
                onClick={() => void requestCapabilityPreview()}
                variant="outlined"
              >
                Preview provider test impact
              </Button>
            ) : (
              <>
                <Alert severity="warning">{confirmation.impact}</Alert>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void submit(async () => {
                      const execution = await client.runProviderCapabilityTest(
                        confirmation.providerId,
                        confirmation.operation,
                        confirmation.confirmationId,
                      );
                      setConfirmation(undefined);
                      return `Provider test ${execution.outcome}.`;
                    })
                  }
                  variant="contained"
                >
                  Confirm and run provider test
                </Button>
              </>
            )}
            {testOperation === undefined ? null : (
              <Typography color="text.secondary" variant="caption">
                Registered operation: {testOperation}
              </Typography>
            )}
          </Stack>
        </Paper>
      ) : null}
    </Stack>
  );
}
