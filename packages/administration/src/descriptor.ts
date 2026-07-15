import { z } from "zod";

export const descriptorKinds = ["connector", "aiProvider"] as const;
export type DescriptorKind = (typeof descriptorKinds)[number];

export const connectorCapabilities = [
  "knowledgeSource",
  "caseSource",
  "attachmentSource",
  "analysisDestination",
  "webhookAdapter",
] as const;
export type ConnectorCapability = (typeof connectorCapabilities)[number];

export const aiCapabilities = [
  "embedding",
  "vision",
  "analysis",
  "repositoryAgent",
  "reranker",
  "keywordExtraction",
  "chat",
] as const;
export type AiCapability = (typeof aiCapabilities)[number];

const stableIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const safeText = z.string().trim().min(1).max(2_000);
const safeUrl = z.url().max(2_000);

export type SafeJsonSchema = Readonly<{
  readonly type?:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "array"
    | "object";
  readonly title?: string;
  readonly description?: string;
  readonly format?: string;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly properties?: Readonly<Record<string, SafeJsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: SafeJsonSchema;
  readonly additionalProperties?: boolean;
}>;

const safeJsonSchema: z.ZodType<SafeJsonSchema> = z.lazy(() =>
  z
    .object({
      type: z
        .enum(["string", "number", "integer", "boolean", "array", "object"])
        .optional(),
      title: z.string().trim().min(1).max(160).optional(),
      description: z.string().trim().min(1).max(2_000).optional(),
      format: z.string().trim().min(1).max(80).optional(),
      enum: z
        .array(
          z.union([
            z.string().max(500),
            z.number().finite(),
            z.boolean(),
            z.null(),
          ]),
        )
        .min(1)
        .max(100)
        .optional(),
      properties: z
        .record(z.string().trim().min(1).max(200), safeJsonSchema)
        .optional(),
      required: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
      items: safeJsonSchema.optional(),
      additionalProperties: z.boolean().optional(),
    })
    .strict(),
);

export interface DescriptorUiGroup {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly string[];
  readonly advanced: boolean;
}

export interface SecretReferenceSlot {
  readonly name: string;
  readonly label: string;
  readonly required: boolean;
  readonly acceptedReferenceKinds: readonly string[];
  readonly supportsRotation: boolean;
}

export interface ConfigurationDescriptor {
  readonly kind: DescriptorKind;
  readonly type: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly documentationUrl?: string;
  readonly connectorCapabilities: readonly ConnectorCapability[];
  readonly aiCapabilities: readonly AiCapability[];
  readonly supportedWireApis: readonly string[];
  readonly supportedWebhookEventTypes: readonly string[];
  readonly settingsSchema: SafeJsonSchema;
  readonly uiGroups: readonly DescriptorUiGroup[];
  readonly secretSlots: readonly SecretReferenceSlot[];
  readonly supportsConfigurationMigration: boolean;
  readonly supportedTestOperations: readonly string[];
}

/** Immutable reference retained by descriptor-backed configuration versions. */
export interface ConfigurationDescriptorReference {
  readonly kind: DescriptorKind;
  readonly type: string;
  readonly version: string;
}

export function descriptorReference(
  descriptor: ConfigurationDescriptor,
): ConfigurationDescriptorReference {
  return Object.freeze({
    kind: descriptor.kind,
    type: descriptor.type,
    version: descriptor.version,
  });
}

const uiGroupSchema: z.ZodType<DescriptorUiGroup> = z
  .object({
    id: stableIdentifier,
    title: z.string().trim().min(1).max(160),
    fields: z.array(z.string().trim().min(1).max(300)).min(1).max(100),
    advanced: z.boolean(),
  })
  .strict();

const secretSlotSchema: z.ZodType<SecretReferenceSlot> = z
  .object({
    name: z.string().trim().min(1).max(300),
    label: z.string().trim().min(1).max(160),
    required: z.boolean(),
    acceptedReferenceKinds: z.array(stableIdentifier).max(20),
    supportsRotation: z.boolean(),
  })
  .strict();

export const configurationDescriptorSchema: z.ZodType<ConfigurationDescriptor> =
  z
    .object({
      kind: z.enum(descriptorKinds),
      type: stableIdentifier,
      version: stableIdentifier,
      displayName: z.string().trim().min(1).max(160),
      description: safeText,
      documentationUrl: safeUrl.optional(),
      connectorCapabilities: z
        .array(z.enum(connectorCapabilities))
        .max(connectorCapabilities.length),
      aiCapabilities: z
        .array(z.enum(aiCapabilities))
        .max(aiCapabilities.length),
      supportedWireApis: z.array(stableIdentifier).max(20),
      supportedWebhookEventTypes: z.array(stableIdentifier).max(100),
      settingsSchema: safeJsonSchema,
      uiGroups: z.array(uiGroupSchema).max(30),
      secretSlots: z.array(secretSlotSchema).max(30),
      supportsConfigurationMigration: z.boolean(),
      supportedTestOperations: z.array(stableIdentifier).max(20),
    })
    .strict()
    .superRefine((descriptor, context) => {
      if (
        descriptor.kind === "connector" &&
        descriptor.aiCapabilities.length > 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Connector descriptors cannot declare AI capabilities.",
        });
      }
      if (
        descriptor.kind === "aiProvider" &&
        descriptor.connectorCapabilities.length > 0
      ) {
        context.addIssue({
          code: "custom",
          message:
            "AI provider descriptors cannot declare connector capabilities.",
        });
      }
      const names = new Set<string>();
      for (const slot of descriptor.secretSlots) {
        if (names.has(slot.name)) {
          context.addIssue({
            code: "custom",
            message: "Secret slot names must be unique.",
          });
        }
        names.add(slot.name);
      }
    });

export function parseConfigurationDescriptor(
  value: unknown,
): ConfigurationDescriptor {
  return Object.freeze(configurationDescriptorSchema.parse(value));
}

export class InMemoryDescriptorRegistry {
  private readonly entries = new Map<string, ConfigurationDescriptor>();

  public register(value: unknown): ConfigurationDescriptor {
    const descriptor = parseConfigurationDescriptor(value);
    const key = `${descriptor.kind}:${descriptor.type}:${descriptor.version}`;
    const current = this.entries.get(key);
    if (
      current !== undefined &&
      canonicalDescriptor(current) !== canonicalDescriptor(descriptor)
    ) {
      throw new Error(
        "A descriptor version cannot be registered with different content.",
      );
    }
    this.entries.set(key, descriptor);
    return descriptor;
  }

  public list(kind?: DescriptorKind): readonly ConfigurationDescriptor[] {
    return Object.freeze(
      [...this.entries.values()]
        .filter((descriptor) => kind === undefined || descriptor.kind === kind)
        .sort(
          (left, right) =>
            left.kind.localeCompare(right.kind) ||
            left.type.localeCompare(right.type) ||
            left.version.localeCompare(right.version),
        ),
    );
  }
}

function canonicalDescriptor(descriptor: ConfigurationDescriptor): string {
  return JSON.stringify(canonicalizeDescriptor(descriptor));
}

/** Stable content representation for immutable persistence registration. */
export function canonicalizeDescriptor(
  descriptor: ConfigurationDescriptor,
): string {
  return JSON.stringify(canonicalize(descriptor));
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Descriptor contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, canonicalize(object[key])]),
    );
  }
  throw new TypeError("Descriptor must be JSON-compatible.");
}
