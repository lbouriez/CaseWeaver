import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  FormGroup,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useState } from "react";

import { useApiClient } from "../api/context.js";
import type {
  RepositoryAnalysisConfiguration,
  RepositoryAnalysisDeploymentOption,
  RepositoryAnalysisOption,
  RepositoryAnalysisOptions,
  RepositoryAnalysisResource,
} from "../api/contracts.js";
import { ApiFailure } from "../components/api-failure.js";
import { AuthoringFieldLabel } from "../components/authoring-field-label.js";

export type RepositoryAnalysisWorkflowSection =
  | "repository"
  | "knowledge"
  | "automation";

type Option = RepositoryAnalysisOption | RepositoryAnalysisDeploymentOption;

const gitRefName =
  /^(?!refs\/)(?!HEAD$)(?!\/)(?!.*\/$)(?!.*\.\.)(?!.*@\{)[^\s\\:~^?*\[\]]{1,512}$/u;

function optionById<T extends { readonly id: string }>(
  values: readonly T[],
  id: string,
): T | undefined {
  return values.find((value) => value.id === id);
}

function requiredOption<T extends { readonly id: string }>(
  values: readonly T[],
  id: string,
  message: string,
): T {
  const selected = optionById(values, id);
  if (selected === undefined) throw new Error(message);
  return selected;
}

function selectionOptions(values: readonly Option[]): readonly Option[] {
  return values.filter((value) => value.eligibleForDraft);
}

function activeOptions(
  values: readonly RepositoryAnalysisOption[],
): readonly RepositoryAnalysisOption[] {
  return values.filter((value) => value.eligibleForActivation);
}

function wholeNumber(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${label} must be a whole number from ${minimum.toLocaleString()} to ${maximum.toLocaleString()}.`,
    );
  }
  return parsed;
}

function credentialFreeHttps(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid HTTPS repository URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "Use an HTTPS URL without embedded credentials, a query string, or a fragment.",
    );
  }
  return url.toString();
}

function SelectField({
  label,
  value,
  onChange,
  options,
  helperText,
  required = true,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly helperText?: string;
  readonly required?: boolean;
}) {
  return (
    <TextField
      fullWidth
      helperText={helperText}
      label={label}
      onChange={(event) => onChange(event.target.value)}
      required={required}
      select
      value={value}
    >
      <MenuItem disabled value="">
        Select a server-provided option
      </MenuItem>
      {options.map((option) => (
        <MenuItem key={option.id} value={option.id}>
          {option.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

/**
 * Real PBI-020 administration surface. It deliberately uses only typed API
 * options and immutable authoring commands; no source URL, path, secret
 * locator, prompt, evidence, model response, or deployment value is shown in
 * a resource read model after the transient create request has finished.
 */
export function RepositoryAnalysisWorkflows({
  section,
}: {
  readonly section: RepositoryAnalysisWorkflowSection;
}) {
  const client = useApiClient();
  const [options, setOptions] = useState<RepositoryAnalysisOptions>();
  const [loadError, setLoadError] = useState<unknown>();

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const next = await client.repositoryAnalysisOptions(signal);
      if (!signal?.aborted) setOptions(next);
    },
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(undefined);
    void reload(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error);
    });
    return () => controller.abort();
  }, [reload]);

  const heading =
    section === "repository"
      ? "Repository analysis"
      : section === "knowledge"
        ? "Attachment intelligence and analysis recipes"
        : "Case analysis automation";
  const description =
    section === "repository"
      ? "Register one checked-out code repository and its bounded, networkless investigation policy. The server resolves and tests repository access; this browser never reads a repository."
      : section === "knowledge"
        ? "Set the immutable attachment limits and analysis recipe that bind retrieval, prompt, AI, repository and publication decisions for a case."
        : "Map an authorized case source to an immutable recipe and choose the cadence that only enqueues durable work. Webhook and polling ingress use the same pinned request identity.";

  return (
    <Stack spacing={3}>
      <Paper
        component="section"
        elevation={0}
        sx={{
          border: "1px solid",
          borderColor: "divider",
          p: { xs: 2, md: 3 },
        }}
      >
        <Stack spacing={1}>
          <Typography variant="overline">
            Case analysis control plane
          </Typography>
          <Typography variant="h5">{heading}</Typography>
          <Typography color="text.secondary" variant="body2">
            {description}
          </Typography>
        </Stack>
      </Paper>
      {loadError === undefined ? null : <ApiFailure error={loadError} />}
      {options === undefined ? (
        loadError === undefined ? (
          <Alert severity="info">Loading server-authorized options…</Alert>
        ) : null
      ) : section === "repository" ? (
        <>
          <CodeRepositoryForm options={options} onChanged={reload} />
          <ExecutionPolicyForm options={options} onChanged={reload} />
          <SafeOptionCatalog
            empty="No repository or execution-policy versions have been created in this workspace."
            groups={[
              ["Code repositories", options.codeRepositories],
              ["Execution policies", options.repositoryExecutionPolicies],
            ]}
          />
        </>
      ) : section === "knowledge" ? (
        <>
          <AttachmentPolicyForm options={options} onChanged={reload} />
          <AnalysisRecipeForm options={options} onChanged={reload} />
          <SafeOptionCatalog
            empty="No attachment policies or analysis recipes have been created in this workspace."
            groups={[
              ["Attachment policies", options.attachmentPolicies],
              ["Analysis recipes", options.analysisRecipes],
            ]}
          />
        </>
      ) : (
        <>
          <CaseTriggerForm options={options} onChanged={reload} />
          <CaseScheduleForm options={options} onChanged={reload} />
          <SafeOptionCatalog
            empty="No case triggers or intake schedules have been created in this workspace."
            groups={[["Case triggers", options.caseAnalysisTriggers]]}
          />
        </>
      )}
    </Stack>
  );
}

function SafeOptionCatalog({
  groups,
  empty,
}: {
  readonly groups: readonly [string, readonly RepositoryAnalysisOption[]][];
  readonly empty: string;
}) {
  const hasItems = groups.some(([, values]) => values.length > 0);
  return (
    <Paper
      component="section"
      elevation={0}
      sx={{ border: "1px solid", borderColor: "divider", p: { xs: 2, md: 3 } }}
    >
      <Stack spacing={1.5}>
        <Typography variant="h6">Configured versions</Typography>
        {!hasItems ? <Alert severity="info">{empty}</Alert> : null}
        {groups.map(([title, values]) => (
          <Box key={title}>
            <Typography variant="subtitle2">{title}</Typography>
            {values.length === 0 ? (
              <Typography color="text.secondary" variant="body2">
                None yet.
              </Typography>
            ) : (
              values.map((value) => (
                <Typography
                  color="text.secondary"
                  key={`${title}-${value.id}`}
                  variant="body2"
                >
                  {value.label} · {value.lifecycle} · immutable version{" "}
                  {value.versionId}
                </Typography>
              ))
            )}
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}

function AuthoringCard({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Paper
      component="section"
      elevation={0}
      sx={{ border: "1px solid", borderColor: "divider", p: { xs: 2, md: 3 } }}
    >
      <Stack spacing={2}>
        <Typography variant="h6">{title}</Typography>
        {children}
      </Stack>
    </Paper>
  );
}

function CodeRepositoryForm({
  options,
  onChanged,
}: {
  readonly options: RepositoryAnalysisOptions;
  readonly onChanged: () => Promise<void>;
}) {
  const client = useApiClient();
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<"remoteHttps" | "deploymentMounted">(
    "remoteHttps",
  );
  const [remoteUrl, setRemoteUrl] = useState("");
  const [secretReferenceId, setSecretReferenceId] = useState("");
  const [mountAlias, setMountAlias] = useState("");
  const [allowedRefKinds, setAllowedRefKinds] = useState<
    readonly ("branch" | "tag" | "commit")[]
  >(["branch"]);
  const [refKind, setRefKind] = useState<"branch" | "tag" | "commit">("branch");
  const [refValue, setRefValue] = useState("main");
  const [created, setCreated] = useState<RepositoryAnalysisConfiguration>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const toggleRefKind = (
    kind: "branch" | "tag" | "commit",
    checked: boolean,
  ) => {
    setAllowedRefKinds((current) => {
      const next = checked
        ? [...new Set([...current, kind])]
        : current.filter((value) => value !== kind);
      if (next.length === 0) return current;
      if (!next.includes(refKind))
        setRefKind(next[0] as "branch" | "tag" | "commit");
      return next;
    });
  };

  const submit = async () => {
    try {
      if (displayName.trim().length === 0)
        throw new Error("Provide a repository display name.");
      if (!allowedRefKinds.includes(refKind))
        throw new Error("Allow the checkout reference type that you selected.");
      const checkoutRef =
        refKind === "commit"
          ? (() => {
              if (
                !/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/u.test(refValue.trim())
              ) {
                throw new Error(
                  "A commit reference must be a full 40- or 64-character commit SHA.",
                );
              }
              return {
                kind: "commit" as const,
                sha: refValue.trim().toLowerCase(),
              };
            })()
          : (() => {
              if (!gitRefName.test(refValue.trim()))
                throw new Error(
                  "Enter a safe branch or tag name, not HEAD or a refspec.",
                );
              return { kind: refKind, name: refValue.trim() } as const;
            })();
      const location =
        mode === "remoteHttps"
          ? {
              mode,
              remoteUrl: credentialFreeHttps(remoteUrl),
              ...(secretReferenceId.length === 0
                ? {}
                : { checkoutSecretReferenceId: secretReferenceId }),
            }
          : (() => {
              if (mountAlias.length === 0)
                throw new Error(
                  "Choose a deployment-approved repository mount.",
                );
              return { mode, mountAlias } as const;
            })();
      setBusy(true);
      setError(undefined);
      setCreated(
        await client.createRepositoryAnalysisDraft({
          resource: "code-repositories",
          displayName: displayName.trim(),
          location,
          allowedRefKinds,
          checkoutRef,
        }),
      );
      await onChanged();
    } catch (nextError) {
      setError(nextError);
    } finally {
      // A URL is authoring input only. Never keep it after a request completes.
      setRemoteUrl("");
      setBusy(false);
    }
  };

  return (
    <AuthoringCard title="Create a code repository draft">
      <Typography color="text.secondary" variant="body2">
        CaseWeaver checks out this repository only on the server. Select a
        branch, tag, or full commit that every run must resolve before its
        isolated, read-only investigation begins.
      </Typography>
      {error === undefined ? null : <ApiFailure error={error} />}
      <TextField
        fullWidth
        label="Repository display name"
        onChange={(event) => setDisplayName(event.target.value)}
        required
        value={displayName}
      />
      <SelectField
        label="Repository location"
        onChange={(value) => {
          setMode(value as "remoteHttps" | "deploymentMounted");
          setRemoteUrl("");
        }}
        options={[
          { id: "remoteHttps", label: "Server-managed HTTPS repository" },
          {
            id: "deploymentMounted",
            label: "Deployment-approved repository mount",
          },
        ]}
        value={mode}
      />
      {mode === "remoteHttps" ? (
        <>
          <AuthoringFieldLabel
            description="A credential-free HTTPS address used one time to create the server-managed configuration. It is cleared in this form when the request ends and is never shown in repository lists, audit data, or later lifecycle controls."
            examples={["https://code.example.org/support/service.git"]}
            label="Remote repository URL"
          />
          <TextField
            autoComplete="off"
            fullWidth
            helperText="HTTPS only. Do not include a token, password, query string, or URL fragment."
            label="Remote repository URL"
            onChange={(event) => setRemoteUrl(event.target.value)}
            required
            type="url"
            value={remoteUrl}
          />
          <SelectField
            helperText="Optional opaque secret registration. It identifies access material in the server's secret backend; this console never displays or enters a credential value."
            label="Registered repository access"
            onChange={setSecretReferenceId}
            options={options.checkoutSecretReferences.map((value) => ({
              id: value.secretReferenceId,
              label: value.label,
            }))}
            required={false}
            value={secretReferenceId}
          />
        </>
      ) : (
        <SelectField
          helperText="The deployment decides the path behind this alias. Host paths never reach the browser."
          label="Approved repository mount"
          onChange={setMountAlias}
          options={selectionOptions(options.mountedRepositories)}
          value={mountAlias}
        />
      )}
      <Box
        component="fieldset"
        sx={{ border: "1px solid", borderColor: "divider", m: 0, p: 2 }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography component="legend" variant="subtitle2">
            Allowed Git references
          </Typography>
          <AuthoringFieldLabel
            description="These are the only reference forms this repository may use. Branches and tags are resolved to an exact full commit at run time; a commit SHA is already immutable."
            label="Allowed Git references"
          />
        </Stack>
        <FormGroup row>
          {(["branch", "tag", "commit"] as const).map((kind) => (
            <FormControlLabel
              control={
                <Checkbox
                  checked={allowedRefKinds.includes(kind)}
                  onChange={(event) =>
                    toggleRefKind(kind, event.target.checked)
                  }
                />
              }
              key={kind}
              label={
                kind === "commit"
                  ? "Full commit SHA"
                  : kind === "branch"
                    ? "Branches"
                    : "Tags"
              }
            />
          ))}
        </FormGroup>
      </Box>
      <SelectField
        label="Configured checkout reference type"
        onChange={(value) => {
          const next = value as "branch" | "tag" | "commit";
          setRefKind(next);
          setRefValue(next === "commit" ? "" : "main");
        }}
        options={allowedRefKinds.map((kind) => ({
          id: kind,
          label:
            kind === "commit"
              ? "Full commit SHA"
              : kind === "branch"
                ? "Branch"
                : "Tag",
        }))}
        value={refKind}
      />
      <TextField
        autoComplete="off"
        fullWidth
        helperText={
          refKind === "commit"
            ? "A full 40- or 64-character SHA, never a shortened commit."
            : "For example main or release/2026.04. HEAD and raw Git refspecs are not allowed."
        }
        label={refKind === "commit" ? "Commit SHA" : "Branch or tag name"}
        onChange={(event) => setRefValue(event.target.value)}
        required
        value={refValue}
      />
      <Box>
        <Button
          disabled={busy}
          onClick={() => void submit()}
          variant="contained"
        >
          {busy ? "Creating draft…" : "Create repository draft"}
        </Button>
      </Box>
      {created === undefined ? null : (
        <LifecycleControl
          configuration={created}
          requireRepositoryTest
          onChanged={onChanged}
          resource="code-repositories"
        />
      )}
    </AuthoringCard>
  );
}

function ExecutionPolicyForm({
  options,
  onChanged,
}: {
  readonly options: RepositoryAnalysisOptions;
  readonly onChanged: () => Promise<void>;
}) {
  const client = useApiClient();
  const [displayName, setDisplayName] = useState("");
  const [binding, setBinding] = useState("");
  const [sandbox, setSandbox] = useState("");
  const [tools, setTools] = useState<
    readonly ("listFiles" | "readFile" | "searchFiles")[]
  >(["searchFiles"]);
  const [duration, setDuration] = useState("900000");
  const [turns, setTurns] = useState("20");
  const [calls, setCalls] = useState("100");
  const [outputTokens, setOutputTokens] = useState("16000");
  const [cpu, setCpu] = useState("900000");
  const [memory, setMemory] = useState(String(1024 * 1024 * 1024));
  const [outputBytes, setOutputBytes] = useState(String(4 * 1024 * 1024));
  const [created, setCreated] = useState<RepositoryAnalysisConfiguration>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async () => {
    try {
      if (
        displayName.trim().length === 0 ||
        binding.length === 0 ||
        sandbox.length === 0 ||
        tools.length === 0
      )
        throw new Error(
          "Provide a name, repository-agent binding, sandbox policy, and at least one read-only tool.",
        );
      setBusy(true);
      setError(undefined);
      setCreated(
        await client.createRepositoryAnalysisDraft({
          resource: "repository-execution-policies",
          displayName: displayName.trim(),
          repositoryAgentBindingVersionId: binding,
          sandboxPolicyVersionId: sandbox,
          allowedTools: tools,
          maximumDurationMs: wholeNumber(
            duration,
            "Maximum duration",
            1000,
            15 * 60_000,
          ),
          maximumTurns: wholeNumber(turns, "Maximum turns", 1, 100),
          maximumToolCalls: wholeNumber(calls, "Maximum tool calls", 1, 200),
          maximumOutputTokens: wholeNumber(
            outputTokens,
            "Maximum output tokens",
            1,
            128_000,
          ),
          maximumCpuMilliseconds: wholeNumber(
            cpu,
            "Maximum CPU time",
            100,
            15 * 60_000,
          ),
          maximumMemoryBytes: wholeNumber(
            memory,
            "Maximum memory",
            16 * 1024 * 1024,
            8 * 1024 * 1024 * 1024,
          ),
          maximumOutputBytes: wholeNumber(
            outputBytes,
            "Maximum output bytes",
            1024,
            32 * 1024 * 1024,
          ),
        }),
      );
      await onChanged();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };
  const toolLabels = {
    listFiles: "List repository files",
    readFile: "Read a bounded text file",
    searchFiles: "Search repository files",
  } as const;
  return (
    <AuthoringCard title="Create a repository execution policy draft">
      <Typography color="text.secondary" variant="body2">
        This policy is product-neutral. It restricts a replaceable
        repository-agent runtime to attested read-only tools, a disposable
        networkless sandbox, and explicit CPU, memory, output, and turn limits.
      </Typography>
      {error === undefined ? null : <ApiFailure error={error} />}
      <TextField
        fullWidth
        label="Execution policy display name"
        onChange={(event) => setDisplayName(event.target.value)}
        required
        value={displayName}
      />
      <SelectField
        label="Repository-agent binding"
        onChange={setBinding}
        options={activeOptions(options.repositoryAgentBindings).map(
          (value) => ({ id: value.versionId, label: value.label }),
        )}
        value={binding}
      />
      <SelectField
        helperText="A deployment-owned alias for an attested sandbox policy. It does not disclose an image or host setting."
        label="Sandbox policy"
        onChange={setSandbox}
        options={selectionOptions(options.sandboxPolicies)}
        value={sandbox}
      />
      <Box
        component="fieldset"
        sx={{ border: "1px solid", borderColor: "divider", m: 0, p: 2 }}
      >
        <Typography component="legend" variant="subtitle2">
          Read-only investigation tools
        </Typography>
        <FormGroup>
          {(Object.keys(toolLabels) as (keyof typeof toolLabels)[]).map(
            (tool) => (
              <FormControlLabel
                control={
                  <Checkbox
                    checked={tools.includes(tool)}
                    onChange={(event) =>
                      setTools((current) =>
                        event.target.checked
                          ? [...new Set([...current, tool])]
                          : current.filter((value) => value !== tool),
                      )
                    }
                  />
                }
                key={tool}
                label={toolLabels[tool]}
              />
            ),
          )}
        </FormGroup>
      </Box>
      <FormControlLabel
        control={<Checkbox checked disabled />}
        label="Network access is disabled"
      />
      <LimitFields
        values={{
          duration,
          turns,
          calls,
          outputTokens,
          cpu,
          memory,
          outputBytes,
        }}
        onChange={{
          duration: setDuration,
          turns: setTurns,
          calls: setCalls,
          outputTokens: setOutputTokens,
          cpu: setCpu,
          memory: setMemory,
          outputBytes: setOutputBytes,
        }}
      />
      <Box>
        <Button
          disabled={busy}
          onClick={() => void submit()}
          variant="contained"
        >
          {busy ? "Creating draft…" : "Create execution policy draft"}
        </Button>
      </Box>
      {created === undefined ? null : (
        <LifecycleControl
          configuration={created}
          onChanged={onChanged}
          resource="repository-execution-policies"
        />
      )}
    </AuthoringCard>
  );
}

function LimitFields({
  values,
  onChange,
}: {
  readonly values: Readonly<
    Record<
      | "duration"
      | "turns"
      | "calls"
      | "outputTokens"
      | "cpu"
      | "memory"
      | "outputBytes",
      string
    >
  >;
  readonly onChange: Readonly<
    Record<
      | "duration"
      | "turns"
      | "calls"
      | "outputTokens"
      | "cpu"
      | "memory"
      | "outputBytes",
      (value: string) => void
    >
  >;
}) {
  const fields: readonly [keyof typeof values, string, string][] = [
    [
      "duration",
      "Maximum duration (milliseconds)",
      "Maximum wall-clock time; at most 900,000.",
    ],
    ["turns", "Maximum agent turns", "Maximum tool/model turns; at most 100."],
    [
      "calls",
      "Maximum tool calls",
      "Maximum read-only tool calls; at most 200.",
    ],
    [
      "outputTokens",
      "Maximum output tokens",
      "Maximum agent output tokens; at most 128,000.",
    ],
    [
      "cpu",
      "Maximum CPU time (milliseconds)",
      "CPU limit for the isolated sandbox; at most 900,000.",
    ],
    [
      "memory",
      "Maximum memory (bytes)",
      "Memory limit for the isolated sandbox.",
    ],
    [
      "outputBytes",
      "Maximum output bytes",
      "Bounded sandbox output retained for verification; at most 33,554,432.",
    ],
  ];
  return (
    <Stack spacing={2}>
      {fields.map(([key, label, helper]) => (
        <TextField
          fullWidth
          helperText={helper}
          inputMode="numeric"
          key={key}
          label={label}
          onChange={(event) => onChange[key](event.target.value)}
          required
          type="number"
          value={values[key]}
        />
      ))}
    </Stack>
  );
}

function AttachmentPolicyForm({
  options,
  onChanged,
}: {
  readonly options: RepositoryAnalysisOptions;
  readonly onChanged: () => Promise<void>;
}) {
  const client = useApiClient();
  const [displayName, setDisplayName] = useState("");
  const [processor, setProcessor] = useState("");
  const [vision, setVision] = useState("");
  const [count, setCount] = useState("100");
  const [bytes, setBytes] = useState(String(25 * 1024 * 1024));
  const [entries, setEntries] = useState("1000");
  const [expanded, setExpanded] = useState(String(256 * 1024 * 1024));
  const [depth, setDepth] = useState("4");
  const [created, setCreated] = useState<RepositoryAnalysisConfiguration>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async () => {
    try {
      if (
        displayName.trim().length === 0 ||
        processor.length === 0 ||
        vision.length === 0
      )
        throw new Error(
          "Provide a name, attachment processor security policy, and vision binding.",
        );
      setBusy(true);
      setError(undefined);
      setCreated(
        await client.createRepositoryAnalysisDraft({
          resource: "attachment-policies",
          displayName: displayName.trim(),
          processorSecurityPolicyVersionId: processor,
          visionBindingVersionId: vision,
          maximumAttachmentCount: wholeNumber(
            count,
            "Maximum attachments",
            1,
            10_000,
          ),
          maximumAttachmentBytes: wholeNumber(
            bytes,
            "Maximum attachment bytes",
            1024,
            2 * 1024 * 1024 * 1024,
          ),
          maximumArchiveEntries: wholeNumber(
            entries,
            "Maximum archive entries",
            1,
            100_000,
          ),
          maximumExpandedArchiveBytes: wholeNumber(
            expanded,
            "Maximum expanded archive bytes",
            1024,
            8 * 1024 * 1024 * 1024,
          ),
          maximumArchiveDepth: wholeNumber(
            depth,
            "Maximum archive depth",
            0,
            16,
          ),
        }),
      );
      await onChanged();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthoringCard title="Create an attachment handling policy draft">
      <Typography color="text.secondary" variant="body2">
        The same governed pipeline serves knowledge and case analysis. It reuses
        a content-addressed derivative when the workspace and policy identity
        match; image vision is not repeated for a cache hit.
      </Typography>
      {error === undefined ? null : <ApiFailure error={error} />}
      <TextField
        fullWidth
        label="Attachment policy display name"
        onChange={(event) => setDisplayName(event.target.value)}
        required
        value={displayName}
      />
      <SelectField
        helperText="Deployment-approved processor policy: download, MIME, archive and public-image safety limits are enforced on the server."
        label="Attachment processor security policy"
        onChange={setProcessor}
        options={selectionOptions(options.attachmentProcessorSecurityPolicies)}
        value={processor}
      />
      <SelectField
        helperText="An active vision binding used only through CaseWeaver's metered AI gateway."
        label="Vision binding"
        onChange={setVision}
        options={activeOptions(options.visionBindings).map((value) => ({
          id: value.versionId,
          label: value.label,
        }))}
        value={vision}
      />
      <TextField
        fullWidth
        helperText="How many attachment occurrences one source document or case may prepare."
        inputMode="numeric"
        label="Maximum attachments"
        onChange={(event) => setCount(event.target.value)}
        required
        type="number"
        value={count}
      />
      <TextField
        fullWidth
        helperText="Largest streamed original attachment in bytes."
        inputMode="numeric"
        label="Maximum attachment bytes"
        onChange={(event) => setBytes(event.target.value)}
        required
        type="number"
        value={bytes}
      />
      <TextField
        fullWidth
        helperText="Maximum entries allowed after a supported archive is inspected."
        inputMode="numeric"
        label="Maximum archive entries"
        onChange={(event) => setEntries(event.target.value)}
        required
        type="number"
        value={entries}
      />
      <TextField
        fullWidth
        helperText="Total expanded archive bytes allowed before evidence is rejected."
        inputMode="numeric"
        label="Maximum expanded archive bytes"
        onChange={(event) => setExpanded(event.target.value)}
        required
        type="number"
        value={expanded}
      />
      <TextField
        fullWidth
        helperText="Maximum nested archive levels. Zero permits no nested archive."
        inputMode="numeric"
        label="Maximum archive depth"
        onChange={(event) => setDepth(event.target.value)}
        required
        type="number"
        value={depth}
      />
      <Box>
        <Button
          disabled={busy}
          onClick={() => void submit()}
          variant="contained"
        >
          {busy ? "Creating draft…" : "Create attachment policy draft"}
        </Button>
      </Box>
      {created === undefined ? null : (
        <LifecycleControl
          configuration={created}
          onChanged={onChanged}
          resource="attachment-policies"
        />
      )}
    </AuthoringCard>
  );
}

function AnalysisRecipeForm({
  options,
  onChanged,
}: {
  readonly options: RepositoryAnalysisOptions;
  readonly onChanged: () => Promise<void>;
}) {
  const client = useApiClient();
  const [displayName, setDisplayName] = useState("");
  const [profile, setProfile] = useState("");
  const [binding, setBinding] = useState("");
  const [retrieval, setRetrieval] = useState("");
  const [prompt, setPrompt] = useState("");
  const [publication, setPublication] = useState("");
  const [repositoryMode, setRepositoryMode] = useState<
    "disabled" | "optional" | "required"
  >("disabled");
  const [repository, setRepository] = useState("");
  const [execution, setExecution] = useState("");
  const [agent, setAgent] = useState("");
  const [attachmentMode, setAttachmentMode] = useState<
    "disabled" | "optional" | "required"
  >("optional");
  const [attachment, setAttachment] = useState("");
  const [created, setCreated] = useState<RepositoryAnalysisConfiguration>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const submit = async () => {
    try {
      if (
        [displayName, profile, binding, retrieval, prompt, publication].some(
          (value) => value.length === 0,
        )
      ) {
        throw new Error(
          "Complete the core profile, binding, retrieval, prompt, and publication selections.",
        );
      }
      const repositoryStage =
        repositoryMode === "disabled"
          ? { mode: "disabled" as const }
          : (() => {
              const selectedRepository = requiredOption(
                options.codeRepositories,
                repository,
                "Choose an active code repository.",
              );
              const selectedExecution = requiredOption(
                options.repositoryExecutionPolicies,
                execution,
                "Choose an active repository execution policy.",
              );
              if (agent.length === 0) {
                throw new Error(
                  "Repository analysis needs the matching repository-agent binding.",
                );
              }
              return {
                mode: repositoryMode,
                repositoryId: selectedRepository.id,
                repositoryConfigurationVersionId: selectedRepository.versionId,
                executionPolicyId: selectedExecution.id,
                executionPolicyConfigurationVersionId:
                  selectedExecution.versionId,
                repositoryAgentBindingVersionId: agent,
              } as const;
            })();
      const attachmentStage =
        attachmentMode === "disabled"
          ? { mode: "disabled" as const }
          : (() => {
              const selected = requiredOption(
                options.attachmentPolicies,
                attachment,
                "Choose an attachment policy or disable the attachment stage.",
              );
              return {
                mode: attachmentMode,
                attachmentPolicyId: selected.id,
                attachmentPolicyConfigurationVersionId: selected.versionId,
              } as const;
            })();
      const analysisProfile = requiredOption(
        options.analysisProfiles,
        profile,
        "The selected analysis profile is no longer available. Refresh and choose again.",
      );
      const analysisBinding = requiredOption(
        options.analysisBindings,
        binding,
        "The selected analysis binding is no longer available. Refresh and choose again.",
      );
      const retrievalProfile = requiredOption(
        options.retrievalProfiles,
        retrieval,
        "The selected retrieval profile is no longer available. Refresh and choose again.",
      );
      const promptProfile = requiredOption(
        options.promptProfiles,
        prompt,
        "The selected prompt profile is no longer available. Refresh and choose again.",
      );
      const publicationProfile = requiredOption(
        options.publicationProfiles,
        publication,
        "The selected publication profile is no longer available. Refresh and choose again.",
      );
      setBusy(true);
      setError(undefined);
      setCreated(
        await client.createRepositoryAnalysisDraft({
          resource: "analysis-recipes",
          displayName: displayName.trim(),
          analysisProfileId: analysisProfile.id,
          analysisProfileVersionId: analysisProfile.versionId,
          analysisBindingVersionId: analysisBinding.versionId,
          retrievalProfileVersionId: retrievalProfile.versionId,
          promptProfileVersionId: promptProfile.versionId,
          publicationProfileVersionId: publicationProfile.versionId,
          repositoryStage,
          attachmentStage,
        }),
      );
      await onChanged();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  const active = activeOptions;
  return (
    <AuthoringCard title="Create an analysis recipe draft">
      <Typography color="text.secondary" variant="body2">
        A recipe pins all decisions used for a support case. Phase one supports
        one optional or required code repository; verified findings become
        evidence, never model instructions.
      </Typography>
      {error === undefined ? null : <ApiFailure error={error} />}
      <TextField
        fullWidth
        label="Analysis recipe display name"
        onChange={(event) => setDisplayName(event.target.value)}
        required
        value={displayName}
      />
      <SelectField
        label="Analysis profile"
        onChange={setProfile}
        options={active(options.analysisProfiles)}
        value={profile}
      />
      <SelectField
        label="Analysis binding"
        onChange={setBinding}
        options={active(options.analysisBindings)}
        value={binding}
      />
      <SelectField
        label="Retrieval profile"
        onChange={setRetrieval}
        options={active(options.retrievalProfiles)}
        value={retrieval}
      />
      <SelectField
        label="Prompt profile"
        onChange={setPrompt}
        options={active(options.promptProfiles)}
        value={prompt}
      />
      <SelectField
        label="Publication profile"
        onChange={setPublication}
        options={active(options.publicationProfiles)}
        value={publication}
      />
      <SelectField
        helperText="Optional preserves a warning when repository evidence is unavailable. Required stops the case analysis when it cannot be prepared."
        label="Repository investigation"
        onChange={(value) => setRepositoryMode(value as typeof repositoryMode)}
        options={[
          { id: "disabled", label: "Do not investigate a repository" },
          { id: "optional", label: "Use repository evidence when available" },
          { id: "required", label: "Require repository evidence" },
        ]}
        value={repositoryMode}
      />
      {repositoryMode === "disabled" ? null : (
        <>
          <SelectField
            label="Code repository"
            onChange={setRepository}
            options={active(options.codeRepositories)}
            value={repository}
          />
          <SelectField
            label="Repository execution policy"
            onChange={setExecution}
            options={active(options.repositoryExecutionPolicies)}
            value={execution}
          />
          <SelectField
            helperText="Must match the binding pinned by the execution policy. The API validates that exact relation before activation."
            label="Repository-agent binding"
            onChange={setAgent}
            options={active(options.repositoryAgentBindings).map((value) => ({
              id: value.versionId,
              label: value.label,
            }))}
            value={agent}
          />
        </>
      )}
      <SelectField
        helperText="Optional evidence records a warning on an unavailable attachment; required evidence stops the affected immutable run."
        label="Attachment preparation"
        onChange={(value) => setAttachmentMode(value as typeof attachmentMode)}
        options={[
          { id: "disabled", label: "Do not prepare attachments" },
          { id: "optional", label: "Prepare attachments when available" },
          { id: "required", label: "Require configured attachment evidence" },
        ]}
        value={attachmentMode}
      />
      {attachmentMode === "disabled" ? null : (
        <SelectField
          label="Attachment handling policy"
          onChange={setAttachment}
          options={active(options.attachmentPolicies)}
          value={attachment}
        />
      )}
      <Box>
        <Button
          disabled={busy}
          onClick={() => void submit()}
          variant="contained"
        >
          {busy ? "Creating draft…" : "Create analysis recipe draft"}
        </Button>
      </Box>
      {created === undefined ? null : (
        <LifecycleControl
          configuration={created}
          onChanged={onChanged}
          resource="analysis-recipes"
        />
      )}
    </AuthoringCard>
  );
}

function CaseTriggerForm({
  options,
  onChanged,
}: {
  readonly options: RepositoryAnalysisOptions;
  readonly onChanged: () => Promise<void>;
}) {
  const client = useApiClient();
  const [displayName, setDisplayName] = useState("");
  const [source, setSource] = useState("");
  const [recipe, setRecipe] = useState("");
  const [publication, setPublication] = useState("");
  const [ingress, setIngress] = useState<"polling" | "verifiedWebhook">(
    "polling",
  );
  const [webhook, setWebhook] = useState("");
  const [created, setCreated] = useState<RepositoryAnalysisConfiguration>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async () => {
    try {
      const selectedSource = options.caseSources.find(
        (value) => value.sourceId === source && value.eligibleForActivation,
      );
      const selectedRecipe = optionById(options.analysisRecipes, recipe);
      const selectedPublication = optionById(
        options.publicationProfiles,
        publication,
      );
      if (
        displayName.trim().length === 0 ||
        selectedSource === undefined ||
        selectedRecipe === undefined ||
        selectedPublication === undefined
      )
        throw new Error(
          "Choose an active case source, analysis recipe, and publication profile.",
        );
      const ingressValue =
        ingress === "polling"
          ? { kind: "polling" as const }
          : (() => {
              const endpoint = optionById(options.webhookEndpoints, webhook);
              if (endpoint === undefined)
                throw new Error("Choose an active verified-webhook endpoint.");
              return {
                kind: "verifiedWebhook" as const,
                webhookEndpointId: endpoint.id,
                webhookEndpointConfigurationVersionId: endpoint.versionId,
              };
            })();
      setBusy(true);
      setError(undefined);
      setCreated(
        await client.createRepositoryAnalysisDraft({
          resource: "case-analysis-triggers",
          displayName: displayName.trim(),
          caseSourceId: selectedSource.sourceId,
          caseSourceConfigurationVersionId:
            selectedSource.sourceConfigurationVersionId,
          connectorRegistrationId: selectedSource.connectorRegistrationId,
          connectorConfigurationVersionId:
            selectedSource.connectorConfigurationVersionId,
          analysisRecipeId: selectedRecipe.id,
          analysisRecipeConfigurationVersionId: selectedRecipe.versionId,
          publicationProfileVersionId: selectedPublication.versionId,
          ingress: ingressValue,
        }),
      );
      await onChanged();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthoringCard title="Create a case analysis trigger draft">
      <Typography color="text.secondary" variant="body2">
        A trigger pins a case source, recipe and destination profile. When
        enabled, polling and verified webhook delivery both enqueue the same
        durable request identity; neither performs analysis inside the browser
        or web request.
      </Typography>
      {error === undefined ? null : <ApiFailure error={error} />}
      <TextField
        fullWidth
        label="Case trigger display name"
        onChange={(event) => setDisplayName(event.target.value)}
        required
        value={displayName}
      />
      <SelectField
        label="Case source"
        onChange={setSource}
        options={options.caseSources
          .filter((value) => value.eligibleForActivation)
          .map((value) => ({ id: value.sourceId, label: value.label }))}
        value={source}
      />
      <SelectField
        label="Analysis recipe"
        onChange={setRecipe}
        options={activeOptions(options.analysisRecipes)}
        value={recipe}
      />
      <SelectField
        label="Publication profile"
        onChange={setPublication}
        options={activeOptions(options.publicationProfiles)}
        value={publication}
      />
      <SelectField
        helperText="Polling scans through the connector on the server. A verified webhook must be validated by its connector endpoint before CaseWeaver accepts the equivalent command."
        label="Ingress"
        onChange={(value) => setIngress(value as typeof ingress)}
        options={[
          { id: "polling", label: "Polling schedule" },
          { id: "verifiedWebhook", label: "Verified webhook" },
        ]}
        value={ingress}
      />
      {ingress === "verifiedWebhook" ? (
        <SelectField
          label="Verified webhook endpoint"
          onChange={setWebhook}
          options={activeOptions(options.webhookEndpoints)}
          value={webhook}
        />
      ) : null}
      <Box>
        <Button
          disabled={busy}
          onClick={() => void submit()}
          variant="contained"
        >
          {busy ? "Creating draft…" : "Create case trigger draft"}
        </Button>
      </Box>
      {created === undefined ? null : (
        <LifecycleControl
          configuration={created}
          onChanged={onChanged}
          resource="case-analysis-triggers"
        />
      )}
    </AuthoringCard>
  );
}

function CaseScheduleForm({
  options,
  onChanged,
}: {
  readonly options: RepositoryAnalysisOptions;
  readonly onChanged: () => Promise<void>;
}) {
  const client = useApiClient();
  const [displayName, setDisplayName] = useState("");
  const [trigger, setTrigger] = useState("");
  const [cadenceKind, setCadenceKind] = useState<"interval" | "cron">(
    "interval",
  );
  const [interval, setInterval] = useState("300000");
  const [expression, setExpression] = useState("0 * * * *");
  const [timezone, setTimezone] = useState("UTC");
  const [overlap, setOverlap] = useState<"skip" | "queue">("skip");
  const [created, setCreated] = useState<RepositoryAnalysisConfiguration>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async () => {
    try {
      const selected = optionById(options.caseAnalysisTriggers, trigger);
      if (displayName.trim().length === 0 || selected === undefined)
        throw new Error(
          "Provide a schedule name and choose an active case trigger.",
        );
      const cadence =
        cadenceKind === "interval"
          ? {
              kind: "interval" as const,
              intervalMs: wholeNumber(
                interval,
                "Polling interval",
                1,
                86_400_000,
              ),
              overlapPolicy: overlap,
            }
          : (() => {
              if (
                expression.trim().length === 0 ||
                timezone.trim().length === 0 ||
                expression.length > 500 ||
                timezone.length > 100
              )
                throw new Error(
                  "Provide a bounded cron expression and IANA timezone.",
                );
              return {
                kind: "cron" as const,
                expression: expression.trim(),
                timezone: timezone.trim(),
                overlapPolicy: overlap,
              };
            })();
      setBusy(true);
      setError(undefined);
      setCreated(
        await client.createRepositoryAnalysisDraft({
          resource: "case-analysis-schedules",
          displayName: displayName.trim(),
          triggerId: selected.id,
          triggerConfigurationVersionId: selected.versionId,
          cadence,
        }),
      );
      await onChanged();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthoringCard title="Create a case intake schedule draft">
      <Typography color="text.secondary" variant="body2">
        The scheduler only enqueues durable work. The worker captures the exact
        case snapshot, prepares attachments, retrieves knowledge, runs the
        selected AI/repository stages and immediately publishes through the
        pinned destination policy.
      </Typography>
      {error === undefined ? null : <ApiFailure error={error} />}
      <TextField
        fullWidth
        label="Case schedule display name"
        onChange={(event) => setDisplayName(event.target.value)}
        required
        value={displayName}
      />
      <SelectField
        label="Case trigger"
        onChange={setTrigger}
        options={activeOptions(options.caseAnalysisTriggers)}
        value={trigger}
      />
      <SelectField
        label="Cadence"
        onChange={(value) => setCadenceKind(value as typeof cadenceKind)}
        options={[
          { id: "interval", label: "Repeat at an interval" },
          { id: "cron", label: "Run on a cron schedule" },
        ]}
        value={cadenceKind}
      />
      {cadenceKind === "interval" ? (
        <TextField
          fullWidth
          helperText="Milliseconds, up to one day. The server owns the next-run calculation, leases and overlap enforcement."
          inputMode="numeric"
          label="Polling interval (milliseconds)"
          onChange={(event) => setInterval(event.target.value)}
          required
          type="number"
          value={interval}
        />
      ) : (
        <>
          <TextField
            fullWidth
            helperText="Five-field cron, for example 0 * * * * for each hour. The API validates the schedule."
            label="Cron expression"
            onChange={(event) => setExpression(event.target.value)}
            required
            value={expression}
          />
          <TextField
            fullWidth
            helperText="IANA timezone, for example America/Toronto. UTC is a safe default."
            label="Timezone"
            onChange={(event) => setTimezone(event.target.value)}
            required
            value={timezone}
          />
        </>
      )}
      <SelectField
        helperText="Skip ignores an overlapping occurrence; queue retains it for later processing."
        label="Overlapping scheduled runs"
        onChange={(value) => setOverlap(value as typeof overlap)}
        options={[
          { id: "skip", label: "Skip the overlapping occurrence" },
          { id: "queue", label: "Queue the overlapping occurrence" },
        ]}
        value={overlap}
      />
      <Box>
        <Button
          disabled={busy}
          onClick={() => void submit()}
          variant="contained"
        >
          {busy ? "Creating draft…" : "Create case schedule draft"}
        </Button>
      </Box>
      {created === undefined ? null : (
        <LifecycleControl
          configuration={created}
          onChanged={onChanged}
          resource="case-analysis-schedules"
        />
      )}
    </AuthoringCard>
  );
}

function LifecycleControl({
  configuration,
  resource,
  requireRepositoryTest = false,
  onChanged,
}: {
  readonly configuration: RepositoryAnalysisConfiguration;
  readonly resource: RepositoryAnalysisResource;
  readonly requireRepositoryTest?: boolean;
  readonly onChanged: () => Promise<void>;
}) {
  const client = useApiClient();
  const [current, setCurrent] = useState(configuration);
  const [preview, setPreview] =
    useState<
      Readonly<{ confirmationId: string; confirmation: string; impact: string }>
    >();
  const [test, setTest] = useState<
    "completed" | "failed" | "outcome_unknown" | "accepted"
  >();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const previewTest = async () => {
    if (!requireRepositoryTest) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await client.previewRepositoryDraftTest({
        repositoryId: current.id,
        candidateVersionId: current.versionId,
      });
      setPreview(next);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };
  const runTest = async () => {
    if (preview === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await client.executeRepositoryDraftTest({
        repositoryId: current.id,
        candidateVersionId: current.versionId,
        confirmationId: preview.confirmationId,
      });
      setTest(next.outcome);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };
  const transition = async (lifecycle: "active" | "disabled") => {
    if (requireRepositoryTest && lifecycle === "active" && test !== "completed")
      return;
    setBusy(true);
    setError(undefined);
    try {
      setCurrent(
        await client.transitionRepositoryAnalysis({
          resource,
          configurationId: current.id,
          expectedRevision: current.revision,
          lifecycle,
        }),
      );
      await onChanged();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack spacing={1.5}>
      <Alert severity="success">
        Immutable draft created. Version {current.versionId} is server-owned.
      </Alert>
      {error === undefined ? null : <ApiFailure error={error} />}
      {preview === undefined ? null : (
        <Alert severity="info">
          {preview.confirmation} {preview.impact}
        </Alert>
      )}
      {test === undefined ? null : (
        <Alert severity={test === "completed" ? "success" : "warning"}>
          Repository test{" "}
          {test === "accepted"
            ? "was accepted and is still running"
            : test.replaceAll("_", " ")}
          . Only a completed test can activate this repository version.
        </Alert>
      )}
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
        {requireRepositoryTest ? (
          <>
            <Button
              disabled={busy || current.lifecycle !== "draft"}
              onClick={() => void previewTest()}
              variant="outlined"
            >
              Preview repository test
            </Button>
            <Button
              disabled={
                busy || preview === undefined || current.lifecycle !== "draft"
              }
              onClick={() => void runTest()}
              variant="outlined"
            >
              Run repository test
            </Button>
          </>
        ) : null}
        <Button
          disabled={
            busy ||
            current.lifecycle !== "draft" ||
            (requireRepositoryTest && test !== "completed")
          }
          onClick={() => void transition("active")}
          variant="contained"
        >
          Activate draft
        </Button>
        {current.lifecycle === "active" ? (
          <Button
            color="warning"
            disabled={busy}
            onClick={() => void transition("disabled")}
            variant="outlined"
          >
            Disable
          </Button>
        ) : null}
      </Stack>
      {requireRepositoryTest &&
      current.lifecycle === "draft" &&
      test !== "completed" ? (
        <Typography color="text.secondary" variant="caption">
          Activation stays unavailable until the API confirms the exact
          immutable repository candidate passed its bounded test.
        </Typography>
      ) : null}
    </Stack>
  );
}
