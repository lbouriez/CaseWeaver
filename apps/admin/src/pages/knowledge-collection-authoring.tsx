import {
  Alert,
  Box,
  Button,
  CircularProgress,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";

import { useApiClient } from "../api/context.js";
import type { AdminListItem } from "../api/contracts.js";
import { ApiFailure } from "../components/api-failure.js";
import { DescriptorFieldHelp } from "../components/descriptor-field-help.js";

/**
 * Authoring boundary for a collection's permanent vector-space identity.
 * It deliberately selects only an aggregate ID: the API resolves and pins the
 * active immutable embedding-binding version inside its audit transaction.
 */
export function KnowledgeCollectionAuthoring({
  enabled,
  onCreated,
}: {
  readonly enabled: boolean;
  readonly onCreated: () => void;
}) {
  const client = useApiClient();
  const [bindings, setBindings] = useState<readonly AdminListItem[]>();
  const [bindingId, setBindingId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [profileVersion, setProfileVersion] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setBindings(undefined);
    void client
      .list("ai-bindings", { limit: 200 }, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        // "embedding" is a stable CaseWeaver role, not a provider/model
        // identifier. The API still validates that its active version exposes
        // the embedding capability before persisting the collection.
        const embeddingBindings = response.items.filter(
          (binding) =>
            binding.status === "active" && binding.label === "embedding",
        );
        setBindings(embeddingBindings);
        setBindingId(embeddingBindings[0]?.id ?? "");
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(loadError);
      });
    return () => controller.abort();
  }, [client, enabled]);

  if (!enabled) return null;

  const submit = async () => {
    const parsedDimensions = Number(dimensions);
    if (!Number.isInteger(parsedDimensions) || parsedDimensions < 1) {
      setError(
        new Error("Embedding dimensions must be a positive whole number."),
      );
      return;
    }
    if (bindingId.length === 0) {
      setError(new Error("Create and activate an embedding binding first."));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    setSaved(undefined);
    try {
      const result = await client.createKnowledgeCollection({
        collectionId: collectionId.trim(),
        embeddingBindingId: bindingId,
        embeddingProfileVersion: profileVersion.trim(),
        dimensions: parsedDimensions,
      });
      setSaved(`Collection ${result.label} is ready for new source drafts.`);
      setCollectionId("");
      onCreated();
    } catch (submissionError) {
      setError(submissionError);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Paper
      component="section"
      elevation={0}
      sx={{ border: "1px solid", borderColor: "divider", p: { xs: 2, md: 3 } }}
    >
      <Stack
        component="form"
        onSubmit={(event) => event.preventDefault()}
        spacing={2}
      >
        <Box>
          <Typography variant="overline">Knowledge collections</Typography>
          <Typography variant="h5">Create a collection</Typography>
          <Typography color="text.secondary" variant="body2">
            A collection is a permanent, workspace-scoped vector space for
            indexed knowledge. Create a separate collection when its embedding
            model, vector dimensions, or compatibility profile must differ.
          </Typography>
        </Box>
        {error === undefined ? null : <ApiFailure error={error} />}
        {saved === undefined ? null : <Alert severity="success">{saved}</Alert>}
        {bindings === undefined && error === undefined ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <CircularProgress size={18} />
            <Typography variant="body2">
              Finding active embedding bindings…
            </Typography>
          </Stack>
        ) : null}
        {bindings !== undefined && bindings.length === 0 ? (
          <Alert severity="info">
            Create and activate an embedding binding in AI configuration before
            creating a collection. This prevents a collection from silently
            changing vector model later.
          </Alert>
        ) : null}
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="subtitle2">Collection ID</Typography>
          <DescriptorFieldHelp
            description="A durable workspace identifier, such as support-knowledge. It cannot be renamed or repointed after creation because existing document vectors depend on it."
            examples={["support-knowledge", "engineering-handbook"]}
            label="Collection ID"
          />
        </Stack>
        <TextField
          autoComplete="off"
          fullWidth
          helperText="Use lowercase letters, digits, dots, underscores, or hyphens; for example support-knowledge."
          label="Collection ID"
          onChange={(event) => setCollectionId(event.target.value)}
          required
          slotProps={{
            htmlInput: { maxLength: 200, pattern: "[A-Za-z0-9._-]+" },
          }}
          value={collectionId}
        />
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="subtitle2">Embedding binding</Typography>
          <DescriptorFieldHelp
            description="The active CaseWeaver embedding binding that turns text into vectors. The API pins its exact active version, so later AI configuration changes cannot alter this collection."
            label="Embedding binding"
          />
        </Stack>
        <TextField
          disabled={bindings === undefined || bindings.length === 0}
          fullWidth
          label="Active embedding binding"
          onChange={(event) => setBindingId(event.target.value)}
          required
          select
          value={bindingId}
        >
          <MenuItem disabled value="">
            Select an active embedding binding
          </MenuItem>
          {bindings?.map((binding) => (
            <MenuItem key={binding.id} value={binding.id}>
              {binding.id}
            </MenuItem>
          ))}
        </TextField>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="subtitle2">Embedding compatibility</Typography>
          <DescriptorFieldHelp
            description="A deployment-defined compatibility label for the embedding representation. Keep it stable for all data queried together; change it only when deliberately starting a separate vector space."
            label="Embedding profile version"
          />
        </Stack>
        <TextField
          autoComplete="off"
          fullWidth
          helperText="Use the version label documented for the selected binding; it is not a provider endpoint or model name."
          label="Embedding profile version"
          onChange={(event) => setProfileVersion(event.target.value)}
          required
          slotProps={{
            htmlInput: { maxLength: 200, pattern: "[A-Za-z0-9._-]+" },
          }}
          value={profileVersion}
        />
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="subtitle2">Embedding dimensions</Typography>
          <DescriptorFieldHelp
            description="The number of values in each vector produced by the selected embedding binding. Use the exact binding-specific value; it cannot be changed after documents are indexed."
            label="Embedding dimensions"
          />
        </Stack>
        <TextField
          fullWidth
          helperText="Use the exact vector size documented for the active embedding binding."
          inputMode="numeric"
          label="Embedding dimensions"
          onChange={(event) => setDimensions(event.target.value)}
          required
          slotProps={{ htmlInput: { min: 1, max: 100000, step: 1 } }}
          type="number"
          value={dimensions}
        />
        <Box>
          <Button
            disabled={
              submitting ||
              bindings === undefined ||
              bindings.length === 0 ||
              collectionId.trim().length === 0 ||
              profileVersion.trim().length === 0 ||
              dimensions.length === 0
            }
            onClick={() => void submit()}
            type="button"
            variant="contained"
          >
            {submitting ? "Creating…" : "Create immutable collection"}
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
}
