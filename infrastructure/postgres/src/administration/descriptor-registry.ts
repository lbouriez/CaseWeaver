import {
  canonicalizeDescriptor,
  parseConfigurationDescriptor,
  sha256Base64Url,
  type ConfigurationDescriptor,
  type DescriptorRegistry,
  type DescriptorRegistryWriter,
} from "@caseweaver/administration";
import { Prisma, type PrismaClient } from "@prisma/client";

function descriptorCursor(type: string, version: string): string {
  return `${type}\u0000${version}`;
}

function parseDescriptorCursor(
  input: Readonly<{ readonly sortKey: string; readonly id: string }>,
): {
  readonly kind: string;
  readonly type: string;
  readonly version: string;
} {
  const values = input.id.split("\u0000");
  if (values.length !== 2 || values.some((value) => value.length === 0)) {
    throw new Error("Descriptor cursor is invalid.");
  }
  return Object.freeze({
    kind: input.sortKey,
    type: values[0] as string,
    version: values[1] as string,
  });
}

/**
 * Persists only the safe, strict descriptor snapshot registered by trusted process
 * composition. A UI/API caller has no write path to this registry.
 */
export class PostgresDescriptorRegistry
  implements DescriptorRegistry, DescriptorRegistryWriter
{
  public constructor(private readonly client: PrismaClient) {}

  public async register(value: unknown): Promise<ConfigurationDescriptor> {
    const descriptor = parseConfigurationDescriptor(value);
    const canonical = canonicalizeDescriptor(descriptor);
    const descriptorHash = sha256Base64Url(canonical);
    try {
      await this.client.administrationDescriptorRevision.create({
        data: {
          kind: descriptor.kind,
          type: descriptor.type,
          version: descriptor.version,
          descriptor: JSON.parse(canonical) as Prisma.InputJsonObject,
          descriptorHash,
        },
      });
      return descriptor;
    } catch (error: unknown) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }
      const existing =
        await this.client.administrationDescriptorRevision.findUnique({
          where: {
            kind_type_version: {
              kind: descriptor.kind,
              type: descriptor.type,
              version: descriptor.version,
            },
          },
          select: { descriptor: true, descriptorHash: true },
        });
      if (
        existing === null ||
        existing.descriptorHash !== descriptorHash ||
        canonicalizeDescriptor(
          parseConfigurationDescriptor(existing.descriptor),
        ) !== canonical
      ) {
        throw new Error(
          "A descriptor revision cannot be registered with different content.",
        );
      }
      return descriptor;
    }
  }

  public async list(
    input: Readonly<{
      readonly kind?: ConfigurationDescriptor["kind"];
      readonly after?: Readonly<{
        readonly sortKey: string;
        readonly id: string;
      }>;
      readonly limit: number;
    }>,
  ): Promise<readonly ConfigurationDescriptor[]> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 200
    ) {
      throw new RangeError("Descriptor list limit must be between 1 and 200.");
    }
    const cursor =
      input.after === undefined
        ? undefined
        : parseDescriptorCursor(input.after);
    const rows = await this.client.administrationDescriptorRevision.findMany({
      where: input.kind === undefined ? undefined : { kind: input.kind },
      ...(cursor === undefined
        ? {}
        : {
            cursor: {
              kind_type_version: {
                kind: cursor.kind,
                type: cursor.type,
                version: cursor.version,
              },
            },
            skip: 1,
          }),
      orderBy: [{ kind: "asc" }, { type: "asc" }, { version: "asc" }],
      take: input.limit,
      select: { descriptor: true },
    });
    return Object.freeze(
      rows.map((row) => parseConfigurationDescriptor(row.descriptor)),
    );
  }

  public async find(
    input: Readonly<{
      readonly kind: ConfigurationDescriptor["kind"];
      readonly type: string;
      readonly version?: string;
    }>,
  ): Promise<ConfigurationDescriptor | undefined> {
    if (input.version !== undefined) {
      const row = await this.client.administrationDescriptorRevision.findUnique(
        {
          where: {
            kind_type_version: {
              kind: input.kind,
              type: input.type,
              version: input.version,
            },
          },
          select: { descriptor: true },
        },
      );
      return row === null
        ? undefined
        : parseConfigurationDescriptor(row.descriptor);
    }
    const row = await this.client.administrationDescriptorRevision.findFirst({
      where: { kind: input.kind, type: input.type },
      orderBy: { version: "desc" },
      select: { descriptor: true },
    });
    return row === null
      ? undefined
      : parseConfigurationDescriptor(row.descriptor);
  }

  /** Stable opaque cursor payload for callers using the shared cursor encoder. */
  public static cursorFor(descriptor: ConfigurationDescriptor): Readonly<{
    readonly sortKey: string;
    readonly id: string;
  }> {
    return Object.freeze({
      sortKey: descriptor.kind,
      id: descriptorCursor(descriptor.type, descriptor.version),
    });
  }
}
