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
          <Typography variant="h5">Register an external reference</Typography>
          <Typography color="text.secondary" variant="body2">
            Enter an opaque locator in your configured secret backend, never a
            password, token, or credential value. The locator is retained only
            by the API and is never displayed by this console.
          </Typography>
        </Box>
        {error === undefined ? null : <ApiFailure error={error} />}
        {saved === undefined ? null : <Alert severity="success">{saved}</Alert>}
        <TextField
          autoComplete="off"
          fullWidth
          helperText="For example, a scheme-qualified reference accepted by your secret backend."
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
