import { Box, Button, Paper, Stack, Typography } from "@mui/material";
import { useState } from "react";

import type { DiagnosticExportStatus } from "../api/contracts.js";
import { useApiClient } from "../api/context.js";
import { ApiFailure } from "../components/api-failure.js";

/**
 * Explicit, user-driven diagnostics workflow. It does not poll, cache export
 * bytes, or construct storage URLs: every request reaches the audited API.
 */
export function DiagnosticExportPanel() {
  const client = useApiClient();
  const [status, setStatus] = useState<DiagnosticExportStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const request = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await client.requestDiagnosticExport());
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    if (status === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await client.diagnosticExportStatus(status.id));
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    if (status === undefined || status.status !== "ready") return;
    setBusy(true);
    setError(undefined);
    try {
      const objectUrl = URL.createObjectURL(
        await client.downloadDiagnosticExport(status.id),
      );
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `caseweaver-diagnostics-${status.id}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper
      component="section"
      elevation={0}
      sx={{ border: "1px solid", borderColor: "divider", p: 2 }}
    >
      <Typography variant="overline">Audited diagnostics export</Typography>
      <Typography gutterBottom variant="h6">
        Generate redacted operational evidence
      </Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 760 }} variant="body2">
        The API queues a bounded export for a worker. Status and download are
        separate, auditable actions; secret values, storage locations, and
        connector or provider payloads never reach this console.
      </Typography>
      <Stack
        direction="row"
        spacing={1}
        sx={{ flexWrap: "wrap", gap: 1, mt: 2 }}
      >
        <Button
          disabled={busy}
          onClick={() => void request()}
          variant="contained"
        >
          Request diagnostic export
        </Button>
        {status === undefined ? null : (
          <Button
            disabled={busy}
            onClick={() => void refresh()}
            variant="outlined"
          >
            Refresh export status
          </Button>
        )}
        {status?.status === "ready" ? (
          <Button
            disabled={busy}
            onClick={() => void download()}
            variant="outlined"
          >
            Download redacted export
          </Button>
        ) : null}
      </Stack>
      {status === undefined ? null : (
        <Box sx={{ mt: 2 }}>
          <Typography aria-live="polite" variant="body2">
            Export {status.id}: {status.status}
            {status.failureCode === undefined ? "" : ` (${status.failureCode})`}
          </Typography>
          <Typography color="text.secondary" variant="caption">
            Expires {status.expiresAt}
          </Typography>
        </Box>
      )}
      {error === undefined ? null : (
        <Box sx={{ mt: 2 }}>
          <ApiFailure
            error={error}
            retry={status === undefined ? request : refresh}
          />
        </Box>
      )}
    </Paper>
  );
}
