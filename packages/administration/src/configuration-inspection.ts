import { z } from "zod";

const maximumHistoryPageSize = 100;
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().superRefine((value, context) => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    context.addIssue({ code: "custom", message: "Timestamp is invalid." });
  }
});
const safeDisplayName = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(
    (value) =>
      !/(?:\b(?:https?|s3|gs|file|data):|(?:object|download|signed)[_-]?(?:key|url)|\b(?:secret|token|password|credential|authorization|cookie)\b)/iu.test(
        value,
      ),
    "Display name is not safe for a public configuration DTO.",
  );

export const configurationInspectionLifecycles = [
  "draft",
  "active",
  "disabled",
  "superseded",
] as const;
export type ConfigurationInspectionLifecycle =
  (typeof configurationInspectionLifecycles)[number];

export const configurationSurfaceModes = [
  "managed",
  "read_only",
  "unavailable",
] as const;
export type ConfigurationSurfaceMode =
  (typeof configurationSurfaceModes)[number];

export const configurationSurfaceReasonCodes = [
  "deployment_owned",
  "not_configured",
  "workflow_not_composed",
  "unsupported_in_deployment",
] as const;
export type ConfigurationSurfaceReasonCode =
  (typeof configurationSurfaceReasonCodes)[number];

export const configurationWorkflowCapabilities = [
  "create_draft",
  "create",
  "replace",
  "validate",
  "activate",
  "disable",
  "inspect_history",
] as const;
export type ConfigurationWorkflowCapability =
  (typeof configurationWorkflowCapabilities)[number];

/** Operational commands are distinct from configuration authoring workflows. */
export const configurationSurfaceOperationalActions = [
  "source.synchronize",
  "source.fullRescan",
  "publication.approve",
] as const;
export type ConfigurationSurfaceOperationalAction =
  (typeof configurationSurfaceOperationalActions)[number];

export interface ConfigurationDescriptorIdentityDto {
  readonly kind: "connector" | "aiProvider";
  readonly type: string;
  readonly version: string;
}

export interface ConfigurationVersionSummaryDto {
  readonly id: string;
  readonly version: number;
  readonly createdAt: string;
  readonly canonicalSettingsSha256: string;
  readonly secretReferenceCount: number;
  readonly displayName?: string;
  readonly descriptor?: ConfigurationDescriptorIdentityDto;
}

/** Safe inspection of the current immutable configuration reference. */
export interface ConfigurationInspectionDto {
  readonly id: string;
  readonly resourceType: string;
  readonly lifecycle: ConfigurationInspectionLifecycle;
  readonly revision: number;
  readonly updatedAt: string;
  readonly currentVersionId?: string;
  readonly currentVersion?: ConfigurationVersionSummaryDto;
}

export interface ConfigurationHistoryPageDto {
  readonly items: readonly ConfigurationVersionSummaryDto[];
  readonly page: Readonly<{
    readonly hasNextPage: boolean;
    readonly endCursor?: string;
  }>;
}

/** Composition tells the UI exactly which configuration workflow is real. */
export interface ConfigurationSurfaceDto {
  readonly surface: string;
  readonly mode: ConfigurationSurfaceMode;
  readonly reasonCode?: ConfigurationSurfaceReasonCode;
  readonly reason?: string;
  readonly configurationId?: string;
  readonly workflows: readonly ConfigurationWorkflowCapability[];
  readonly operationalActions: readonly ConfigurationSurfaceOperationalAction[];
}

export interface ConfigurationHistoryQuery {
  readonly limit: number;
  readonly after?: string;
}

const descriptorIdentitySchema: z.ZodType<ConfigurationDescriptorIdentityDto> =
  z
    .object({
      kind: z.enum(["connector", "aiProvider"]),
      type: identifier,
      version: identifier,
    })
    .strict();

export const configurationVersionSummarySchema: z.ZodType<ConfigurationVersionSummaryDto> =
  z
    .object({
      id: identifier,
      version: z.number().int().min(1).max(1_000_000_000),
      createdAt: timestamp,
      canonicalSettingsSha256: digest,
      secretReferenceCount: z.number().int().min(0).max(100),
      displayName: safeDisplayName.optional(),
      descriptor: descriptorIdentitySchema.optional(),
    })
    .strict();

export const configurationInspectionSchema: z.ZodType<ConfigurationInspectionDto> =
  z
    .object({
      id: identifier,
      resourceType: identifier,
      lifecycle: z.enum(configurationInspectionLifecycles),
      revision: z.number().int().min(1).max(1_000_000_000),
      updatedAt: timestamp,
      currentVersionId: identifier.optional(),
      currentVersion: configurationVersionSummarySchema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.currentVersion !== undefined &&
        value.currentVersionId !== value.currentVersion.id
      ) {
        context.addIssue({
          code: "custom",
          message: "Current version identity does not match the configuration.",
        });
      }
      if (
        value.currentVersion !== undefined &&
        value.currentVersion.version > value.revision
      ) {
        context.addIssue({
          code: "custom",
          message: "Current version exceeds the configuration revision.",
        });
      }
    });

