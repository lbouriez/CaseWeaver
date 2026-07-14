import {
  Alert,
  Box,
  CircularProgress,
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";

import { useApiClient } from "../api/context.js";
import type { ConfigurationDescriptor } from "../api/contracts.js";
import { ApiFailure } from "../components/api-failure.js";
import { DescriptorForm } from "../components/descriptor-form.js";

export function DescriptorCatalog({
  kind,
  title,
}: {
  readonly kind: ConfigurationDescriptor["kind"];
  readonly title: string;
}) {
  const client = useApiClient();
  const [descriptors, setDescriptors] =
    useState<readonly ConfigurationDescriptor[]>();
  const [selectedType, setSelectedType] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    setDescriptors(undefined);
    setError(undefined);
    void client
      .listDescriptors(kind, controller.signal)
      .then((items) => {
        setDescriptors(items);
        const first = items[0];
        if (first !== undefined) {
          setSelectedType(first.type);
          setDisplayName(first.displayName);
        }
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return;
        setError(loadError);
      });
    return () => controller.abort();
  }, [client, kind]);

  const selected = descriptors?.find(
    (descriptor) => descriptor.type === selectedType,
  );
  const selectDescriptor = (type: string) => {
    const next = descriptors?.find((descriptor) => descriptor.type === type);
    setSelectedType(type);
    setDisplayName(next?.displayName ?? "");
    setSaved(undefined);
  };

  return (
    <Paper
      component="section"
      elevation={0}
      sx={{ border: "1px solid", borderColor: "divider", p: { xs: 2, md: 3 } }}
    >
      <Stack spacing={2}>
        <Box>
          <Typography variant="overline">Descriptor registry</Typography>
          <Typography variant="h5">{title}</Typography>
          <Typography color="text.secondary" variant="body2">
            Registered types are read from the control plane. This form never
            requests a plaintext credential.
          </Typography>
        </Box>
        <Divider />
        {error === undefined ? null : <ApiFailure error={error} />}
        {descriptors === undefined && error === undefined ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <CircularProgress size={18} />
            <Typography>Discovering registered descriptors…</Typography>
          </Stack>
        ) : null}
        {descriptors !== undefined && descriptors.length === 0 ? (
          <Alert severity="info">
            No descriptors are registered. Install or enable a backend
            capability to make it available here.
          </Alert>
        ) : null}
        {selected === undefined ? null : (
          <>
            <TextField
              fullWidth
              label="Registered type"
              onChange={(event) => selectDescriptor(event.target.value)}
              select
              value={selectedType}
            >
              {descriptors?.map((descriptor) => (
                <MenuItem key={descriptor.type} value={descriptor.type}>
                  {descriptor.displayName} · {descriptor.version}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              fullWidth
              label="Instance display name"
              onChange={(event) => setDisplayName(event.target.value)}
              required
              slotProps={{ htmlInput: { maxLength: 160 } }}
              value={displayName}
            />
            {saved === undefined ? null : (
              <Alert severity="success">{saved}</Alert>
            )}
            <DescriptorForm
              descriptor={selected}
              onSubmit={async (settings) => {
                if (displayName.trim().length === 0) {
                  throw new Error("Display name is required.");
                }
                const draft = await client.createDescriptorDraft(kind, {
                  descriptorType: selected.type,
                  displayName: displayName.trim(),
                  settings,
                });
                setSaved(`Draft ${draft.label} is awaiting server validation.`);
              }}
              submitLabel="Create server-validated draft"
            />
          </>
        )}
      </Stack>
    </Paper>
  );
}
