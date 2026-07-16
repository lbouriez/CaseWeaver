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

import { type CaseWeaverApiClient, PublicApiError } from "../api/api-client.js";
import type { AdminDetail, AdminListItem } from "../api/contracts.js";
import { ApiFailure } from "../components/api-failure.js";
import { AuthoringFieldLabel } from "../components/authoring-field-label.js";
import { PublicationWebhookLifecycleControl } from "../components/publication-webhook-lifecycle-control.js";
import {
  parseSafeConfiguration,
  type SafeConfigurationObject,
} from "../components/safe-configuration-json.js";

function splitIdentifiers(value: string): readonly string[] {
  const values = value
    .split(/\r?\n|,/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (
    values.length < 1 ||
    values.length > 100 ||
    new Set(values).size !== values.length ||
    !values.every((entry) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(entry))
  ) {
    throw new Error(
      "Provide one to 100 distinct identifier-shaped event types.",
    );
  }
  return Object.freeze(values);
}

function positiveInteger(
  value: string,
  label: string,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(
      `${label} must be a whole number between 1 and ${maximum}.`,
    );
  }
  return parsed;
}

function isMissingPlatformLinks(error: unknown): boolean {
  return error instanceof PublicApiError && error.code === "resource.notFound";
}

/**
 * Feature-specific configuration authoring that retains generic JSON only for
 * feature policy. It never asks for a secret value, webhook body/header, or
 * connector/provider runtime client. The server remains the authority for
 * IDs, descriptor capability validation, configuration versions, and audit.
 */
export function ControlPlaneAuthoring({
  client,
  publicationEnabled,
  webhookEnabled,
  platformEnabled,
  onCompleted,
}: {
  readonly client: Pick<
    CaseWeaverApiClient,
    | "createPublicationProfileDraft"
    | "createWebhookEndpointDraft"
    | "configurationInspection"
    | "list"
    | "listDescriptors"
    | "platformLinks"
    | "savePlatformLinks"
    | "transitionPublicationProfile"
    | "transitionWebhookEndpoint"
  >;
  readonly publicationEnabled: boolean;
  readonly webhookEnabled: boolean;
  readonly platformEnabled: boolean;
  readonly onCompleted: () => Promise<void> | void;
}) {
  return (
    <Stack spacing={3}>
      {publicationEnabled ? (
        <PublicationProfileDraftForm
          client={client}
          onCompleted={onCompleted}
        />
      ) : null}
      {webhookEnabled ? (
        <WebhookEndpointDraftForm client={client} onCompleted={onCompleted} />
      ) : null}
      {platformEnabled ? (
        <PlatformLinksForm client={client} onCompleted={onCompleted} />
      ) : null}
    </Stack>
  );
}

