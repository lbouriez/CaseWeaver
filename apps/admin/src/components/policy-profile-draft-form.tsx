import {
  Alert,
  Box,
  Button,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";

import type {
  CaseWeaverApiClient,
  PolicyProfileResource,
} from "../api/api-client.js";
import { ApiFailure } from "./api-failure.js";
import { AuthoringFieldLabel } from "./authoring-field-label.js";
import { parseSafeConfiguration } from "./safe-configuration-json.js";

const profileCopy: Readonly<
  Record<
    PolicyProfileResource,
    Readonly<{
      readonly overline: string;
      readonly title: string;
      readonly description: string;
      readonly displayNameLabel: string;
      readonly settingsLabel: string;
      readonly submitLabel: string;
    }>
  >
> = {
  "retrieval-profiles": {
    overline: "Retrieval policy",
    title: "Create a retrieval profile draft",
    description:
      "Enter bounded evidence-policy settings as a server-validated JSON object. The API owns profile identity, immutable versioning, retrieval scope, and authorization.",
    displayNameLabel: "Retrieval profile display name",
    settingsLabel: "Retrieval policy settings",
    submitLabel: "Create retrieval profile draft",
  },
  "prompt-profiles": {
    overline: "Prompt policy",
    title: "Create a prompt profile draft",
    description:
      "Enter bounded prompt-policy settings as a server-validated JSON object. The API owns profile identity, immutable versioning, template validation, and authorization.",
    displayNameLabel: "Prompt profile display name",
    settingsLabel: "Prompt policy settings",
    submitLabel: "Create prompt profile draft",
  },
};

// Keep the browser boundary aligned with the API's `policyProfileDraft`
// schema. The server remains authoritative.
const maximumProfileDisplayNameLength = 160;

/**
 * Provider-neutral authoring for managed retrieval and prompt policy profiles.
 * It intentionally accepts no secret reference, endpoint, model, connector, or
 * runtime field; the server validates the opaque policy object and records the
 * immutable draft/audit transaction.
 */
export function PolicyProfileDraftForm({
  client,
  resource,
  onCompleted,
}: {
  readonly client: Pick<CaseWeaverApiClient, "createPolicyProfileDraft">;
  readonly resource: PolicyProfileResource;
  readonly onCompleted: () => Promise<void> | void;
}) {
  const copy = profileCopy[resource];
  const [displayName, setDisplayName] = useState("");
  const [settings, setSettings] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [savedLabel, setSavedLabel] = useState<string>();

  const submit = async () => {
    let parsedSettings: Readonly<Record<string, unknown>>;
    try {
      const normalizedName = displayName.trim();
      if (
        normalizedName.length < 1 ||
        normalizedName.length > maximumProfileDisplayNameLength
      ) {
        throw new Error(
          `Provide a ${copy.overline.toLowerCase()} display name.`,
        );
      }
      parsedSettings = parseSafeConfiguration(settings, copy.settingsLabel);
    } catch (nextError) {
      if (
        nextError instanceof Error &&
        nextError.message.includes("Credential-shaped")
      ) {
        // Do not retain secret-like material in the controlled text field.
        setSettings("{}");
      }
      setError(nextError);
      return;
    }
    setBusy(true);
    setError(undefined);
    setSavedLabel(undefined);
    try {
      const saved = await client.createPolicyProfileDraft(resource, {
        displayName: displayName.trim(),
        settings: parsedSettings,
      });
      setSavedLabel(saved.label);
      setDisplayName("");
      setSettings("{}");
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
          <Typography variant="overline">{copy.overline}</Typography>
          <Typography variant="h5">{copy.title}</Typography>
          <Typography color="text.secondary" variant="body2">
            {copy.description}
          </Typography>
        </Box>
        {error === undefined ? null : <ApiFailure error={error} />}
        {savedLabel === undefined ? null : (
          <Alert severity="success">Draft {savedLabel} was created.</Alert>
        )}
        <TextField
          fullWidth
          label={copy.displayNameLabel}
          onChange={(event) => setDisplayName(event.target.value)}
          required
          slotProps={{
            htmlInput: { maxLength: maximumProfileDisplayNameLength },
          }}
          value={displayName}
        />
        <AuthoringFieldLabel
          description="Enter only bounded retrieval or prompt policy settings. The API validates the object, owns immutable versioning, and rejects credential-shaped fields; this form cannot configure an endpoint, model, connector, or secret."
          label={copy.settingsLabel}
        />
        <TextField
          fullWidth
          helperText="JSON object only. Credential-shaped fields are rejected locally; this form has no secret inputs."
          label={copy.settingsLabel}
          minRows={8}
          multiline
          onChange={(event) => setSettings(event.target.value)}
          required
          value={settings}
        />
        <Box>
          <Button
            disabled={busy}
            onClick={() => void submit()}
            variant="contained"
          >
            {busy ? "Creating draft…" : copy.submitLabel}
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
}
