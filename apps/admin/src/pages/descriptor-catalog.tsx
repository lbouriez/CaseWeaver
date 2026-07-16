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
import type {
  AdminListItem,
  ConfigurationDescriptor,
  ConnectorDraftTestOperation,
} from "../api/contracts.js";
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
  const [secretReferences, setSecretReferences] =
    useState<readonly AdminListItem[]>();
  const [selectedType, setSelectedType] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState<string>();
  const [testOperations, setTestOperations] =
    useState<readonly ConnectorDraftTestOperation[]>();
  const [testUnavailable, setTestUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setDescriptors(undefined);
    setError(undefined);
    void Promise.all([
      client.listDescriptors(kind, controller.signal),
      client.list(
        "secret-references",
        { limit: 200 },
        { signal: controller.signal },
      ),
    ])
      .then(([items, references]) => {
        setDescriptors(items);
        setSecretReferences(references.items);
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

  useEffect(() => {
    const controller = new AbortController();
    setTestOperations(undefined);
    setTestUnavailable(false);
    if (
      kind !== "connector" ||
      selected === undefined ||
      selected.supportedTestOperations.length === 0
    ) {
      setTestOperations([]);
      return () => controller.abort();
    }
    void client
      .connectorDraftTestOperations(selected.type, controller.signal)
      .then(setTestOperations)
      .catch(() => {
        if (!controller.signal.aborted) {
          setTestOperations([]);
          setTestUnavailable(true);
        }
      });
    return () => controller.abort();
  }, [client, kind, selected]);

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
        {(descriptors === undefined || secretReferences === undefined) &&
        error === undefined ? (
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
            {testUnavailable ? (
              <Alert severity="info">
                Connector configuration tests are unavailable until the server
                composes a safe operation for this descriptor.
              </Alert>
            ) : null}
            <DescriptorForm
              key={selected.type}
              descriptor={selected}
              secretReferences={secretReferences ?? []}
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
              {...(kind === "connector" && testOperations !== undefined
                ? {
                    testOperations,
                    onPreviewTest: (
                      operation: string,
                      settings: Readonly<Record<string, unknown>>,
                    ) =>
                      client.previewConnectorDraftTest(
                        selected.type,
                        operation,
                        settings,
                      ),
                    onRunTest: (
                      operation: string,
                      settings: Readonly<Record<string, unknown>>,
                      confirmationId: string,
                    ) =>
                      client.runConnectorDraftTest(
                        selected.type,
                        operation,
                        settings,
                        confirmationId,
                      ),
                  }
                : {})}
              submitLabel="Create server-validated draft"
            />
          </>
        )}
      </Stack>
    </Paper>
  );
}
