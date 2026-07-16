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

import { useApiClient } from "../api/context.js";
import { ApiFailure } from "../components/api-failure.js";
import { DescriptorFieldHelp } from "../components/descriptor-field-help.js";

/**
 * Registers an external-secret locator only. It intentionally offers no field
 * for a secret value and clears its transient input after every terminal API
 * response.
 */
export function SecretReferenceRegistration({
  onRegistered,
}: {
  readonly onRegistered: () => void;
}) {
  const client = useApiClient();
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState<string>();
  const [error, setError] = useState<unknown>();

  const submit = async () => {
    const candidate = reference.trim();
    if (candidate.length < 3 || !candidate.includes(":")) {
      setError(new Error("Enter an external secret-backend reference."));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    setSaved(undefined);
    try {
      const registration = await client.createSecretReference({
        reference: candidate,
      });
      setSaved(`${registration.label} is available for descriptor forms.`);
      onRegistered();
    } catch (submissionError) {
      setError(submissionError);
    } finally {
      // References are not values, but keep no credential-adjacent input in
      // browser state once this request has reached a terminal response.
      setReference("");
      setSubmitting(false);
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
          <Typography variant="overline">Secret references</Typography>
          <Typography variant="h5">Register where a secret lives</Typography>
          <Typography color="text.secondary" variant="body2">
            Register a pointer to a secret that you have already provisioned for
            the API or worker. Never paste the password, token, or other
            credential value here. The console sends the pointer once; later
            forms see only its generated registration ID.
          </Typography>
        </Box>
        <Alert severity="info">
          The open-source runtime included with CaseWeaver resolves environment
          references in the form <code>env:UPPERCASE_NAME</code>. For example,
          register <code>env:GITHUB_TOKEN</code> for a private Git repository or{" "}
          <code>env:JITBIT_API_TOKEN</code> for Jitbit, then provide the actual
          value only to the API/worker deployment environment. A deployment can
          supply a different server-side resolver, but the browser never
          receives the secret value or its resolved location.
        </Alert>
        {error === undefined ? null : <ApiFailure error={error} />}
        {saved === undefined ? null : <Alert severity="success">{saved}</Alert>}
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="subtitle2">External secret reference</Typography>
          <DescriptorFieldHelp
            description="This is an opaque server-side locator, not a password or token. In the bundled runtime use env: followed by an uppercase environment-variable name."
            examples={["env:GITHUB_TOKEN", "env:JITBIT_API_TOKEN"]}
            label="External secret reference"
            onUseExample={setReference}
          />
        </Stack>
        <TextField
          autoComplete="off"
          fullWidth
          helperText="For the bundled runtime: env:UPPERCASE_NAME. The actual secret belongs in the API/worker environment, never in this form."
          label="External secret reference"
          onChange={(event) => setReference(event.target.value)}
          required
          slotProps={{ htmlInput: { maxLength: 512 } }}
          value={reference}
        />
        <Box>
          <Button
            disabled={submitting}
            onClick={() => void submit()}
            type="button"
            variant="outlined"
          >
            {submitting ? "Registering…" : "Register reference"}
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
}