function PublicationProfileDraftForm({
  client,
  onCompleted,
}: {
  readonly client: Pick<
    CaseWeaverApiClient,
    | "configurationInspection"
    | "createPublicationProfileDraft"
    | "transitionPublicationProfile"
    | "transitionWebhookEndpoint"
  >;
  readonly onCompleted: () => Promise<void> | void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [definition, setDefinition] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [created, setCreated] = useState<AdminDetail>();

  const submit = async () => {
    let parsedDefinition: SafeConfigurationObject;
    try {
      parsedDefinition = parseSafeConfiguration(
        definition,
        "Publication definition",
      );
      if (displayName.trim().length < 1) {
        throw new Error("Provide a publication profile display name.");
      }
    } catch (nextError) {
      if (
        nextError instanceof Error &&
        nextError.message.includes("Credential-shaped")
      ) {
        setDefinition("{}");
      }
      setError(nextError);
      return;
    }
    setBusy(true);
    setError(undefined);
    setCreated(undefined);
    try {
      const saved = await client.createPublicationProfileDraft({
        displayName: displayName.trim(),
        definition: parsedDefinition,
      });
      setCreated(saved);
      setDisplayName("");
      setDefinition("{}");
      await onCompleted();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper
      component="section"
      elevation={0}
      sx={{ border: "1px solid", borderColor: "divider", p: { xs: 2, md: 3 } }}
    >
      <Stack
        component="form"
        spacing={2}
        onSubmit={(event) => event.preventDefault()}
      >
        <Box>
          <Typography variant="overline">Publication policy</Typography>
          <Typography variant="h5">
            Create a publication profile draft
          </Typography>
          <Typography color="text.secondary" variant="body2">
            Enter destination policy as a server-validated JSON object. This
            creates an inert immutable draft; the API owns profile IDs and
            validation against active destinations.
          </Typography>
        </Box>
        {error === undefined ? null : <ApiFailure error={error} />}
        {created === undefined ? null : (
          <Stack spacing={1}>
            <Alert severity="success">Draft {created.label} was created.</Alert>
            <PublicationWebhookLifecycleControl
              client={client}
              onCompleted={onCompleted}
              resource="publication-profiles"
              resourceId={created.id}
              status={created.status}
            />
          </Stack>
        )}
        <TextField
          fullWidth
          label="Publication profile display name"
          onChange={(event) => setDisplayName(event.target.value)}
          required
          value={displayName}
        />
        <AuthoringFieldLabel
          description="A bounded publication-policy object. The API validates destinations and policy shape, rejects credential-shaped fields, and creates an inert immutable draft rather than contacting a destination."
          label="Publication definition"
        />
        <TextField
          fullWidth
          helperText="JSON object only. Credential-shaped fields are rejected; destinations and their policies are validated by the API."
          label="Publication definition"
          minRows={8}
          multiline
          onChange={(event) => setDefinition(event.target.value)}
          required
          value={definition}
        />
        <Box>
          <Button
            disabled={busy}
            onClick={() => void submit()}
            variant="contained"
          >
            {busy ? "Creating draft…" : "Create publication profile draft"}
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
}

function WebhookEndpointDraftForm({
  client,
  onCompleted,
}: {
  readonly client: Pick<
    CaseWeaverApiClient,
    | "createWebhookEndpointDraft"
    | "list"
    | "listDescriptors"
    | "configurationInspection"
    | "transitionPublicationProfile"
    | "transitionWebhookEndpoint"
  >;
  readonly onCompleted: () => Promise<void> | void;
}) {
  const [connectors, setConnectors] = useState<readonly AdminListItem[]>();
  const [references, setReferences] = useState<readonly AdminListItem[]>();
  const [loadError, setLoadError] = useState<unknown>();
  const [displayName, setDisplayName] = useState("");
  const [connectorInstanceId, setConnectorInstanceId] = useState("");
  const [eventTypes, setEventTypes] = useState("");
  const [maximumBodyBytes, setMaximumBodyBytes] = useState("131072");
  const [maximumRequestsPerMinute, setMaximumRequestsPerMinute] =
    useState("120");
  const [analysisTriggerId, setAnalysisTriggerId] = useState("");
  const [settings, setSettings] = useState("{}");
  const [registrationIds, setRegistrationIds] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [created, setCreated] = useState<AdminDetail>();

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(undefined);
    void Promise.all([
      client.list(
        "connector-instances",
        { limit: 200 },
        { signal: controller.signal },
      ),
      client.list(
        "secret-references",
        { limit: 200 },
        { signal: controller.signal },
      ),
      client.listDescriptors("connector", controller.signal),
    ])
      .then(([connectorResult, referenceResult, descriptors]) => {
        if (controller.signal.aborted) return;
        const webhookAdapterTypes = new Set(
          descriptors
            .filter((descriptor) =>
              descriptor.connectorCapabilities.includes("webhookAdapter"),
            )
            .map((descriptor) => descriptor.type),
        );
        const activeConnectors = connectorResult.items.filter(
          (item) =>
            item.status === "active" &&
            item.summary !== undefined &&
            webhookAdapterTypes.has(item.summary),
        );
        setConnectors(activeConnectors);
        setReferences(
          referenceResult.items.filter((item) => item.status === "active"),
        );
        setConnectorInstanceId((current) =>
          activeConnectors.some((item) => item.id === current)
            ? current
            : (activeConnectors[0]?.id ?? ""),
        );
      })
      .catch((nextError: unknown) => {
        if (!controller.signal.aborted) setLoadError(nextError);
      });
    return () => controller.abort();
  }, [client]);

  const toggleReference = (id: string, checked: boolean) => {
    setRegistrationIds((current) =>
      checked
        ? Object.freeze([...new Set([...current, id])].sort())
        : Object.freeze(current.filter((value) => value !== id)),
    );
  };

  const submit = async () => {
    let parsedSettings: SafeConfigurationObject;
    let parsedEvents: readonly string[];
    let bodyBytes: number;
    let rate: number;
    try {
      if (displayName.trim().length < 1 || connectorInstanceId.length < 1) {
        throw new Error(
          "Provide a display name and select an active connector instance.",
        );
      }
      parsedEvents = splitIdentifiers(eventTypes);
      parsedSettings = parseSafeConfiguration(settings, "Webhook settings");
      bodyBytes = positiveInteger(
        maximumBodyBytes,
        "Maximum body bytes",
        10 * 1024 * 1024,
      );
      rate = positiveInteger(
        maximumRequestsPerMinute,
        "Requests per minute",
        10_000,
      );
      if (
        analysisTriggerId.trim().length > 0 &&
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(analysisTriggerId.trim())
      ) {
        throw new Error("The optional analysis trigger must be an identifier.");
      }
    } catch (nextError) {
      if (
        nextError instanceof Error &&
        nextError.message.includes("Credential-shaped")
      ) {
        setSettings("{}");
      }
      setError(nextError);
      return;
    }
    setBusy(true);
    setError(undefined);
    setCreated(undefined);
    try {
      const saved = await client.createWebhookEndpointDraft({
        displayName: displayName.trim(),
        connectorInstanceId,
        verifiedEventTypes: parsedEvents,
        maximumBodyBytes: bodyBytes,
        maximumRequestsPerMinute: rate,
        ...(analysisTriggerId.trim().length === 0
          ? {}
          : { analysisTriggerId: analysisTriggerId.trim() }),
        settings: parsedSettings,
        secretReferenceRegistrationIds: registrationIds,
      });
      setCreated(saved);
      setDisplayName("");
      setEventTypes("");
      setSettings("{}");
      setAnalysisTriggerId("");
      setRegistrationIds([]);
      await onCompleted();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper
      component="section"
      elevation={0}
      sx={{ border: "1px solid", borderColor: "divider", p: { xs: 2, md: 3 } }}
    >
      <Stack
        component="form"
        spacing={2}
        onSubmit={(event) => event.preventDefault()}
      >
        <Box>
          <Typography variant="overline">Webhook ingress</Typography>
          <Typography variant="h5">Create a webhook endpoint draft</Typography>
          <Typography color="text.secondary" variant="body2">
            This draft is not publicly routable. The API validates connector
            capability, event types, and registered references before any later
            activation.
          </Typography>
        </Box>
        {loadError === undefined ? null : <ApiFailure error={loadError} />}
        {error === undefined ? null : <ApiFailure error={error} />}
        {created === undefined ? null : (
          <Stack spacing={1}>
            <Alert severity="success">Draft {created.label} was created.</Alert>
            <PublicationWebhookLifecycleControl
              client={client}
              onCompleted={onCompleted}
              resource="webhook-endpoints"
              resourceId={created.id}
              status={created.status}
            />
          </Stack>
        )}
        <TextField
          fullWidth
          label="Webhook display name"
          onChange={(event) => setDisplayName(event.target.value)}
          required
          value={displayName}
        />
        <TextField
          fullWidth
          label="Active connector instance"
          onChange={(event) => setConnectorInstanceId(event.target.value)}
          required
          select
          value={connectorInstanceId}
        >
          <MenuItem disabled value="">
            Select an active connector instance
          </MenuItem>
          {connectors?.map((connector) => (
            <MenuItem key={connector.id} value={connector.id}>
              {connector.label}
            </MenuItem>
          ))}
        </TextField>
        <AuthoringFieldLabel
          description="The event codes that this endpoint is permitted to receive. They are validated by the selected connector and must be supplied one per line or separated by commas."
          label="Webhook event types"
        />
        <TextField
          fullWidth
          helperText="One server-recognized event type per line or separated with commas."
          label="Verified event types"
          minRows={3}
          multiline
          onChange={(event) => setEventTypes(event.target.value)}
          required
          value={eventTypes}
        />
        <AuthoringFieldLabel
          description="The largest permitted request body in bytes. The API applies this ingress limit before routing work, protecting the control plane from unexpectedly large payloads."
          label="Webhook body limit"
        />
        <TextField
          fullWidth
          label="Maximum body bytes"
          onChange={(event) => setMaximumBodyBytes(event.target.value)}
          required
          type="number"
          value={maximumBodyBytes}
        />
        <AuthoringFieldLabel
          description="The maximum ingress requests allowed per minute for this endpoint. It is a server-enforced safety limit, not a browser-side throttle."
          label="Webhook request rate"
        />
        <TextField
          fullWidth
          label="Maximum requests per minute"
          onChange={(event) => setMaximumRequestsPerMinute(event.target.value)}
          required
          type="number"
          value={maximumRequestsPerMinute}
        />
        <TextField
          fullWidth
          helperText="Optional opaque trigger identity; request content cannot choose a trigger."
          label="Analysis trigger ID (optional)"
          onChange={(event) => setAnalysisTriggerId(event.target.value)}
          value={analysisTriggerId}
        />
        <AuthoringFieldLabel
          description="A bounded endpoint policy object. Place only normal endpoint options here; select registered external-secret references separately so neither values nor locators enter this JSON."
          label="Webhook settings"
        />
        <TextField
          fullWidth
          helperText="JSON object only. Put external references in the registered-reference selector below."
          label="Webhook settings"
          minRows={5}
          multiline
          onChange={(event) => setSettings(event.target.value)}
          required
          value={settings}
        />
        <Box
          component="fieldset"
          sx={{ border: "1px solid", borderColor: "divider", m: 0, p: 2 }}
        >
          <Typography component="legend" variant="overline">
            Registered secret references
          </Typography>
          <Typography color="text.secondary" variant="body2">
            Select opaque registrations only. Secret values and external
            locators are never entered, displayed, or returned here.
          </Typography>
          {references !== undefined && references.length === 0 ? (
            <Alert severity="info" sx={{ mt: 1 }}>
              No active registered references are available. Register one above
              only when your connector needs it.
            </Alert>
          ) : null}
          <FormGroup sx={{ mt: 1 }}>
            {references?.map((reference) => (
              <FormControlLabel
                control={
                  <Checkbox
                    checked={registrationIds.includes(reference.id)}
                    onChange={(event) =>
                      toggleReference(reference.id, event.target.checked)
                    }
                  />
                }
                key={reference.id}
                label={reference.label}
              />
            ))}
          </FormGroup>
        </Box>
        <Box>
          <Button
            disabled={
              busy || connectors === undefined || loadError !== undefined
            }
            onClick={() => void submit()}
            variant="contained"
          >
            {busy ? "Creating draft…" : "Create webhook endpoint draft"}
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
}

function PlatformLinksForm({
  client,
  onCompleted,
}: {
  readonly client: Pick<
    CaseWeaverApiClient,
    "platformLinks" | "savePlatformLinks"
  >;
  readonly onCompleted: () => Promise<void> | void;
}) {
  const [apiPublicBaseUrl, setApiPublicBaseUrl] = useState("");
  const [webhookPublicBaseUrl, setWebhookPublicBaseUrl] = useState("");
  const [revision, setRevision] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const links = await client.platformLinks();
      setApiPublicBaseUrl(links.settings.apiPublicBaseUrl);
      setWebhookPublicBaseUrl(links.settings.webhookPublicBaseUrl);
      setRevision(links.revision);
    } catch (nextError) {
      if (isMissingPlatformLinks(nextError)) {
        setApiPublicBaseUrl("");
        setWebhookPublicBaseUrl("");
        setRevision(undefined);
      } else {
        setError(nextError);
      }
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (
      apiPublicBaseUrl.trim().length === 0 ||
      webhookPublicBaseUrl.trim().length === 0
    ) {
      setError(new Error("Provide both public base URLs."));
      return;
    }
    setSaving(true);
    setError(undefined);
    setSaved(undefined);
    try {
      await client.savePlatformLinks({
        apiPublicBaseUrl: apiPublicBaseUrl.trim(),
        webhookPublicBaseUrl: webhookPublicBaseUrl.trim(),
        ...(revision === undefined ? {} : { expectedRevision: revision }),
      });
      await load();
      setSaved(
        "Public links were saved as a new immutable configuration version.",
      );
      await onCompleted();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Paper
      component="section"
      elevation={0}
      sx={{ border: "1px solid", borderColor: "divider", p: { xs: 2, md: 3 } }}
    >
      <Stack
        component="form"
        spacing={2}
        onSubmit={(event) => event.preventDefault()}
      >
        <Box>
          <Typography variant="overline">Public links</Typography>
          <Typography variant="h5">
            Configure public API and webhook bases
          </Typography>
          <Typography color="text.secondary" variant="body2">
            These bases are persisted workspace configuration. The API
            normalizes URLs and derives webhook URLs from opaque endpoint IDs,
            never from a request Host header.
          </Typography>
        </Box>
        {error === undefined ? null : (
          <ApiFailure error={error} retry={() => void load()} />
        )}
        {saved === undefined ? null : <Alert severity="success">{saved}</Alert>}
        <TextField
          autoComplete="url"
          disabled={loading}
          fullWidth
          helperText="HTTPS is required unless server deployment policy explicitly permits loopback HTTP."
          label="Public API base URL"
          onChange={(event) => setApiPublicBaseUrl(event.target.value)}
          required
          value={apiPublicBaseUrl}
        />
        <AuthoringFieldLabel
          description="The public base used in links to the CaseWeaver API. The API normalizes this deployment-owned URL and never derives it from an inbound request Host header."
          label="Public API base URL"
        />
        <TextField
          autoComplete="url"
          disabled={loading}
          fullWidth
          helperText="The API appends only its fixed /webhooks/{opaque endpoint} route."
          label="Public webhook base URL"
          onChange={(event) => setWebhookPublicBaseUrl(event.target.value)}
          required
          value={webhookPublicBaseUrl}
        />
        <AuthoringFieldLabel
          description="The public ingress base for server-derived webhook URLs. The API appends only opaque endpoint routes; operators cannot supply a webhook path or runtime target here."
          label="Public webhook base URL"
        />
        <Typography color="text.secondary" variant="caption">
          {revision === undefined
            ? "No workspace public-link configuration exists yet. Saving creates the first inert draft."
            : `Current server-owned revision: ${revision}`}
        </Typography>
        <Box>
          <Button
            disabled={loading || saving}
            onClick={() => void submit()}
            variant="contained"
          >
            {saving ? "Saving public links…" : "Save public links"}
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
}