export const configurationHistoryPageSchema: z.ZodType<ConfigurationHistoryPageDto> =
  z
    .object({
      items: z
        .array(configurationVersionSummarySchema)
        .max(maximumHistoryPageSize),
      page: z
        .object({
          hasNextPage: z.boolean(),
          endCursor: z
            .string()
            .min(1)
            .max(512)
            .regex(/^[A-Za-z0-9_-]+$/u)
            .optional(),
        })
        .strict(),
    })
    .strict()
    .superRefine((value, context) => {
      const ids = new Set<string>();
      let previous = Number.POSITIVE_INFINITY;
      for (const item of value.items) {
        if (ids.has(item.id)) {
          context.addIssue({
            code: "custom",
            message: "History version is duplicated.",
          });
        }
        ids.add(item.id);
        if (item.version >= previous) {
          context.addIssue({
            code: "custom",
            message: "History versions must be ordered newest first.",
          });
        }
        previous = item.version;
      }
      if (value.page.hasNextPage !== (value.page.endCursor !== undefined)) {
        context.addIssue({
          code: "custom",
          message: "History cursor must match page availability.",
        });
      }
    });

export const configurationSurfaceSchema: z.ZodType<ConfigurationSurfaceDto> = z
  .object({
    surface: identifier,
    mode: z.enum(configurationSurfaceModes),
    reasonCode: z.enum(configurationSurfaceReasonCodes).optional(),
    reason: safeDisplayName.optional(),
    configurationId: identifier.optional(),
    workflows: z.array(z.enum(configurationWorkflowCapabilities)).max(5),
    operationalActions: z
      .array(z.enum(configurationSurfaceOperationalActions))
      .max(configurationSurfaceOperationalActions.length),
  })
  .strict()
  .superRefine((value, context) => {
    const hasReason =
      value.reasonCode !== undefined && value.reason !== undefined;
    if (value.mode === "managed") {
      if (value.reasonCode !== undefined || value.reason !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Managed surface cannot have an unavailable reason.",
        });
      }
      if (!value.workflows.includes("inspect_history")) {
        context.addIssue({
          code: "custom",
          message: "Managed surface must support history inspection.",
        });
      }
    } else {
      if (!hasReason) {
        context.addIssue({
          code: "custom",
          message: "Non-managed surface requires a safe reason.",
        });
      }
      if (value.workflows.length > 0) {
        context.addIssue({
          code: "custom",
          message: "Non-managed surface cannot advertise mutations.",
        });
      }
    }
    if (new Set(value.workflows).size !== value.workflows.length) {
      context.addIssue({
        code: "custom",
        message: "Workflow capabilities must be unique.",
      });
    }
    if (
      new Set(value.operationalActions).size !== value.operationalActions.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Operational actions must be unique.",
      });
    }
  });

const configurationHistoryQuerySchema: z.ZodType<ConfigurationHistoryQuery> = z
  .object({
    limit: z.number().int().min(1).max(maximumHistoryPageSize).default(25),
    after: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/u)
      .optional(),
  })
  .strict();

/** Parses an opaque, bounded cursor before it reaches a persistence adapter. */
export function parseConfigurationHistoryQuery(
  input: unknown,
): ConfigurationHistoryQuery {
  return Object.freeze(configurationHistoryQuerySchema.parse(input));
}

/**
 * Maps a selected persistence projection to an allowlisted public DTO. The input
 * must already be workspace-authorized; arbitrary raw settings, references, and
 * object-storage values are deliberately not accepted as output fields.
 */
export function toConfigurationInspectionDto(
  input: unknown,
): ConfigurationInspectionDto {
  const value = record(input);
  const currentVersion =
    value.currentVersion === undefined
      ? undefined
      : allowlistedVersion(value.currentVersion);
  return Object.freeze(
    configurationInspectionSchema.parse({
      id: value.id,
      resourceType: value.resourceType,
      lifecycle: value.lifecycle,
      revision: value.revision,
      updatedAt: value.updatedAt,
      ...(value.currentVersionId === undefined
        ? {}
        : { currentVersionId: value.currentVersionId }),
      ...(currentVersion === undefined ? {} : { currentVersion }),
    }),
  );
}

/** Validates a bounded, immutable newest-first version page before transport. */
export function toConfigurationHistoryPageDto(
  input: unknown,
): ConfigurationHistoryPageDto {
  const value = record(input);
  const rawItems = value.items;
  const rawPage = record(value.page);
  const page = configurationHistoryPageSchema.parse({
    items: Array.isArray(rawItems)
      ? rawItems.map((item) => allowlistedVersion(item))
      : rawItems,
    page: {
      hasNextPage: rawPage.hasNextPage,
      ...(rawPage.endCursor === undefined
        ? {}
        : { endCursor: rawPage.endCursor }),
    },
  });
  return Object.freeze({
    items: Object.freeze(page.items.map((item) => Object.freeze({ ...item }))),
    page: Object.freeze({ ...page.page }),
  });
}

/** Validates one composition-owned UI state without inventing a mutation path. */
export function toConfigurationSurfaceDto(
  input: unknown,
): ConfigurationSurfaceDto {
  const surface = configurationSurfaceSchema.parse(input);
  return Object.freeze({
    ...surface,
    workflows: Object.freeze([...surface.workflows]),
    operationalActions: Object.freeze([...surface.operationalActions]),
  });
}

function allowlistedVersion(input: unknown): Record<string, unknown> {
  const value = record(input);
  const descriptor =
    value.descriptor === undefined ? undefined : record(value.descriptor);
  return {
    id: value.id,
    version: value.version,
    createdAt: value.createdAt,
    canonicalSettingsSha256: value.canonicalSettingsSha256,
    secretReferenceCount: value.secretReferenceCount,
    ...(value.displayName === undefined
      ? {}
      : { displayName: value.displayName }),
    ...(descriptor === undefined
      ? {}
      : {
          descriptor: {
            kind: descriptor.kind,
            type: descriptor.type,
            version: descriptor.version,
          },
        }),
  };
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}
