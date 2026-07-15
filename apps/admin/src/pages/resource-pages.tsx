import {
  Datagrid,
  List,
  Show,
  SimpleShowLayout,
  TextField,
  useRecordContext,
  useResourceContext,
} from "react-admin";
import {
  Box,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";

import type {
  ConfigurationHistoryResponse,
  ConfigurationInspection,
} from "../api/contracts.js";
import { useApiClient } from "../api/context.js";

function ConfigurationHistoryPanel() {
  const record = useRecordContext<{ readonly id?: string }>();
  const resource = useResourceContext();
  const client = useApiClient();
  const [inspection, setInspection] = useState<ConfigurationInspection>();
  const [history, setHistory] = useState<ConfigurationHistoryResponse>();
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (
      record?.id === undefined ||
      (resource !== "connector-instances" &&
        resource !== "ai-provider-instances")
    ) {
      return;
    }
    const abort = new AbortController();
    void Promise.all([
      client.configurationInspection(record.id, abort.signal),
      client.configurationHistory(record.id, { limit: 25 }, abort.signal),
    ])
      .then(([nextInspection, nextHistory]) => {
        setInspection(nextInspection);
        setHistory(nextHistory);
      })
      .catch(() => setUnavailable(true));
    return () => abort.abort();
  }, [client, record?.id, resource]);

  if (
    record?.id === undefined ||
    (resource !== "connector-instances" && resource !== "ai-provider-instances")
  ) {
    return null;
  }
  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", mt: 2, p: 2 }}>
      <Typography variant="overline">
        Immutable configuration history
      </Typography>
      {inspection === undefined && !unavailable ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: 1 }}>
          <CircularProgress size={16} />
          <Typography variant="body2">Loading audited metadata…</Typography>
        </Stack>
      ) : null}
      {unavailable ? (
        <Typography color="text.secondary" variant="body2">
          Immutable configuration metadata is not currently available.
        </Typography>
      ) : null}
      {inspection === undefined ? null : (
        <Stack spacing={0.75} sx={{ mt: 1 }}>
          <Typography variant="body2">
            Lifecycle: {inspection.lifecycle} · revision {inspection.revision}
          </Typography>
          {inspection.currentVersion === undefined ? null : (
            <Typography color="text.secondary" variant="body2">
              Current immutable version {inspection.currentVersion.version} ·{" "}
              {inspection.currentVersion.secretReferenceCount} secret reference
              {inspection.currentVersion.secretReferenceCount === 1 ? "" : "s"}
            </Typography>
          )}
          {history === undefined ? null : (
            <>
              <Divider sx={{ my: 0.5 }} />
              {history.items.map((version) => (
                <Typography key={version.id} variant="body2">
                  Version {version.version} · {version.createdAt} · settings
                  digest {version.canonicalSettingsSha256.slice(0, 12)}…
                </Typography>
              ))}
            </>
          )}
        </Stack>
      )}
    </Box>
  );
}

export function AdminResourceList() {
  return (
    <List perPage={25} sort={{ field: "updatedAt", order: "DESC" }}>
      <Datagrid bulkActionButtons={false} rowClick="show">
        <TextField source="label" />
        <TextField source="status" />
        <TextField source="version" />
        <TextField source="updatedAt" />
      </Datagrid>
    </List>
  );
}

export function AdminResourceShow() {
  return (
    <Show>
      <SimpleShowLayout>
        <TextField source="label" />
        <TextField source="status" />
        <TextField source="version" />
        <TextField source="updatedAt" />
        <TextField source="summary" />
        <ConfigurationHistoryPanel />
      </SimpleShowLayout>
    </Show>
  );
}
