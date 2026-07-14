export const REDACTED_DIAGNOSTIC_VALUE = "[Redacted]";
export const UNSUPPORTED_DIAGNOSTIC_VALUE = "[Unsupported]";

export type DiagnosticPrimitive = string | number | boolean | null;
export interface DiagnosticObject {
  readonly [key: string]: DiagnosticValue;
}
export type DiagnosticValue =
  | DiagnosticPrimitive
  | readonly DiagnosticValue[]
  | DiagnosticObject;
export type DiagnosticAttributes = Readonly<Record<string, DiagnosticValue>>;

export type DiagnosticSeverity = "debug" | "info" | "warn" | "error";

export interface DiagnosticEvent {
  readonly name: string;
  readonly occurredAt: string;
  readonly severity: DiagnosticSeverity;
  readonly attributes: DiagnosticAttributes;
}

export interface DiagnosticEventInput {
  readonly name: string;
  readonly occurredAt?: Date;
  readonly severity?: DiagnosticSeverity;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface DiagnosticSink {
  record(event: DiagnosticEvent): void;
}

export interface DiagnosticExportSource {
  snapshot(): readonly DiagnosticEvent[];
}

export interface DiagnosticExport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly events: readonly DiagnosticEvent[];
}

const sensitiveNames = new Set([
  "apikey",
  "apikeyid",
  "authorization",
  "attachment",
  "body",
  "connectionstring",
  "content",
  "cookie",
  "credential",
  "databaseurl",
  "header",
  "headers",
  "message",
  "password",
  "payload",
  "privatekey",
  "prompt",
  "query",
  "raw",
  "rawbody",
  "rawrequest",
  "rawresponse",
  "request",
  "response",
  "secret",
  "text",
  "token",
  "url",
]);

const identifierNames = new Set([
  "analysisid",
  "attemptid",
  "correlationid",
  "errorcode",
  "failurecode",
  "jobid",
  "operationid",
  "requestid",
  "sourceid",
  "workspaceid",
]);

const sensitivePrefixesOrSuffixes = [
  "apikey",
  "attachment",
  "authorization",
  "body",
  "content",
  "credential",
  "header",
  "message",
  "password",
  "payload",
  "privatekey",
  "prompt",
  "query",
  "raw",
  "request",
  "response",
  "secret",
  "text",
  "token",
  "url",
] as const;

function normalizedName(name: string): string {
  return name.replaceAll(/[^a-z0-9]/giu, "").toLocaleLowerCase("en-US");
}

function isSensitiveName(name: string): boolean {
  const normalized = normalizedName(name);
  if (identifierNames.has(normalized)) return false;
  return (
    sensitiveNames.has(normalized) ||
    sensitivePrefixesOrSuffixes.some(
      (sensitive) =>
        normalized.startsWith(sensitive) || normalized.endsWith(sensitive),
    )
  );
}

function freezeValue(value: DiagnosticValue): DiagnosticValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeValue));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          freezeValue(nested),
        ]),
      ),
    );
  }
  return value;
}

function redactValue(
  value: unknown,
  visited: WeakSet<object>,
): DiagnosticValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : UNSUPPORTED_DIAGNOSTIC_VALUE;
  }
  if (typeof value !== "object") {
    return UNSUPPORTED_DIAGNOSTIC_VALUE;
  }
  if (visited.has(value)) {
    return "[Circular]";
  }
  if (value instanceof Error) {
    return Object.freeze({
      name: "Error",
      message: REDACTED_DIAGNOSTIC_VALUE,
    });
  }

  visited.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: DiagnosticValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        entries.push(
          descriptor !== undefined && "value" in descriptor
            ? redactValue(descriptor.value, visited)
            : REDACTED_DIAGNOSTIC_VALUE,
        );
      }
      return Object.freeze(entries);
    }

    const attributes: Record<string, DiagnosticValue> = {};
    for (const key of Object.keys(value)) {
      if (isSensitiveName(key)) {
        attributes[key] = REDACTED_DIAGNOSTIC_VALUE;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      attributes[key] =
        descriptor !== undefined && "value" in descriptor
          ? redactValue(descriptor.value, visited)
          : REDACTED_DIAGNOSTIC_VALUE;
    }
    return Object.freeze(attributes);
  } finally {
    visited.delete(value);
  }
}

export function redactDiagnosticAttributes(
  attributes: Readonly<Record<string, unknown>>,
): DiagnosticAttributes {
  const redacted: Record<string, DiagnosticValue> = {};
  for (const key of Object.keys(attributes)) {
    if (isSensitiveName(key)) {
      redacted[key] = REDACTED_DIAGNOSTIC_VALUE;
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(attributes, key);
    redacted[key] =
      descriptor !== undefined && "value" in descriptor
        ? redactValue(descriptor.value, new WeakSet<object>())
        : REDACTED_DIAGNOSTIC_VALUE;
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(redacted).map(([key, value]) => [key, freezeValue(value)]),
    ),
  );
}

function assertEventName(name: string): void {
  if (!/^[a-z][a-z0-9_.-]{0,119}$/u.test(name)) {
    throw new RangeError("Diagnostic event name is invalid.");
  }
}

export function createDiagnosticEvent(
  input: DiagnosticEventInput,
): DiagnosticEvent {
  assertEventName(input.name);
  const occurredAt = input.occurredAt ?? new Date();
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new RangeError("Diagnostic event time is invalid.");
  }
  return Object.freeze({
    name: input.name,
    occurredAt: occurredAt.toISOString(),
    severity: input.severity ?? "info",
    attributes: redactDiagnosticAttributes(input.attributes ?? {}),
  });
}

export function redactDiagnosticEvent(event: DiagnosticEvent): DiagnosticEvent {
  assertEventName(event.name);
  const occurredAt = new Date(event.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new RangeError("Diagnostic event time is invalid.");
  }
  return Object.freeze({
    name: event.name,
    occurredAt: occurredAt.toISOString(),
    severity: event.severity,
    attributes: redactDiagnosticAttributes(event.attributes),
  });
}

export function createDiagnosticExport(
  source: DiagnosticExportSource,
  generatedAt: Date = new Date(),
): DiagnosticExport {
  if (!Number.isFinite(generatedAt.getTime())) {
    throw new RangeError("Diagnostic export time is invalid.");
  }
  return Object.freeze({
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    events: Object.freeze(source.snapshot().map(redactDiagnosticEvent)),
  });
}
