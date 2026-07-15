import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import { useState } from "react";

import type { CaseWeaverApiClient } from "../api/api-client.js";
import { ApiFailure } from "./api-failure.js";

type LifecycleResource = "publication-profiles" | "webhook-endpoints";

/**
 * Versioned publication and webhook lifecycle control. The UI requests the
 * current server-owned revision at confirmation time and submits only that
 * revision plus the requested lifecycle; profile definitions, endpoint
 * settings, selected secret registrations, bodies, and headers never return
 * through this control.
 */
export function PublicationWebhookLifecycleControl({
  client,
  resource,
  resourceId,
  status,
  onCompleted,
}: {
  readonly client: Pick<
    CaseWeaverApiClient,
    | "configurationInspection"
    | "transitionPublicationProfile"
    | "transitionWebhookEndpoint"
  >;
  readonly resource: LifecycleResource;
  readonly resourceId: string;
  readonly status?: string;
  readonly onCompleted: () => Promise<void> | void;
}) {
  const targetLifecycle = status === "active" ? "disabled" : "active";
  const actionLabel = targetLifecycle === "active" ? "Activate" : "Disable";
  const subject =
    resource === "publication-profiles"
      ? "publication profile"
      : "webhook endpoint";
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>();
  const [completed, setCompleted] = useState<string>();

  const show = async () => {
    setOpen(true);
    setRevision(undefined);
    setCompleted(undefined);
    setError(undefined);
    setLoading(true);
    try {
      const inspection = await client.configurationInspection(resourceId);
      setRevision(inspection.revision);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setLoading(false);
    }
  };

  const transition = async () => {
    if (revision === undefined) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const input = {
        expectedRevision: revision,
        lifecycle: targetLifecycle,
      } as const;
      if (resource === "publication-profiles") {
        await client.transitionPublicationProfile(resourceId, input);
      } else {
        await client.transitionWebhookEndpoint(resourceId, input);
      }
      setCompleted(
        `${actionLabel}d ${subject}. The API created a successor immutable configuration version.`,
      );
      await onCompleted();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button onClick={() => void show()} size="small" variant="outlined">
        {actionLabel}
      </Button>
      <Dialog
        aria-describedby={`${resourceId}-lifecycle-description`}
        fullWidth
        maxWidth="sm"
        onClose={() => setOpen(false)}
        open={open}
      >
        <DialogTitle>
          {actionLabel} {subject}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography id={`${resourceId}-lifecycle-description`}>
              {targetLifecycle === "active"
                ? "The API validates the current immutable configuration before enabling future work."
                : "This stops future use while retaining immutable versions and already accepted work."}
            </Typography>
            {loading ? (
              <Typography color="text.secondary" variant="body2">
                Loading the current server-owned revision…
              </Typography>
            ) : null}
            {error === undefined ? null : <ApiFailure error={error} />}
            {completed === undefined ? null : (
              <Alert severity="success">{completed}</Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={submitting} onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button
            disabled={loading || revision === undefined || submitting}
            onClick={() => void transition()}
            variant="contained"
          >
            {submitting ? `${actionLabel}ing…` : actionLabel}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
