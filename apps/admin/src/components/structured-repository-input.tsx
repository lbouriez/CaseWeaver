import { Box, MenuItem, Stack, TextField, Typography } from "@mui/material";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Descriptor-selected repository primitive. It models a tagged local/remote
 * object but never examines a filesystem, repository, or network endpoint.
 */
export function StructuredRepositoryInput({
  label,
  required,
  value,
  onChange,
}: {
  readonly label: string;
  readonly required: boolean;
  readonly value: unknown;
  readonly onChange: (value: Readonly<Record<string, unknown>>) => void;
}) {
  const repository = isRecord(value) ? value : {};
  const kind =
    repository.kind === "local" || repository.kind === "remote"
      ? repository.kind
      : "";
  return (
    <Box component="fieldset" sx={{ border: 0, m: 0, p: 0 }}>
      <Typography component="legend" variant="subtitle2">
        {label}
      </Typography>
      <Stack spacing={2}>
        <TextField
          fullWidth
          label={`${label} location`}
          onChange={(event) => {
            const nextKind = event.target.value as "local" | "remote";
            onChange({ kind: nextKind });
          }}
          required={required}
          select
          value={kind}
        >
          <MenuItem disabled value="">
            Select repository location
          </MenuItem>
          <MenuItem value="remote">Remote HTTPS repository</MenuItem>
          <MenuItem value="local">Trusted local repository</MenuItem>
        </TextField>
        {kind === "remote" ? (
          <TextField
            fullWidth
            helperText="The server validates HTTPS, credential-free URLs and performs any repository access."
            label={`${label} HTTPS URL`}
            onChange={(event) => onChange({ kind, url: event.target.value })}
            required={required}
            value={stringValue(repository.url)}
          />
        ) : null}
        {kind === "local" ? (
          <TextField
            fullWidth
            helperText="The server validates this path against deployment-owned trusted roots. The browser never reads it."
            label={`${label} local path`}
            onChange={(event) => onChange({ kind, path: event.target.value })}
            required={required}
            value={stringValue(repository.path)}
          />
        ) : null}
      </Stack>
    </Box>
  );
}

/** Generic tagged reference primitive. The descriptor—not its connector type—opts in. */
export function StructuredGitReferenceInput({
  label,
  required,
  value,
  onChange,
}: {
  readonly label: string;
  readonly required: boolean;
  readonly value: unknown;
  readonly onChange: (value: Readonly<Record<string, unknown>>) => void;
}) {
  const reference = isRecord(value) ? value : {};
  const kind =
    reference.kind === "branch" || reference.kind === "tag"
      ? reference.kind
      : "";
  return (
    <Box component="fieldset" sx={{ border: 0, m: 0, p: 0 }}>
      <Typography component="legend" variant="subtitle2">
        {label}
      </Typography>
      <Stack spacing={2}>
        <TextField
          fullWidth
          label={`${label} type`}
          onChange={(event) => {
            const nextKind = event.target.value as "branch" | "tag";
            onChange({ kind: nextKind });
          }}
          required={required}
          select
          value={kind}
        >
          <MenuItem disabled value="">
            Select reference type
          </MenuItem>
          <MenuItem value="branch">Branch</MenuItem>
          <MenuItem value="tag">Tag</MenuItem>
        </TextField>
        <TextField
          fullWidth
          helperText="The server validates the reference name and resolves the exact repository state."
          label={`${label} name`}
          onChange={(event) => onChange({ kind, name: event.target.value })}
          required={required}
          value={stringValue(reference.name)}
        />
      </Stack>
    </Box>
  );
}
