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
  DescriptorSchema,
  JsonScalar,
  SecretReferenceSlot,
} from "../api/contracts.js";

type FormValues = Readonly<Record<string, unknown>>;

interface DescriptorFormProps {
  readonly descriptor: ConfigurationDescriptor;
  /** Redacted server-side registrations; their external locators never reach the UI. */
  readonly secretReferences?: readonly AdminListItem[];
  readonly onSubmit: (
    settings: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  readonly submitLabel: string;
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
    if (childSchema.type !== "object") continue;
    const nestedError = requiredError(childSchema, values, [...path, field]);
    if (nestedError !== undefined) return nestedError;
  }
  return undefined;
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
  if (secretSlot !== undefined) {
    return (
      <SecretReferenceSelector
        onChange={onChange}
        references={secretReferences}
        required={required || secretSlot.required}
        slot={secretSlot}
        value={valueAtPath(values, path)}
      />
    );
  }

  const label = schema.title ?? name;
  const helperText = schema.description;
  const value = valueAtPath(values, path);

  if (schema.format === "json") {
    return (
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
    );
  }

  if (schema.type === "object") {
    return (
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
    );
  }

  if (schema.type === "boolean") {
    return (
      <FormControlLabel
        control={
          <Checkbox
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
        }
        label={label}
      />
    );
  }

  if (schema.enum !== undefined) {
    return (
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
    );
  }

  return (
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
}: DescriptorFormProps) {
  const [values, setValues] = useState<FormValues>(() =>
    defaultValues(descriptor.settingsSchema),
  );
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const properties = descriptor.settingsSchema.properties ?? {};
  const fieldsInGroups = useMemo(
    () => new Set(descriptor.uiGroups.flatMap((group) => group.fields)),
    [descriptor.uiGroups],
  );
  const ungrouped = Object.entries(properties).filter(
    ([name]) => !fieldsInGroups.has(name),
  );

  const change = (path: readonly string[], value: unknown) => {
    setValues((current) => setAtPath(current, path, value));
  };

  const submit = async () => {
    const jsonError = invalidJsonError(descriptor.settingsSchema, values);
    if (jsonError !== undefined) {
      setError(jsonError);
      return;
    }
    const validationError = requiredError(descriptor.settingsSchema, values);
    if (validationError !== undefined) {
      setError(validationError);
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch {
      setError("The draft could not be saved. No configuration was assumed.");
    } finally {
      setSubmitting(false);
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
