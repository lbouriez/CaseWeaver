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
import type { AdminDetail } from "../api/contracts.js";
import { ApiFailure } from "./api-failure.js";

type LifecycleResource = "knowledge-sources" | "schedules";
type LifecycleTarget = "active" | "disabled";

/**
 * A resource-specific lifecycle confirmation. It never receives connector,
 * source, schedule, collection, or configuration JSON: the API reads those
 * immutable records within its audited mutation transaction.
 */
export function SourceScheduleLifecycleControl({
  client,
  resource,
  resourceId,
  status,
  onCompleted,
}: {
  readonly client: Pick<
    CaseWeaverApiClient,
    | "configurationInspection"
    | "transitionKnowledgeSource"
    | "transitionKnowledgeSchedule"
  >;
  readonly resource: LifecycleResource;
  readonly resourceId: string;
  readonly status?: string;
  readonly onCompleted: (result: AdminDetail) => Promise<void> | void;
}) {
  const defaultTargetLifecycle: LifecycleTarget =
    status === "enabled" ? "disabled" : "active";
  const defaultActionLabel =
    defaultTargetLifecycle === "active" ? "Activate" : "Disable";
  const subject = resource === "knowledge-sources" ? "source" : "schedule";
  const [open, setOpen] = useState(false);
  const [dialogTargetLifecycle, setDialogTargetLifecycle] =
    useState<LifecycleTarget>(defaultTargetLifecycle);
  const [revision, setRevision] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>();
  const [completed, setCompleted] = useState<string>();

  const show = async () => {
    setOpen(true);
    setDialogTargetLifecycle(defaultTargetLifecycle);
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
        lifecycle: dialogTargetLifecycle,
      } as const;
      const result =
        resource === "knowledge-sources"
          ? await client.transitionKnowledgeSource(resourceId, input)
          : await client.transitionKnowledgeSchedule(resourceId, input);
      setCompleted(
        `${dialogActionLabel}d ${subject}. The API created a successor immutable configuration version.`,
      );
      await onCompleted(result);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSubmitting(false);
    }
  };
  const dialogActionLabel =
    dialogTargetLifecycle === "active" ? "Activate" : "Disable";

  return (
    <>
      <Button onClick={() => void show()} size="small" variant="outlined">
        {defaultActionLabel}
      </Button>
      <Dialog
        aria-describedby={`${resourceId}-lifecycle-description`}
        fullWidth
        maxWidth="sm"
        onClose={() => setOpen(false)}
        open={open}
      >
        <DialogTitle>
          {dialogActionLabel} {subject}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography id={`${resourceId}-lifecycle-description`}>
              {dialogTargetLifecycle === "active"
                ? "This enables the current immutable configuration. Existing work continues to reference its captured versions."
                : "This stops future work from this configuration without deleting its history or changing work that already captured a version."}
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
            {submitting ? `${dialogActionLabel}ing…` : dialogActionLabel}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
