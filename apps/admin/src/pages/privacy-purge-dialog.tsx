import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";

import type { ActionOutcome, ActionPreview } from "../api/contracts.js";
import { ApiFailure } from "../components/api-failure.js";

export interface PrivacyPurgeClient {
  previewPrivacyPurge(
    caseSnapshotId: string,
    reason: string,
  ): Promise<ActionPreview>;
  executeAction(previewId: string): Promise<ActionOutcome>;
}

/**
 * Deliberately separate from generic actions: the required privacy reason is
 * sent only to the dedicated API route, then cleared from React state as soon
 * as that request completes. It is never included in an action preview DTO.
 */
export function PrivacyPurgeDialog({
  client,
  snapshotId,
  onCompleted,
}: {
  readonly client: PrivacyPurgeClient;
  readonly snapshotId: string;
  readonly onCompleted?: (outcome: ActionOutcome) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ActionPreview>();
  const [outcome, setOutcome] = useState<ActionOutcome>();
  const [error, setError] = useState<unknown>();
  const [working, setWorking] = useState(false);

  const requestPreview = async () => {
    const submittedReason = reason;
    setWorking(true);
    setError(undefined);
    try {
      setPreview(await client.previewPrivacyPurge(snapshotId, submittedReason));
    } catch (previewError: unknown) {
      setError(previewError);
    } finally {
      // A privacy reason is not a secret, but it can still be sensitive. The
      // durable, session-bound preview retains it only server side.
      setReason("");
      setWorking(false);
    }
  };

  const execute = async () => {
    if (preview === undefined || !preview.canConfirm) return;
    setWorking(true);
    setError(undefined);
    try {
      const value = await client.executeAction(preview.previewId);
      setOutcome(value);
      onCompleted?.(value);
    } catch (executionError: unknown) {
      setError(executionError);
    } finally {
      setWorking(false);
    }
  };

  const close = () => {
    if (working) return;
    setOpen(false);
    setReason("");
    setPreview(undefined);
    setOutcome(undefined);
    setError(undefined);
  };

  return (
    <>
      <Button color="warning" onClick={() => setOpen(true)} variant="contained">
        Request privacy purge
      </Button>
      <Dialog fullWidth maxWidth="sm" onClose={close} open={open}>
        <DialogTitle>Request governed privacy purge</DialogTitle>
        <DialogContent dividers>
          <Typography color="text.secondary" sx={{ mb: 2 }} variant="body2">
            This is a destructive, server-governed request. Snapshot content is
            never loaded into the browser.
          </Typography>
          {preview === undefined ? (
            <TextField
              autoFocus
              disabled={working}
              fullWidth
              helperText="This reason is sent once to the server preview and then cleared from this browser."
              label="Privacy purge reason"
              multiline
              onChange={(event) => setReason(event.target.value)}
              required
              slotProps={{ htmlInput: { maxLength: 4000 } }}
              value={reason}
            />
          ) : (
            <Box>
              <Typography id="privacy-purge-impact">
                {preview.impact}
              </Typography>
              <Typography sx={{ mt: 1 }} variant="body2">
                {preview.confirmation}
              </Typography>
              {!preview.canConfirm ? (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  The server does not permit this request.
                </Alert>
              ) : null}
            </Box>
          )}
          {error === undefined ? null : <ApiFailure error={error} />}
          {outcome === undefined ? null : (
            <Alert
              severity={
                outcome.outcome === "outcome_unknown" ? "warning" : "success"
              }
              sx={{ mt: 2 }}
            >
              {outcome.message}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button disabled={working} onClick={close}>
            Close
          </Button>
          {preview === undefined ? (
            <Button
              disabled={working || reason.trim().length === 0}
              onClick={() => void requestPreview()}
              variant="contained"
            >
              Request server preview
            </Button>
          ) : (
            <Button
              color="warning"
              disabled={working || !preview.canConfirm || outcome !== undefined}
              onClick={() => void execute()}
              variant="contained"
            >
              Confirm privacy purge
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
}
