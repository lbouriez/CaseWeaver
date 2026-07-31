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
import { useCallback, useEffect, useRef, useState } from "react";
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
const workspaceBudgetScopeKey = "all";

type AiRole = (typeof roles)[number];

/**
 * Pricing requirements are properties of CaseWeaver operation kinds, rather
 * than a provider or model name.  A provider inventory model can be bound to
 * more than one role, so the selected role is the narrowest browser-safe
 * context available while creating an explicit override.
 */
function needsOutputTokenPrice(role: AiRole): boolean {
  return role !== "embedding" && role !== "reranker";
}

function needsImageUnitPrice(role: AiRole): boolean {
  return role === "vision";
}

type Lists = Readonly<{
  readonly providers: readonly AdminListItem[];
  readonly snapshots: readonly AdminListItem[];
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

/** Budget history stays visible in the resource list, but a replacement must
 * start from the one active policy for its scope. Selecting a superseded row
 * would intentionally fail optimistic concurrency and is not useful form
 * input. */
function activeBudgetPolicies(
  items: readonly AdminListItem[],
): readonly AdminListItem[] {
  return items.filter((item) => item.status !== "disabled");
}

/**
 * Resource-specific AI controls. Every select is populated by API read models;
 * the browser never receives endpoint, wire API, parameters, pricing rules,
 * resolved credentials, or a provider/model-name branch.
 */
export function AiConfigurationAuthoring({
  bindingsEnabled,
  catalogRefreshEnabled = false,
  rolesEnabled,
  pricingEnabled,
  budgetsEnabled,
}: {
  readonly bindingsEnabled: boolean;
  readonly catalogRefreshEnabled?: boolean;
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
  const [modelSearch, setModelSearch] = useState("");
  const [inventoryRefresh, setInventoryRefresh] = useState(0);
  const [role, setRole] = useState<AiRole>("analysis");
  const [inputTokens, setInputTokens] = useState("");
  const [outputTokens, setOutputTokens] = useState("");
  const [defaultBindingVersionId, setDefaultBindingVersionId] = useState("");
  const [defaultRole, setDefaultRole] = useState<AiRole>("analysis");
  const [priceModel, setPriceModel] = useState("");
  const [priceAmount, setPriceAmount] = useState("0.001");
  const [priceOutputAmount, setPriceOutputAmount] = useState("");
  const [priceImageAmount, setPriceImageAmount] = useState("");
  const [priceCurrency, setPriceCurrency] = useState("USD");
  const [budgetId, setBudgetId] = useState("");
  const [budgetScope, setBudgetScope] = useState<
    "operation" | "analysis" | "day" | "workspace"
  >("workspace");
  const [budgetScopeKey, setBudgetScopeKey] = useState(workspaceBudgetScopeKey);
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
  const [bindingOptions, setBindingOptions] =
    useState<
      readonly Readonly<{
        readonly catalogSnapshotId: string;
        readonly canonicalModel: string;
        readonly catalogProvider: string;
      }>[]
    >();
  const [bindingOptionsError, setBindingOptionsError] = useState<unknown>();

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const [providers, snapshots, bindings, defaults, budgets] =
        await Promise.all([
          client.list("ai-provider-instances", { limit: 200 }, { signal }),
          client.list("ai-catalog-snapshots", { limit: 200 }, { signal }),
          client.list("ai-bindings", { limit: 200 }, { signal }),
          client.list("ai-role-defaults", { limit: 200 }, { signal }),
          client.list("ai-budgets", { limit: 200 }, { signal }),
        ]);
      const next = Object.freeze({
        providers: providers.items,
        snapshots: snapshots.items,
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

  const latestInventoryRefresh = useRef(inventoryRefresh);
  useEffect(() => {
    latestInventoryRefresh.current = inventoryRefresh;
  }, [inventoryRefresh]);

  useEffect(() => {
    if (providerId.length === 0 || role.length === 0) {
      setBindingOptions(undefined);
      setSnapshotId("");
      setModel("");
      return;
    }
    const controller = new AbortController();
    const requestedInventoryRefresh = inventoryRefresh;
    setBindingOptionsError(undefined);
    void client
      .aiBindingOptions(
        {
          providerInstanceId: providerId,
          role,
          ...(modelSearch.trim().length === 0
            ? {}
            : { search: modelSearch.trim() }),
        },
        controller.signal,
      )
      .then((result) => {
        if (
          controller.signal.aborted ||
          latestInventoryRefresh.current !== requestedInventoryRefresh
        ) {
          return;
        }
        setBindingOptions(result.items);
      })
      .catch((nextError: unknown) => {
        if (
          !controller.signal.aborted &&
          latestInventoryRefresh.current === requestedInventoryRefresh
        ) {
          setBindingOptions(undefined);
          setBindingOptionsError(nextError);
        }
      });
    return () => controller.abort();
  }, [client, inventoryRefresh, modelSearch, providerId, role]);

  useEffect(() => {
    if (bindingOptions === undefined) return;
    const first = bindingOptions[0];
    const selectedSnapshot = bindingOptions.some(
      (item) => item.catalogSnapshotId === snapshotId,
    )
      ? snapshotId
      : (first?.catalogSnapshotId ?? "");
    if (selectedSnapshot !== snapshotId) {
      setSnapshotId(selectedSnapshot);
      return;
    }
    if (
      !bindingOptions.some(
        (item) =>
          item.catalogSnapshotId === selectedSnapshot &&
          item.canonicalModel === model,
      )
    ) {
      setModel(
        bindingOptions.find(
          (item) => item.catalogSnapshotId === selectedSnapshot,
        )?.canonicalModel ?? "",
      );
    }
    setPriceModel((current) =>
      bindingOptions.some((item) => item.canonicalModel === current)
        ? current
        : (bindingOptions.find(
            (item) => item.catalogSnapshotId === selectedSnapshot,
          )?.canonicalModel ?? ""),
    );
  }, [bindingOptions, model, snapshotId]);

  const chosenPriceModel = bindingOptions?.find(
    (item) => item.canonicalModel === priceModel,
  );
  const outputPriceRequired = needsOutputTokenPrice(role);
  const imagePriceRequired = needsImageUnitPrice(role);
  const priceIsComplete =
    priceAmount.trim().length > 0 &&
    (!outputPriceRequired || priceOutputAmount.trim().length > 0) &&
    (!imagePriceRequired || priceImageAmount.trim().length > 0);
  const selectedBudget = lists?.budgets.find((item) => item.id === budgetId);

  useEffect(() => {
    if (budgetId === "") return;
    if (
      !activeBudgetPolicies(lists?.budgets ?? []).some(
        (item) => item.id === budgetId,
      )
    ) {
      setBudgetId("");
    }
  }, [budgetId, lists?.budgets]);

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

  if (
    !bindingsEnabled &&
    !catalogRefreshEnabled &&
    !rolesEnabled &&
    !pricingEnabled &&
    !budgetsEnabled
  ) {
    return null;
  }
  return (
    <Stack spacing={3}>
      {loadError === undefined ? null : <ApiFailure error={loadError} />}
      {error === undefined ? null : <ApiFailure error={error} />}
      {result === undefined ? null : <Alert severity="success">{result}</Alert>}
      {active(lists?.providers ?? []).length > 0 ? null : (
        <Alert severity="info">
          Setup order: register an external secret reference in Access &
          security, save and activate a provider above, refresh its available
          models, then create an immutable binding. Refresh the trusted LiteLLM
          catalog separately when you want price enrichment. Provider drafts are
          intentionally excluded until activation.
        </Alert>
      )}
      {catalogRefreshEnabled ? (
        <Paper
          component="section"
          elevation={0}
          sx={{ border: "1px solid", borderColor: "divider", p: 2 }}
        >
          <Stack spacing={2}>
            <Box>
              <Typography variant="overline">Trusted model catalog</Typography>
              <Typography variant="h5">
                Refresh the trusted model catalog
              </Typography>
              <Typography color="text.secondary" variant="body2">
                Refreshes deployment-owned LiteLLM pricing and capability
                metadata. It does not decide what a provider endpoint offers;
                refresh provider models below for that inventory. The browser
                never chooses a URL or receives downloaded catalog data.
              </Typography>
            </Box>
            <Button
              disabled={busy}
              onClick={() =>
                void submit(async () => {
                  const refreshed = await client.refreshAiCatalog();
                  return `${refreshed.label} was refreshed. Matching provider inventory models can now receive trusted price enrichment.`;
                })
              }
              variant="outlined"
            >
              Refresh trusted model catalog
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
            <Box>
              <Typography variant="overline">
                Immutable model binding
              </Typography>
              <Typography variant="h5">Create a model binding draft</Typography>
              <Typography color="text.secondary" variant="body2">
                The model list comes from the selected provider's server-side
                inventory, not from a global pricing catalog. LiteLLM enriches
                matching prices only. The server resolves runtime-only values
                and validates the immutable provider/model pairing.
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
            <Paper
              elevation={0}
              sx={{ border: "1px solid", borderColor: "divider", p: 2 }}
            >
              <Stack spacing={1}>
                <Typography variant="subtitle2">
                  Models available from this provider
                </Typography>
                <Typography color="text.secondary" variant="body2">
                  CaseWeaver asks the configured provider endpoint for its model
                  inventory from the server, using its retained external
                  credential. The browser receives only safe model metadata.
                  LiteLLM is used afterward for exact price enrichment, never as
                  the source of provider availability.
                </Typography>
                <Alert severity="info">
                  Registering an external reference is not enough by itself: the
                  referenced value must be present in the API deployment
                  environment. For the local stack, set the host environment
                  variable and recreate the API container before refreshing.
                </Alert>
                <Box>
                  <Button
                    disabled={busy || providerId.length === 0}
                    onClick={() =>
                      void submit(async () => {
                        const refreshed =
                          await client.refreshAiProviderModels(providerId);
                        setInventoryRefresh((current) => current + 1);
                        return `${refreshed.label} was refreshed. ${refreshed.summary ?? "The latest provider inventory is ready for selection."}`;
                      })
                    }
                    variant="outlined"
                  >
                    Refresh models available from provider
                  </Button>
                </Box>
              </Stack>
            </Paper>
            <TextField
              helperText="Filters the server-discovered models available from this provider. This does not submit a model name; select a returned result below."
              label="Filter provider models"
              onChange={(event) => setModelSearch(event.target.value)}
              slotProps={{ htmlInput: { maxLength: 120 } }}
              value={modelSearch}
            />
            <TextField
              label="Provider inventory snapshot"
              onChange={(event) => setSnapshotId(event.target.value)}
              select
              value={snapshotId}
            >
              <MenuItem disabled value="">
                Select a provider inventory snapshot
              </MenuItem>
              {[
                ...new Set(
                  (bindingOptions ?? []).map((item) => item.catalogSnapshotId),
                ),
              ].map((id) => (
                <MenuItem key={id} value={id}>
                  {id}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Model available from provider"
              onChange={(event) => setModel(event.target.value)}
              select
              value={model}
            >
              <MenuItem disabled value="">
                Select a provider model
              </MenuItem>
              {(bindingOptions ?? [])
                .filter((item) => item.catalogSnapshotId === snapshotId)
                .map((item) => (
                  <MenuItem
                    key={`${item.catalogSnapshotId}:${item.canonicalModel}`}
                    value={item.canonicalModel}
                  >
                    {item.canonicalModel}
                  </MenuItem>
                ))}
            </TextField>
            {bindingOptionsError === undefined ? null : (
              <ApiFailure error={bindingOptionsError} />
            )}
            {bindingOptions !== undefined && bindingOptions.length === 0 ? (
              <Alert severity="info">
                This provider inventory has no compatible models for the
                selected role and API capability. Refresh models available from
                this provider, or use a provider instance with the matching API
                capability.
              </Alert>
            ) : null}
            <AuthoringFieldLabel
              description="A CaseWeaver role describes the capability this immutable binding may serve. The API validates the selected server-discovered provider inventory model and role together."
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
            <Typography color="text.secondary" variant="body2">
              Select only a model returned by the active provider inventory
              above. This explicit override can price a provider-owned model
              that has no exact LiteLLM price match; it never makes a global
              catalog model available at this endpoint. Prices must cover each
              usage unit needed by the selected CaseWeaver role: embeddings and
              reranking need input tokens; generated responses also need output
              tokens; vision work also needs image units.
            </Typography>
            <TextField
              label="Provider inventory model"
              onChange={(event) => setPriceModel(event.target.value)}
              select
              value={priceModel}
            >
              <MenuItem disabled value="">
                Select a provider inventory model
              </MenuItem>
              {(bindingOptions ?? []).map((item) => (
                <MenuItem
                  key={`${item.catalogSnapshotId}:${item.canonicalModel}`}
                  value={item.canonicalModel}
                >
                  {item.canonicalModel}
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
            {!outputPriceRequired ? null : (
              <>
                <AuthoringFieldLabel
                  description="Enter the price for one generated output token. Chat, analysis, and repository-agent work needs both input and output prices before a hard-budget test can run. Use the provider's published rate; CaseWeaver will not silently assume zero."
                  label="Output token price"
                />
                <TextField
                  label="Output price amount"
                  onChange={(event) => setPriceOutputAmount(event.target.value)}
                  value={priceOutputAmount}
                />
              </>
            )}
            {!imagePriceRequired ? null : (
              <>
                <AuthoringFieldLabel
                  description="Enter the price for one image unit. Vision requests can consume both tokens and image units, so all three prices are required before a hard-budget test can run."
                  label="Image unit price"
                />
                <TextField
                  label="Image price amount"
                  onChange={(event) => setPriceImageAmount(event.target.value)}
                  value={priceImageAmount}
                />
              </>
            )}
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
              disabled={
                busy || chosenPriceModel === undefined || !priceIsComplete
              }
              onClick={() =>
                void submit(async () => {
                  const saved = await client.createAiPriceOverride({
                    scope: "workspace",
                    provider: chosenPriceModel?.catalogProvider ?? "",
                    canonicalModel: priceModel,
                    effectiveFrom: new Date().toISOString(),
                    components: [
                      {
                        kind: "input",
                        unit: "token",
                        amount: priceAmount,
                        currency: priceCurrency,
                      },
                      ...(outputPriceRequired
                        ? [
                            {
                              kind: "output" as const,
                              unit: "token" as const,
                              amount: priceOutputAmount,
                              currency: priceCurrency,
                            },
                          ]
                        : []),
                      ...(imagePriceRequired
                        ? [
                            {
                              kind: "image" as const,
                              unit: "image" as const,
                              amount: priceImageAmount,
                              currency: priceCurrency,
                            },
                          ]
                        : []),
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
              {activeBudgetPolicies(lists?.budgets ?? []).map((item) => (
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
              onChange={(event) => {
                const nextScope = event.target.value as typeof budgetScope;
                setBudgetScope(nextScope);
                setBudgetScopeKey(
                  nextScope === "workspace" ? workspaceBudgetScopeKey : "",
                );
              }}
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
              description="For a workspace policy this is automatically ‘all’, covering every CaseWeaver AI operation in the workspace. Other scopes require the stable CaseWeaver identifier for the operation, analysis, or UTC day they govern; it is never an authorization grant."
              label="Budget scope key"
            />
            <TextField
              disabled={budgetScope === "workspace"}
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
