import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import { useState } from "react";

import type {
  ActionOutcome,
  ActionPreview,
  AdminActionName,
  AdminResourceName,
} from "../api/contracts.js";
import { ApiFailure } from "./api-failure.js";

export interface ActionClient {
  readonly previewAction: (
    action: AdminActionName,
    target: { readonly resource: AdminResourceName; readonly id?: string },
  ) => Promise<ActionPreview>;
  readonly executeAction: (previewId: string) => Promise<ActionOutcome>;
}

export function ActionConfirmationDialog({
  action,
  target,
  client,
  label,
  onCompleted,
}: {
  readonly action: AdminActionName;
  readonly target: {
    readonly resource: AdminResourceName;
    readonly id?: string;
  };
  readonly client: ActionClient;
  readonly label: string;
  readonly onCompleted?: (outcome: ActionOutcome) => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ActionPreview>();
  const [error, setError] = useState<unknown>();
  const [outcome, setOutcome] = useState<ActionOutcome>();
  const [working, setWorking] = useState(false);

  const openDialog = async () => {
    setOpen(true);
    setPreview(undefined);
    setOutcome(undefined);
    setError(undefined);
    setWorking(true);
    try {
      setPreview(await client.previewAction(action, target));
    } catch (previewError: unknown) {
      setError(previewError);
    } finally {
      setWorking(false);
    }
  };

  const confirm = async () => {
    if (preview === undefined || !preview.canConfirm) return;
    setWorking(true);
    setError(undefined);
    try {
      const nextOutcome = await client.executeAction(preview.previewId);
      setOutcome(nextOutcome);
      onCompleted?.(nextOutcome);
    } catch (executionError: unknown) {
      setError(executionError);
    } finally {
      setWorking(false);
    }
  };

  const close = () => {
    if (!working) setOpen(false);
  };

  return (
    <>
      <Button
        color="primary"
        onClick={() => void openDialog()}
        variant="contained"
      >
        {label}
      </Button>
      <Dialog
        aria-describedby="action-preview-impact"
        fullWidth
        maxWidth="sm"
        onClose={close}
        open={open}
      >
        <DialogTitle>Confirm server-reviewed operation</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {working && preview === undefined ? (
              <Typography aria-live="polite">
                Requesting the server impact preview…
              </Typography>
            ) : null}
            {error === undefined ? null : <ApiFailure error={error} />}
            {preview === undefined ? null : (
              <>
                <Typography id="action-preview-impact">
                  {preview.impact}
                </Typography>
                <Divider />
                <Box>
                  <Typography variant="overline">
                    Server confirmation
                  </Typography>
                  <Typography>{preview.confirmation}</Typography>
                </Box>
                <Box>
                  <Typography variant="overline">Estimated cost</Typography>
                  <Typography>
                    {preview.estimatedCost === undefined
                      ? "Unknown — the server did not provide a price estimate."
                      : `${preview.estimatedCost.amount} ${preview.estimatedCost.currency}`}
                  </Typography>
                </Box>
                {!preview.canConfirm ? (
                  <Alert severity="warning">
                    The server does not permit confirmation for this preview.
                  </Alert>
                ) : null}
              </>
            )}
            {outcome === undefined ? null : (
              <Alert
                severity={
                  outcome.outcome === "outcome_unknown" ? "warning" : "success"
                }
              >
                {outcome.outcome === "outcome_unknown"
                  ? "Outcome unknown. Do not repeat the operation; inspect the durable operation record."
                  : outcome.message}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={working} onClick={close}>
            Close
          </Button>
          <Button
            color="primary"
            disabled={
              working ||
              preview === undefined ||
              !preview.canConfirm ||
              outcome !== undefined
            }
            onClick={() => void confirm()}
            variant="contained"
          >
            Confirm operation
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
