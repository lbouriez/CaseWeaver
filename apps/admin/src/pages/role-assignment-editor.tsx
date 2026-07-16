import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { useApiClient } from "../api/context.js";
import type {
  AdminListItem,
  WorkspaceRoleAssignment,
} from "../api/contracts.js";
import { ApiFailure } from "../components/api-failure.js";
import { AuthoringFieldLabel } from "../components/authoring-field-label.js";

const roles = ["administrator", "operator", "analyst", "viewer"] as const;
type WorkspaceRole = (typeof roles)[number];

/**
 * Membership editing is deliberately separate from generic resource CRUD. The
 * API supplies the workspace-wide revision and re-verifies the caller's
 * persisted administrator role in its atomic mutation transaction.
 */
export function RoleAssignmentEditor() {
  const client = useApiClient();
  const [principals, setPrincipals] = useState<readonly AdminListItem[]>();
  const [principalId, setPrincipalId] = useState("");
  const [assignment, setAssignment] = useState<WorkspaceRoleAssignment>();
  const [selectedRoles, setSelectedRoles] = useState<readonly WorkspaceRole[]>(
    [],
  );
  const [loadingError, setLoadingError] = useState<unknown>();
  const [mutationError, setMutationError] = useState<unknown>();
  const [saved, setSaved] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingError(undefined);
    void client
      .list("principals", { limit: 200 }, { signal: controller.signal })
      .then((result) => {
        setPrincipals(result.items);
        setPrincipalId(result.items[0]?.id ?? "");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadingError(error);
      });
    return () => controller.abort();
  }, [client]);

  useEffect(() => {
    const controller = new AbortController();
    setAssignment(undefined);
    setSelectedRoles([]);
    setSaved(undefined);
    if (principalId.length === 0) return () => controller.abort();
    void client
      .workspaceRoleAssignment(principalId, controller.signal)
      .then((next) => {
        setAssignment(next);
        setSelectedRoles(next.roles);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadingError(error);
      });
    return () => controller.abort();
  }, [client, principalId]);

  const toggle = (role: WorkspaceRole) => {
    setSelectedRoles((current) =>
      current.includes(role)
        ? current.filter((value) => value !== role)
        : [...current, role],
    );
  };

  const save = async () => {
    if (assignment === undefined || principalId.length === 0) return;
    setSaving(true);
    setMutationError(undefined);
    setSaved(undefined);
    try {
      await client.replaceWorkspaceRoles(principalId, {
        roles: selectedRoles,
        expectedRevision: assignment.revision,
      });
      const refreshed = await client.workspaceRoleAssignment(principalId);
      setAssignment(refreshed);
      setSelectedRoles(refreshed.roles);
      setSaved(
        `Roles were updated at workspace revision ${refreshed.revision}.`,
      );
    } catch (error) {
      setMutationError(error);
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
      <Stack spacing={2}>
        <Box>
          <Typography variant="overline">Workspace roles</Typography>
          <Typography variant="h5">Replace an operator's role set</Typography>
          <Typography color="text.secondary" variant="body2">
            This uses a workspace-wide optimistic revision. The API refuses a
            stale update and refuses to remove the final administrator.
          </Typography>
        </Box>
        {loadingError === undefined ? null : (
          <ApiFailure error={loadingError} />
        )}
        {mutationError === undefined ? null : (
          <ApiFailure error={mutationError} />
        )}
        {saved === undefined ? null : <Alert severity="success">{saved}</Alert>}
        {principals !== undefined && principals.length === 0 ? (
          <Alert severity="info">
            No principals are available in this workspace.
          </Alert>
        ) : null}
        <TextField
          fullWidth
          label="Principal"
          onChange={(event) => setPrincipalId(event.target.value)}
          select
          value={principalId}
        >
          <MenuItem disabled value="">
            Select a principal
          </MenuItem>
          {principals?.map((principal) => (
            <MenuItem key={principal.id} value={principal.id}>
              {principal.label}
            </MenuItem>
          ))}
        </TextField>
        {assignment === undefined ? null : (
          <>
            <Typography color="text.secondary" variant="body2">
              Current workspace role revision: {assignment.revision}
            </Typography>
            <AuthoringFieldLabel
              description="Roles are workspace permissions, not application-specific labels. The API re-authorizes this replacement atomically, rejects stale revisions, and prevents removal of the final administrator."
              label="Workspace roles"
            />
            <Stack
              direction={{ xs: "column", sm: "row" }}
              sx={{ flexWrap: "wrap" }}
            >
              {roles.map((role) => (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={selectedRoles.includes(role)}
                      onChange={() => toggle(role)}
                    />
                  }
                  key={role}
                  label={role}
                />
              ))}
            </Stack>
            <Box>
              <Button
                disabled={saving}
                onClick={() => void save()}
                variant="contained"
              >
                {saving ? "Replacing roles…" : "Replace roles"}
              </Button>
            </Box>
          </>
        )}
      </Stack>
    </Paper>
  );
}
