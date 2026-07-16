import {
  Alert,
  Box,
  Button,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { useApiClient } from "../api/context.js";
import type { AdminDetail, AdminListItem } from "../api/contracts.js";
import { ApiFailure } from "../components/api-failure.js";
import { AuthoringFieldLabel } from "../components/authoring-field-label.js";
import { SourceScheduleLifecycleControl } from "../components/source-schedule-lifecycle-control.js";

type CadenceKind = "interval" | "cron";

function nextHour(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

/**
 * Resource-specific authoring for the two feature projections that are
 * composed today. It discovers all selectable records from the API and pins a
 * schedule to the source's current immutable configuration version; no raw
 * connector setting, secret reference, or queue payload is handled here.
 */
export function SourceScheduleDrafts({
  sourceEnabled,
  scheduleEnabled,
}: {
  readonly sourceEnabled: boolean;
  readonly scheduleEnabled: boolean;
}) {
  const client = useApiClient();
  const [connectors, setConnectors] = useState<readonly AdminListItem[]>();
  const [collections, setCollections] = useState<readonly AdminListItem[]>();
  const [budgets, setBudgets] = useState<readonly AdminListItem[]>();
  const [sources, setSources] = useState<readonly AdminListItem[]>();
  const [sourceId, setSourceId] = useState("");
  const [sourceVersionId, setSourceVersionId] = useState<string>();
  const [loadError, setLoadError] = useState<unknown>();
  const [sourceError, setSourceError] = useState<unknown>();
  const [scheduleError, setScheduleError] = useState<unknown>();
  const [sourceSaved, setSourceSaved] = useState<string>();
  const [scheduleSaved, setScheduleSaved] = useState<string>();
  const [createdSource, setCreatedSource] = useState<AdminDetail>();
  const [createdSchedule, setCreatedSchedule] = useState<AdminDetail>();
  const [sourceBusy, setSourceBusy] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [sourceName, setSourceName] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [normalizationProfileId, setNormalizationProfileId] =
    useState("text-normalization");
  const [normalizationProfileVersion, setNormalizationProfileVersion] =
    useState("v1");
  const [chunkingProfileId, setChunkingProfileId] = useState("text-chunking");
  const [chunkingProfileVersion, setChunkingProfileVersion] = useState("v1");
  const [embeddingBatchSize, setEmbeddingBatchSize] = useState("16");
  const [embeddingBudgetPolicyId, setEmbeddingBudgetPolicyId] = useState("");
  const [synchronizationPolicy, setSynchronizationPolicy] = useState(
    '{"triggers":[{"mode":"manual"}]}',
  );
  const [deletionBehavior, setDeletionBehavior] = useState<
    "tombstone" | "retain"
  >("tombstone");
  const [scheduleName, setScheduleName] = useState("");
  const [scheduleKind, setScheduleKind] = useState<
    "synchronize" | "fullRescan"
  >("synchronize");
  const [cadenceKind, setCadenceKind] = useState<CadenceKind>("interval");
  const [intervalMs, setIntervalMs] = useState("3600000");
  const [cronExpression, setCronExpression] = useState("0 * * * *");
  const [timezone, setTimezone] = useState("UTC");
  const [overlapPolicy, setOverlapPolicy] = useState<"skip" | "queue">("skip");
  const [nextRunAt, setNextRunAt] = useState(nextHour);
  const activeConnectors = connectors?.filter(
    (connector) => connector.status === "active",
  );

  const refreshSources = async (signal?: AbortSignal) => {
    const result = await client.list(
      "knowledge-sources",
      { limit: 200 },
      { signal },
    );
    setSources(result.items);
    setSourceId((current) =>
      result.items.some((item) => item.id === current)
        ? current
        : (result.items[0]?.id ?? ""),
    );
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(undefined);
    void Promise.all([
      client.list(
        "connector-instances",
        { limit: 200 },
        { signal: controller.signal },
      ),
      client.listDescriptors("connector", controller.signal),
      client.list("collections", { limit: 200 }, { signal: controller.signal }),
      client.list("ai-budgets", { limit: 200 }, { signal: controller.signal }),
      client.list(
        "knowledge-sources",
        { limit: 200 },
        { signal: controller.signal },
      ),
    ])
      .then(
        ([
          connectorResult,
          descriptors,
          collectionResult,
          budgetResult,
          sourceResult,
        ]) => {
          const knowledgeSourceTypes = new Set(
            descriptors
              .filter((descriptor) =>
                descriptor.connectorCapabilities.includes("knowledgeSource"),
              )
              .map((descriptor) => descriptor.type),
          );
          const eligibleConnectors = connectorResult.items.filter(
            (item) =>
              item.status === "active" &&
              item.summary !== undefined &&
              knowledgeSourceTypes.has(item.summary),
          );
          setConnectors(eligibleConnectors);
          setCollections(collectionResult.items);
          const hardBudgets = budgetResult.items.filter(
            (item) => item.status === "hard",
          );
          setBudgets(hardBudgets);
          setSources(sourceResult.items);
          setConnectorId(eligibleConnectors[0]?.id ?? "");
          setCollectionId(collectionResult.items[0]?.id ?? "");
          setEmbeddingBudgetPolicyId(hardBudgets[0]?.id ?? "");
          setSourceId(sourceResult.items[0]?.id ?? "");
        },
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(error);
      });
    return () => controller.abort();
  }, [client]);

  useEffect(() => {
    const controller = new AbortController();
    setSourceVersionId(undefined);
    if (sourceId.length === 0) return () => controller.abort();
    void client
      .configurationInspection(sourceId, controller.signal)
      .then((inspection) => setSourceVersionId(inspection.currentVersionId))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setScheduleError(error);
      });
    return () => controller.abort();
  }, [client, sourceId]);

  const createSource = async () => {
    let policy: Readonly<Record<string, unknown>>;
    try {
      const parsed: unknown = JSON.parse(synchronizationPolicy);
      if (
        parsed === null ||
        Array.isArray(parsed) ||
        typeof parsed !== "object"
      ) {
        throw new Error("Synchronization policy must be a JSON object.");
      }
      policy = parsed as Readonly<Record<string, unknown>>;
    } catch {
      setSourceError(
        new Error("Synchronization policy must be a valid JSON object."),
      );
      return;
    }
    if (
      sourceName.trim().length === 0 ||
      connectorId.length === 0 ||
      collectionId.length === 0 ||
      normalizationProfileId.trim().length === 0 ||
      normalizationProfileVersion.trim().length === 0 ||
      chunkingProfileId.trim().length === 0 ||
      chunkingProfileVersion.trim().length === 0 ||
      embeddingBudgetPolicyId.length === 0 ||
      !Number.isSafeInteger(Number(embeddingBatchSize)) ||
      Number(embeddingBatchSize) < 1 ||
      Number(embeddingBatchSize) > 1_000
    ) {
      setSourceError(
        new Error("Complete every source field before creating a draft."),
      );
      return;
    }
    setSourceBusy(true);
    setSourceError(undefined);
    setSourceSaved(undefined);
    try {
      const created = await client.createKnowledgeSourceDraft({
        displayName: sourceName.trim(),
        connectorInstanceId: connectorId,
        collectionId,
        normalizationProfileId: normalizationProfileId.trim(),
        normalizationProfileVersion: normalizationProfileVersion.trim(),
        chunkingProfileId: chunkingProfileId.trim(),
        chunkingProfileVersion: chunkingProfileVersion.trim(),
        embeddingBatchSize: Number(embeddingBatchSize),
        embeddingBudgetPolicyId,
        synchronizationPolicy: policy,
        deletionBehavior,
      });
      setSourceSaved(
        `Draft ${created.label} is inert until its server-owned lifecycle changes.`,
      );
      setCreatedSource(created);
      setSourceName("");
      await refreshSources();
    } catch (error) {
      setSourceError(error);
    } finally {
      setSourceBusy(false);
    }
  };

  const createSchedule = async () => {
    const parsedInterval = Number(intervalMs);
    if (
      scheduleName.trim().length === 0 ||
      sourceId.length === 0 ||
      sourceVersionId === undefined ||
      !Number.isFinite(new Date(nextRunAt).getTime()) ||
      (cadenceKind === "interval" &&
        (!Number.isSafeInteger(parsedInterval) || parsedInterval < 1)) ||
      (cadenceKind === "cron" &&
        (cronExpression.trim().length === 0 || timezone.trim().length === 0))
    ) {
      setScheduleError(
        new Error("Complete every schedule field with valid values."),
      );
      return;
    }
    setScheduleBusy(true);
    setScheduleError(undefined);
    setScheduleSaved(undefined);
    try {
      const created = await client.createKnowledgeScheduleDraft({
        displayName: scheduleName.trim(),
        sourceId,
        sourceConfigurationVersionId: sourceVersionId,
        kind: scheduleKind,
        cadence:
          cadenceKind === "interval"
            ? {
                kind: "interval",
                intervalMs: parsedInterval,
                overlapPolicy,
              }
            : {
                kind: "cron",
                expression: cronExpression.trim(),
                timezone: timezone.trim(),
                overlapPolicy,
              },
        nextRunAt: new Date(nextRunAt).toISOString(),
      });
      setScheduleSaved(
        `Draft ${created.label} pins source version ${sourceVersionId}.`,
      );
      setCreatedSchedule(created);
      setScheduleName("");
    } catch (error) {
      setScheduleError(error);
    } finally {
      setScheduleBusy(false);
    }
  };

  if (!sourceEnabled && !scheduleEnabled) return null;
  return (
    <Stack spacing={3}>
      {loadError === undefined ? null : <ApiFailure error={loadError} />}
      {sourceEnabled ? (
        <Paper
          component="section"
          elevation={0}
          sx={{
            border: "1px solid",
            borderColor: "divider",
            p: { xs: 2, md: 3 },
          }}
        >
          <Stack
            component="form"
            spacing={2}
            onSubmit={(event) => event.preventDefault()}
          >
            <Box>
              <Typography variant="overline">Knowledge source</Typography>
              <Typography variant="h5">Create an inert source draft</Typography>
              <Typography color="text.secondary" variant="body2">
                The API validates the selected active connector capability and
                collection workspace, text-profile revisions, and a hard budget
                before storing an immutable draft. Creating a draft does not
                contact a connector, schedule work, or ingest content; use the
                lifecycle control only when it is ready to activate.
              </Typography>
            </Box>
            {sourceError === undefined ? null : (
              <ApiFailure error={sourceError} />
            )}
            {sourceSaved === undefined ? null : (
              <Stack spacing={1}>
                <Alert severity="success">{sourceSaved}</Alert>
                {createdSource === undefined ? null : (
                  <SourceScheduleLifecycleControl
                    client={client}
                    onCompleted={() => refreshSources()}
                    resource="knowledge-sources"
                    resourceId={createdSource.id}
                    status={createdSource.status}
                  />
                )}
              </Stack>
            )}
            <TextField
              fullWidth
              label="Source display name"
              onChange={(event) => setSourceName(event.target.value)}
              required
              value={sourceName}
            />
            <TextField
              fullWidth
              label="Active connector instance"
              onChange={(event) => setConnectorId(event.target.value)}
              required
              select
              value={connectorId}
            >
              <MenuItem disabled value="">
                Select an active connector instance
              </MenuItem>
              {activeConnectors?.map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              fullWidth
              helperText="Collections are created and maintained in Knowledge & Analysis. Select an existing workspace-scoped collection here."
              label="Knowledge collection"
              onChange={(event) => setCollectionId(event.target.value)}
              required
              select
              value={collectionId}
            >
              <MenuItem disabled value="">
                Select a knowledge collection
              </MenuItem>
              {collections?.map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              fullWidth
              label="Normalization profile ID"
              onChange={(event) =>
                setNormalizationProfileId(event.target.value)
              }
              required
              value={normalizationProfileId}
            />
            <TextField
              fullWidth
              label="Normalization profile version"
              onChange={(event) =>
                setNormalizationProfileVersion(event.target.value)
              }
              required
              value={normalizationProfileVersion}
            />
            <TextField
              fullWidth
              label="Chunking profile ID"
              onChange={(event) => setChunkingProfileId(event.target.value)}
              required
              value={chunkingProfileId}
            />
            <TextField
              fullWidth
              label="Chunking profile version"
              onChange={(event) =>
                setChunkingProfileVersion(event.target.value)
              }
              required
              value={chunkingProfileVersion}
            />
            <AuthoringFieldLabel
              description="The maximum number of source chunks included in one metered embedding operation. It controls the size of each operation, while the API remains responsible for budgets and total cost attribution."
              label="Embedding batch size"
            />
            <TextField
              fullWidth
              helperText="The maximum number of chunks sent to the metered embedding gateway in one operation."
              label="Embedding batch size"
              onChange={(event) => setEmbeddingBatchSize(event.target.value)}
              required
              type="number"
              value={embeddingBatchSize}
            />
            <TextField
              fullWidth
              label="Hard embedding budget"
              onChange={(event) =>
                setEmbeddingBudgetPolicyId(event.target.value)
              }
              required
              select
              value={embeddingBudgetPolicyId}
            >
              <MenuItem disabled value="">
                Select an active hard budget
              </MenuItem>
              {budgets?.map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
            <AuthoringFieldLabel
              description="A bounded, feature-level JSON policy for when the source may synchronize. Connector-specific filters belong only to the selected connector configuration."
              label="Source synchronization policy"
            />
            <TextField
              fullWidth
              helperText="JSON object only. Connector-specific filters stay in the connector configuration."
              label="Synchronization policy"
              minRows={3}
              multiline
              onChange={(event) => setSynchronizationPolicy(event.target.value)}
              required
              value={synchronizationPolicy}
            />
            <AuthoringFieldLabel
              description="Tombstone preserves an auditable deletion state for documents removed upstream; retain leaves previously indexed documents in place. The server executes the chosen lifecycle behavior."
              label="Source deletion behavior"
            />
            <TextField
              fullWidth
              label="Deletion behavior"
              onChange={(event) =>
                setDeletionBehavior(
                  event.target.value as "tombstone" | "retain",
                )
              }
              required
              select
              value={deletionBehavior}
            >
              <MenuItem value="tombstone">Tombstone deleted documents</MenuItem>
              <MenuItem value="retain">Retain deleted documents</MenuItem>
            </TextField>
            <Box>
              <Button
                disabled={
                  sourceBusy ||
                  activeConnectors === undefined ||
                  collections === undefined ||
                  budgets === undefined
                }
                onClick={() => void createSource()}
                variant="contained"
              >
                {sourceBusy ? "Creating draft…" : "Create source draft"}
              </Button>
            </Box>
          </Stack>
        </Paper>
      ) : null}
      {scheduleEnabled ? (
        <Paper
          component="section"
          elevation={0}
          sx={{
            border: "1px solid",
            borderColor: "divider",
            p: { xs: 2, md: 3 },
          }}
        >
          <Stack
            component="form"
            spacing={2}
            onSubmit={(event) => event.preventDefault()}
          >
            <Box>
              <Typography variant="overline">Schedule</Typography>
              <Typography variant="h5">
                Create a source-version-pinned draft
              </Typography>
              <Typography color="text.secondary" variant="body2">
                A schedule always references the selected immutable source
                version; it cannot silently follow later source changes.
              </Typography>
            </Box>
            {scheduleError === undefined ? null : (
              <ApiFailure error={scheduleError} />
            )}
            {scheduleSaved === undefined ? null : (
              <Stack spacing={1}>
                <Alert severity="success">{scheduleSaved}</Alert>
                {createdSchedule === undefined ? null : (
                  <SourceScheduleLifecycleControl
                    client={client}
                    onCompleted={async () => undefined}
                    resource="schedules"
                    resourceId={createdSchedule.id}
                    status={createdSchedule.status}
                  />
                )}
              </Stack>
            )}
            <TextField
              fullWidth
              label="Schedule display name"
              onChange={(event) => setScheduleName(event.target.value)}
              required
              value={scheduleName}
            />
            <TextField
              fullWidth
              helperText={
                sourceVersionId === undefined
                  ? "Select a source with an immutable configuration version."
                  : `Pinned configuration version: ${sourceVersionId}`
              }
              label="Knowledge source"
              onChange={(event) => setSourceId(event.target.value)}
              required
              select
              value={sourceId}
            >
              <MenuItem disabled value="">
                Select a knowledge source
              </MenuItem>
              {sources?.map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
            <AuthoringFieldLabel
              description="Synchronize requests bounded incremental work; full rescan requests a controlled re-evaluation of the selected source. The scheduler only enqueues the work and workers execute it."
              label="Schedule run kind"
            />
            <TextField
              fullWidth
              label="Run kind"
              onChange={(event) =>
                setScheduleKind(
                  event.target.value as "synchronize" | "fullRescan",
                )
              }
              required
              select
              value={scheduleKind}
            >
              <MenuItem value="synchronize">Synchronize changes</MenuItem>
              <MenuItem value="fullRescan">Full rescan</MenuItem>
            </TextField>
            <AuthoringFieldLabel
              description="Choose a fixed elapsed interval or a cron expression interpreted in the selected IANA timezone. The API validates the final schedule before it is activated."
              label="Schedule cadence"
            />
            <TextField
              fullWidth
              label="Cadence"
              onChange={(event) =>
                setCadenceKind(event.target.value as CadenceKind)
              }
              required
              select
              value={cadenceKind}
            >
              <MenuItem value="interval">Fixed interval</MenuItem>
              <MenuItem value="cron">Cron expression</MenuItem>
            </TextField>
            {cadenceKind === "interval" ? (
              <>
                <AuthoringFieldLabel
                  description="The positive elapsed time between eligible runs, expressed in milliseconds. The API applies its own jitter, leasing, and overlap safeguards."
                  label="Schedule interval"
                />
                <TextField
                  fullWidth
                  label="Interval milliseconds"
                  onChange={(event) => setIntervalMs(event.target.value)}
                  required
                  type="number"
                  value={intervalMs}
                />
              </>
            ) : (
              <>
                <AuthoringFieldLabel
                  description="A server-validated cron expression that determines eligible run times. It is interpreted in the IANA timezone below, not in an operator browser timezone."
                  examples={["0 * * * *"]}
                  label="Schedule cron expression"
                />
                <TextField
                  fullWidth
                  label="Cron expression"
                  onChange={(event) => setCronExpression(event.target.value)}
                  required
                  value={cronExpression}
                />
                <AuthoringFieldLabel
                  description="An IANA timezone used to interpret the cron expression, such as America/Toronto. It makes daylight-saving behavior explicit and server-owned."
                  examples={["UTC", "America/Toronto"]}
                  label="Schedule timezone"
                />
                <TextField
                  fullWidth
                  label="IANA timezone"
                  onChange={(event) => setTimezone(event.target.value)}
                  required
                  value={timezone}
                />
              </>
            )}
            <AuthoringFieldLabel
              description="Skip avoids concurrent work when an earlier run is still executing. Queue retains due runs for controlled worker processing, subject to server limits."
              label="Schedule overlap policy"
            />
            <TextField
              fullWidth
              label="Overlap policy"
              onChange={(event) =>
                setOverlapPolicy(event.target.value as "skip" | "queue")
              }
              required
              select
              value={overlapPolicy}
            >
              <MenuItem value="skip">Skip overlapping execution</MenuItem>
              <MenuItem value="queue">Queue overlapping execution</MenuItem>
            </TextField>
            <AuthoringFieldLabel
              description="The first eligible UTC instant for this schedule. The API stores the normalized timestamp and later runs remain pinned to the selected immutable source version."
              label="Schedule first run"
            />
            <TextField
              fullWidth
              helperText="Stored as UTC by the API."
              label="First run (UTC)"
              onChange={(event) => setNextRunAt(event.target.value)}
              required
              value={nextRunAt}
            />
            <Box>
              <Button
                disabled={
                  scheduleBusy ||
                  sources === undefined ||
                  sourceVersionId === undefined
                }
                onClick={() => void createSchedule()}
                variant="contained"
              >
                {scheduleBusy ? "Creating draft…" : "Create schedule draft"}
              </Button>
            </Box>
          </Stack>
        </Paper>
      ) : null}
    </Stack>
  );
}
