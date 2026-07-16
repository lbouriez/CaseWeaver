import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";

import type {
  AdminListItem,
  ConfigurationDescriptor,
  ConnectorDraftTestOperation,
  ConnectorDraftTestPreview,
  ConnectorDraftTestResult,
  DescriptorSchema,
  JsonScalar,
  SecretReferenceSlot,
} from "../api/contracts.js";
import { DescriptorFieldHelp } from "./descriptor-field-help.js";
import {
  StructuredGitReferenceInput,
  StructuredRepositoryInput,
} from "./structured-repository-input.js";

type FormValues = Readonly<Record<string, unknown>>;

interface DescriptorFormProps {
  readonly descriptor: ConfigurationDescriptor;
  /** Redacted server-side registrations; their external locators never reach the UI. */
  readonly secretReferences?: readonly AdminListItem[];
  readonly onSubmit: (
    settings: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  readonly submitLabel: string;
  /** Present only when the API has composed safe test operations for this descriptor. */
  readonly testOperations?: readonly ConnectorDraftTestOperation[];
  readonly onPreviewTest?: (
    operation: string,
    settings: Readonly<Record<string, unknown>>,
  ) => Promise<ConnectorDraftTestPreview>;
  readonly onRunTest?: (
    operation: string,
    settings: Readonly<Record<string, unknown>>,
    confirmationId: string,
  ) => Promise<ConnectorDraftTestResult>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAtPath(values: FormValues, path: readonly string[]): unknown {
  let current: unknown = values;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function setAtPath(
  values: FormValues,
  path: readonly string[],
  value: unknown,
): FormValues {
  const [head, ...tail] = path;
  if (head === undefined) return values;
  if (tail.length === 0) return { ...values, [head]: value };

  const nested = values[head];
  return {
    ...values,
    [head]: setAtPath(isRecord(nested) ? nested : {}, tail, value),
  };
}

function defaultValues(schema: DescriptorSchema): FormValues {
  const properties = schema.properties ?? {};
  return Object.fromEntries(
    Object.entries(properties).flatMap(([name, field]) => {
      if (field.default === undefined) return [];
      return [[name, field.default]];
    }),
  );
}

function scalarFromInput(value: string, schema: DescriptorSchema): unknown {
  if (schema.format === "json") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        (schema.type === "object" && isRecord(parsed)) ||
        (schema.type === "array" && Array.isArray(parsed))
      ) {
        return parsed;
      }
    } catch {
      // Preserve the bounded text until submit, where a clear local validation
      // message prevents an invalid configuration from crossing the boundary.
    }
    return value;
  }
  if (schema.type === "number" || schema.type === "integer") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (schema.type === "array") {
    return value
      .split(/\r?\n|,/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return value;
}

/** Examples are descriptor metadata, but structured editor examples still need
 * to enter the form as their declared object rather than JSON-looking text. */
function valueFromExample(value: string, schema: DescriptorSchema): unknown {
  if (schema.inputKind !== undefined && schema.type === "object") {
    return structuredValueFromInput(value);
  }
  return scalarFromInput(value, schema);
}

/** Structured input kinds always represent tagged JSON objects. Their schema
 * deliberately need not advertise the generic JSON textarea format. */
function structuredValueFromInput(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Keep the bounded text until submit so local validation can show an
    // actionable error instead of silently discarding the operator's input.
  }
  return value;
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.join("\n");
  if (isRecord(value)) return JSON.stringify(value, undefined, 2);
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return "";
}

function invalidJsonError(
  schema: DescriptorSchema,
  values: FormValues,
  path: readonly string[] = [],
): string | undefined {
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    const childPath = [...path, name];
    const value = valueAtPath(values, childPath);
    if (
      child.inputKind !== undefined &&
      value !== undefined &&
      !isRecord(value)
    ) {
      return `${name} must be a valid JSON object.`;
    }
    if (
      child.format === "json" &&
      value !== undefined &&
      ((child.type === "object" && !isRecord(value)) ||
        (child.type === "array" && !Array.isArray(value)))
    ) {
      return `${name} must be valid JSON.`;
    }
    if (child.type === "object") {
      const nested = invalidJsonError(child, values, childPath);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function requiredError(
  schema: DescriptorSchema,
  values: FormValues,
  path: readonly string[] = [],
): string | undefined {
  const required = schema.required ?? [];
  for (const field of required) {
    const fieldPath = [...path, field];
    const value = valueAtPath(values, fieldPath);
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      return `${field} is required.`;
    }
  }
  for (const [field, childSchema] of Object.entries(schema.properties ?? {})) {
    const value = valueAtPath(values, [...path, field]);
    const inputKindError = structuredInputError(field, childSchema, value);
    if (inputKindError !== undefined) return inputKindError;
    if (childSchema.type !== "object") continue;
    const nestedError = requiredError(childSchema, values, [...path, field]);
    if (nestedError !== undefined) return nestedError;
  }
  return undefined;
}

/** Validates the generic tagged shapes selected by descriptor metadata. It
 * deliberately knows nothing about connector or provider types. */
function structuredInputError(
  field: string,
  schema: DescriptorSchema,
  value: unknown,
): string | undefined {
  if (schema.inputKind === undefined || value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) return `${field} must use the structured editor.`;
  if (schema.inputKind === "structured_repository") {
    if (value.kind !== "remote" && value.kind !== "local") {
      return `${field} location is required.`;
    }
    if (value.kind === "remote" && stringValue(value.url).trim().length === 0) {
      return `${field} HTTPS URL is required.`;
    }
    if (value.kind === "local" && stringValue(value.path).trim().length === 0) {
      return `${field} local path is required.`;
    }
  }
  if (schema.inputKind === "git_reference") {
    if (value.kind !== "branch" && value.kind !== "tag") {
      return `${field} type is required.`;
    }
    if (stringValue(value.name).trim().length === 0) {
      return `${field} name is required.`;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function SecretSlotNotice({ slot }: { readonly slot: SecretReferenceSlot }) {
  return (
    <Alert
      data-testid={`secret-slot-${slot.name}`}
      severity="info"
      sx={{ alignItems: "flex-start", borderRadius: 0 }}
    >
      <strong>{slot.label}</strong>
      <br />
      This is a server-managed secret reference. Secret values are never
      requested or shown by this console.
      {slot.required
        ? " A permitted reference must be configured before activation."
        : ""}
      {slot.acceptedReferenceKinds.length === 0
        ? " The descriptor accepts server-registered reference metadata."
        : ` Accepted reference kinds: ${slot.acceptedReferenceKinds.join(", ")}.`}
      {slot.supportsRotation
        ? " Rotation is supported through the secret-reference lifecycle."
        : " Rotation is controlled by the configured secret backend."}
    </Alert>
  );
}

function SecretReferenceSelector({
  slot,
  value,
  onChange,
  required,
  references,
}: {
  readonly slot: SecretReferenceSlot;
  readonly value: unknown;
  readonly onChange: (value: string) => void;
  readonly required: boolean;
  readonly references: readonly AdminListItem[];
}) {
  const active = references.filter(
    (reference) => reference.status === "active",
  );
  return (
    <TextField
      select
      fullWidth
      required={required}
      label={slot.label}
      helperText={
        active.length === 0
          ? "Register an external secret reference before creating this configuration. The secret value is never entered here."
          : "Select an opaque, server-registered secret reference. Secret values are never displayed or requested."
      }
      value={displayValue(value)}
      onChange={(event) => onChange(event.target.value)}
    >
      <MenuItem value="">Select a registered reference</MenuItem>
      {active.map((reference) => (
        <MenuItem key={reference.id} value={reference.id}>
          {reference.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

interface DescriptorFieldProps {
  readonly name: string;
  readonly schema: DescriptorSchema;
  readonly values: FormValues;
  readonly onChange: (value: unknown) => void;
  readonly required: boolean;
  readonly secretSlot?: SecretReferenceSlot;
  readonly secretReferences: readonly AdminListItem[];
  readonly path: readonly string[];
}

function DescriptorField({
  name,
  schema,
  values,
  onChange,
  required,
  secretSlot,
  secretReferences,
  path,
}: DescriptorFieldProps) {
  const label = schema.title ?? name;
  const value = valueAtPath(values, path);
  const help = (
    <DescriptorFieldHelp
      description={schema.description}
      examples={schema.examples}
      label={label}
      onUseExample={(example) => onChange(valueFromExample(example, schema))}
    />
  );

  if (secretSlot !== undefined) {
    return (
      <Stack spacing={1}>
        <SecretReferenceSelector
          onChange={onChange}
          references={secretReferences}
          required={required || secretSlot.required}
          slot={secretSlot}
          value={value}
        />
        <Alert severity="info" sx={{ alignItems: "flex-start" }}>
          This slot accepts{" "}
          {secretSlot.acceptedReferenceKinds.join(", ") || "server-registered"}{" "}
          reference metadata only.
          {secretSlot.supportsRotation
            ? " Rotation is supported after registration."
            : " Rotation is managed by the configured secret backend."}
        </Alert>
        {help}
      </Stack>
    );
  }

  const helperText = schema.description;

  if (schema.inputKind === "structured_repository") {
    return (
      <Stack spacing={1}>
        <StructuredRepositoryInput
          label={label}
          onChange={onChange}
          required={required}
          value={value}
        />
        <Accordion disableGutters>
          <AccordionSummary>Advanced JSON fallback</AccordionSummary>
          <AccordionDetails>
            <TextField
              fullWidth
              helperText="Use only when the structured repository editor cannot express the descriptor revision. The server remains authoritative."
              label={`${label} JSON fallback`}
              minRows={5}
              multiline
              value={displayValue(value)}
              onChange={(event) =>
                onChange(structuredValueFromInput(event.target.value))
              }
            />
          </AccordionDetails>
        </Accordion>
        {help}
      </Stack>
    );
  }

  if (schema.inputKind === "git_reference") {
    return (
      <Stack spacing={1}>
        <StructuredGitReferenceInput
          label={label}
          onChange={onChange}
          required={required}
          value={value}
        />
        <Accordion disableGutters>
          <AccordionSummary>Advanced JSON fallback</AccordionSummary>
          <AccordionDetails>
            <TextField
              fullWidth
              helperText="Use only when the structured reference editor cannot express the descriptor revision. The server remains authoritative."
              label={`${label} JSON fallback`}
              minRows={5}
              multiline
              value={displayValue(value)}
              onChange={(event) =>
                onChange(structuredValueFromInput(event.target.value))
              }
            />
          </AccordionDetails>
        </Accordion>
        {help}
      </Stack>
    );
  }

  if (schema.format === "json") {
    return (
      <Stack spacing={1}>
        <TextField
          fullWidth
          multiline
          minRows={5}
          required={required}
          label={label}
          helperText={`${helperText ?? ""} Enter a JSON ${schema.type ?? "value"}.`}
          value={displayValue(value)}
          onChange={(event) =>
            onChange(scalarFromInput(event.target.value, schema))
          }
        />
        {help}
      </Stack>
    );
  }

  if (schema.type === "object") {
    return (
      <Stack spacing={1}>
        <Box
          component="fieldset"
          sx={{
            border: "1px solid",
            borderColor: "divider",
            m: 0,
            p: 2,
            minWidth: 0,
          }}
        >
          <Typography component="legend" variant="overline">
            {label}
          </Typography>
          <Stack spacing={2}>
            {Object.entries(schema.properties ?? {}).map(
              ([childName, childSchema]) => (
                <DescriptorField
                  key={`${path.join(".")}.${childName}`}
                  name={childName}
                  schema={childSchema}
                  values={values}
                  onChange={(next) =>
                    onChange({
                      ...(isRecord(value) ? value : {}),
                      [childName]: next,
                    })
                  }
                  required={(schema.required ?? []).includes(childName)}
                  secretReferences={secretReferences}
                  path={[...path, childName]}
                />
              ),
            )}
          </Stack>
        </Box>
        {help}
      </Stack>
    );
  }

  if (schema.type === "boolean") {
    return (
      <Stack spacing={1}>
        <FormControlLabel
          control={
            <Checkbox
              checked={value === true}
              onChange={(event) => onChange(event.target.checked)}
            />
          }
          label={label}
        />
        {help}
      </Stack>
    );
  }

  if (schema.enum !== undefined) {
    return (
      <Stack spacing={1}>
        <TextField
          select
          fullWidth
          required={required}
          label={label}
          helperText={helperText}
          value={displayValue(value)}
          onChange={(event) =>
            onChange(scalarFromInput(event.target.value, schema))
          }
        >
          {schema.enum.map((option: JsonScalar) => (
            <MenuItem key={String(option)} value={String(option)}>
              {String(option)}
            </MenuItem>
          ))}
        </TextField>
        {help}
      </Stack>
    );
  }

  return (
    <Stack spacing={1}>
      <TextField
        fullWidth
        multiline={schema.type === "array"}
        minRows={schema.type === "array" ? 3 : undefined}
        required={required}
        type={
          schema.type === "number" || schema.type === "integer"
            ? "number"
            : "text"
        }
        label={label}
        helperText={
          schema.type === "array"
            ? `${helperText ?? ""} Enter one value per line or separate values with commas.`
            : helperText
        }
        value={displayValue(value)}
        onChange={(event) =>
          onChange(scalarFromInput(event.target.value, schema))
        }
      />
      {help}
    </Stack>
  );
}

function fieldsForGroup(
  descriptor: ConfigurationDescriptor,
  groupFields: readonly string[],
): readonly [string, DescriptorSchema][] {
  const properties = descriptor.settingsSchema.properties ?? {};
  const fields: [string, DescriptorSchema][] = [];
  for (const field of groupFields) {
    const schema = properties[field];
    if (schema !== undefined) fields.push([field, schema]);
  }
  return fields;
}

export function DescriptorForm({
  descriptor,
  secretReferences = [],
  onSubmit,
  submitLabel,
  testOperations = [],
  onPreviewTest,
  onRunTest,
}: DescriptorFormProps) {
  const [values, setValues] = useState<FormValues>(() =>
    defaultValues(descriptor.settingsSchema),
  );
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [selectedTestOperation, setSelectedTestOperation] = useState("");
  const [testPreview, setTestPreview] = useState<ConnectorDraftTestPreview>();
  const [testResult, setTestResult] = useState<ConnectorDraftTestResult>();
  const properties = descriptor.settingsSchema.properties ?? {};
  const fieldsInGroups = useMemo(
    () => new Set(descriptor.uiGroups.flatMap((group) => group.fields)),
    [descriptor.uiGroups],
  );
  const ungrouped = Object.entries(properties).filter(
    ([name]) => !fieldsInGroups.has(name),
  );

  const change = (path: readonly string[], value: unknown) => {
    // A confirmation is bound to the exact server-validated candidate. Never
    // leave it actionable after a field or secret-reference selection changes.
    setTestPreview(undefined);
    setTestResult(undefined);
    setValues((current) => setAtPath(current, path, value));
  };

  const validatedSettings = ():
    | Readonly<Record<string, unknown>>
    | undefined => {
    const jsonError = invalidJsonError(descriptor.settingsSchema, values);
    if (jsonError !== undefined) {
      setError(jsonError);
      return undefined;
    }
    const validationError = requiredError(descriptor.settingsSchema, values);
    if (validationError !== undefined) {
      setError(validationError);
      return undefined;
    }
    setError(undefined);
    return values;
  };

  const submit = async () => {
    const settings = validatedSettings();
    if (settings === undefined) return;
    setSubmitting(true);
    try {
      await onSubmit(settings);
    } catch {
      setError("The draft could not be saved. No configuration was assumed.");
    } finally {
      setSubmitting(false);
    }
  };

  const operation =
    testOperations.find(
      (candidate) => candidate.operation === selectedTestOperation,
    ) ?? testOperations[0];
  const previewTest = async () => {
    if (operation === undefined || onPreviewTest === undefined) return;
    const settings = validatedSettings();
    if (settings === undefined) return;
    setTesting(true);
    setTestPreview(undefined);
    setTestResult(undefined);
    try {
      const preview = await onPreviewTest(operation.operation, settings);
      setTestPreview(preview);
    } catch {
      setError(
        "The configuration test preview could not be prepared. No connector was invoked.",
      );
    } finally {
      setTesting(false);
    }
  };

  const runTest = async () => {
    if (
      operation === undefined ||
      onRunTest === undefined ||
      testPreview?.confirmationId === undefined
    ) {
      return;
    }
    const settings = validatedSettings();
    if (settings === undefined) return;
    setTesting(true);
    try {
      const result = await onRunTest(
        operation.operation,
        settings,
        testPreview.confirmationId,
      );
      setTestResult(result);
      setTestPreview(undefined);
    } catch {
      setError(
        "The configuration test could not be completed. Its outcome may require server-side review.",
      );
      setTestPreview(undefined);
    } finally {
      setTesting(false);
    }
  };

  const renderField = ([name, schema]: [string, DescriptorSchema]) => (
    <DescriptorField
      key={name}
      name={name}
      schema={schema}
      values={values}
      onChange={(value) => change([name], value)}
      required={(descriptor.settingsSchema.required ?? []).includes(name)}
      secretSlot={descriptor.secretSlots.find((slot) => slot.name === name)}
      secretReferences={secretReferences}
      path={[name]}
    />
  );

  return (
    <Stack
      component="form"
      spacing={2}
      onSubmit={(event) => event.preventDefault()}
    >
      {error === undefined ? null : <Alert severity="error">{error}</Alert>}
      {ungrouped.map(renderField)}
      {descriptor.uiGroups.map((group) => {
        const fields = fieldsForGroup(descriptor, group.fields);
        const content = (
          <Stack key={`${group.id}-fields`} spacing={2}>
            {fields.map(renderField)}
          </Stack>
        );
        return group.advanced ? (
          <Accordion key={group.id} disableGutters>
            <AccordionSummary>{group.title} · advanced</AccordionSummary>
            <AccordionDetails>{content}</AccordionDetails>
          </Accordion>
        ) : (
          <Box key={group.id}>
            <Typography variant="overline">{group.title}</Typography>
            {content}
          </Box>
        );
      })}
      {descriptor.secretSlots
        .filter((slot) => properties[slot.name] === undefined)
        .map((slot) => (
          <SecretSlotNotice key={slot.name} slot={slot} />
        ))}
      {onPreviewTest === undefined || onRunTest === undefined ? null : (
        <Stack spacing={1}>
          <Typography variant="subtitle2">Test before creating</Typography>
          <Typography color="text.secondary" variant="body2">
            A test validates this unpersisted configuration on the server. It
            does not create or activate a connector instance.
          </Typography>
          {testOperations.length === 0 ? (
            <Alert severity="info">
              No safe test operation is currently composed for this descriptor.
            </Alert>
          ) : null}
          {testOperations.length <= 1 ? null : (
            <TextField
              fullWidth
              label="Configuration test operation"
              onChange={(event) => {
                setSelectedTestOperation(event.target.value);
                setTestPreview(undefined);
                setTestResult(undefined);
              }}
              select
              value={operation?.operation ?? ""}
            >
              {testOperations.map((candidate) => (
                <MenuItem key={candidate.operation} value={candidate.operation}>
                  {candidate.operation}
                </MenuItem>
              ))}
            </TextField>
          )}
          {testResult === undefined ? null : (
            <Alert
              severity={
                testResult.outcome === "succeeded"
                  ? "success"
                  : testResult.outcome === "outcome_unknown"
                    ? "warning"
                    : "error"
              }
            >
              Configuration test {testResult.outcome.replaceAll("_", " ")}.
            </Alert>
          )}
          {testPreview === undefined ? (
            <Box>
              <Button
                disabled={testing || operation === undefined}
                onClick={() => void previewTest()}
                type="button"
                variant="outlined"
              >
                {testing ? "Preparing test…" : "Preview configuration test"}
              </Button>
            </Box>
          ) : testPreview.canConfirm &&
            testPreview.confirmationId !== undefined ? (
            <Stack spacing={1}>
              <Alert severity="warning">
                {testPreview.impact ??
                  "The server will run the bounded configuration test."}
              </Alert>
              <Box>
                <Button
                  disabled={testing}
                  onClick={() => void runTest()}
                  type="button"
                  variant="contained"
                >
                  {testing
                    ? "Running test…"
                    : "Confirm and run configuration test"}
                </Button>
              </Box>
            </Stack>
          ) : (
            <Alert severity="info">
              {testPreview.reasonCode === undefined
                ? "This configuration test is not currently available."
                : `This configuration test is unavailable: ${testPreview.reasonCode}.`}
            </Alert>
          )}
        </Stack>
      )}
      <Box>
        <Button
          color="primary"
          disabled={submitting}
          onClick={() => void submit()}
          type="button"
          variant="contained"
        >
          {submitting ? "Saving draft…" : submitLabel}
        </Button>
      </Box>
    </Stack>
  );
}
