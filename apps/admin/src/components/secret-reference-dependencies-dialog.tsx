import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
} from "@mui/material";
import { useState } from "react";

import type { SecretReferenceDependencies } from "../api/contracts.js";
import { ApiFailure } from "./api-failure.js";

export interface SecretReferenceDependencyClient {
  readonly secretReferenceDependencies: (
    secretReferenceId: string,
    signal?: AbortSignal,
  ) => Promise<SecretReferenceDependencies>;
}

/** An audited read before a lifecycle operation. The dialog deliberately shows
 * only configuration identities, never an external locator or secret value. */
export function SecretReferenceDependenciesDialog({
  client,
  secretReferenceId,
}: {
  readonly client: SecretReferenceDependencyClient;
  readonly secretReferenceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<SecretReferenceDependencies>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);

  const inspect = async () => {
    setOpen(true);
    setResult(undefined);
    setError(undefined);
    setLoading(true);
    try {
      setResult(await client.secretReferenceDependencies(secretReferenceId));
    } catch (nextError: unknown) {
      setError(nextError);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button onClick={() => void inspect()} variant="text">
        Inspect dependencies
      </Button>
      <Dialog
        aria-describedby="secret-reference-dependencies"
        fullWidth
        maxWidth="sm"
        onClose={() => {
          if (!loading) setOpen(false);
        }}
        open={open}
      >
        <DialogTitle>Active configuration dependencies</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography id="secret-reference-dependencies" variant="body2">
              This server-audited view lists active configurations that would be
              affected by revocation. It never displays the external locator or
              secret value.
            </Typography>
            {loading ? (
              <Typography aria-live="polite">Loading dependencies…</Typography>
            ) : null}
            {error === undefined ? null : <ApiFailure error={error} />}
            {result === undefined || result.items.length > 0 ? null : (
              <Alert severity="success">
                No active configuration depends on this reference. Revocation
                still requires the server-reviewed confirmation.
              </Alert>
            )}
            {result === undefined || result.items.length === 0 ? null : (
              <List dense disablePadding>
                {result.items.map((item) => (
                  <ListItem
                    divider
                    key={`${item.resourceType}:${item.configurationId}`}
                  >
                    <ListItemText
                      primary={item.resourceType}
                      secondary={item.configurationId}
                    />
                  </ListItem>
                ))}
              </List>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={loading} onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
