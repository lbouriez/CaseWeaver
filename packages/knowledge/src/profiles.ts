import type {
  ChunkCandidate,
  KnowledgeChunker,
  KnowledgeNormalizer,
  KnowledgeTextProfileRegistry,
  NormalizedKnowledgeDocument,
} from "./types.js";

export class KnowledgeTextProfileUnavailableError extends Error {
  public readonly code = "knowledge.textProfileUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("The selected immutable knowledge text profile is unavailable.");
    this.name = "KnowledgeTextProfileUnavailableError";
  }
}

export interface KnowledgeNormalizationProfile {
  readonly id: string;
  readonly version: string;
  readonly normalizer: KnowledgeNormalizer;
}

export interface KnowledgeChunkingProfile {
  readonly id: string;
  readonly version: string;
  readonly chunker: KnowledgeChunker;
}

/**
 * Immutable registry of explicitly configured text profiles. It is deliberately
 * local to trusted composition: profile names are IDs, not connector/provider
 * conditionals, and a missing version never falls back to a mutable default.
 */
export class ImmutableKnowledgeTextProfileRegistry
  implements KnowledgeTextProfileRegistry
{
  private readonly normalizers = new Map<string, KnowledgeNormalizer>();
  private readonly chunkers = new Map<string, KnowledgeChunker>();

  public constructor(
    input: Readonly<{
      readonly normalization: readonly KnowledgeNormalizationProfile[];
      readonly chunking: readonly KnowledgeChunkingProfile[];
    }>,
  ) {
    for (const profile of input.normalization) {
      this.register(
        this.normalizers,
        profile.id,
        profile.version,
        profile.normalizer,
      );
    }
    for (const profile of input.chunking) {
      this.register(
        this.chunkers,
        profile.id,
        profile.version,
        profile.chunker,
      );
    }
  }

  public resolve(input: Parameters<KnowledgeTextProfileRegistry["resolve"]>[0]):
    | Readonly<{
        readonly normalizer: KnowledgeNormalizer;
        readonly chunker: KnowledgeChunker;
      }>
    | undefined {
    const normalizer = this.normalizers.get(
      profileKey(
        input.normalizationProfileId,
        input.normalizationProfileVersion,
      ),
    );
    const chunker = this.chunkers.get(
      profileKey(input.chunkingProfileId, input.chunkingProfileVersion),
    );
    if (normalizer === undefined || chunker === undefined) return undefined;
    return Object.freeze({ normalizer, chunker });
  }

  private register<T>(
    target: Map<string, T>,
    id: string,
    version: string,
    value: T,
  ): void {
    assertProfileIdentifier(id);
    assertProfileIdentifier(version);
    const key = profileKey(id, version);
    if (target.has(key)) {
      throw new RangeError("Knowledge text profile identities must be unique.");
    }
    target.set(key, value);
  }
}

/**
 * Shared validation point for source authoring and execution composition. The
 * caller must supply both immutable profile identities; absence is never
 * substituted with a process-wide/default normalizer or chunker.
 */
export function requireKnowledgeTextProfiles(
  registry: KnowledgeTextProfileRegistry,
  input: Parameters<KnowledgeTextProfileRegistry["resolve"]>[0],
): Readonly<{
  readonly normalizer: KnowledgeNormalizer;
  readonly chunker: KnowledgeChunker;
}> {
  const profiles = registry.resolve(input);
  if (profiles === undefined) throw new KnowledgeTextProfileUnavailableError();
  return profiles;
}

const productionNormalizationId = "text-normalization";
const productionChunkingId = "text-chunking";
const productionProfileVersion = "v1";

/**
 * Source-neutral baseline text profiles. They are deterministic, immutable,
 * and must be selected by their exact ID and version; deployment composition
 * may register additional profiles without changing ingestion policy.
 */
export function createProductionKnowledgeTextProfileRegistry(): KnowledgeTextProfileRegistry {
  return new ImmutableKnowledgeTextProfileRegistry({
    normalization: [
      {
        id: productionNormalizationId,
        version: productionProfileVersion,
        normalizer: Object.freeze({
          async normalize(
            input: Parameters<KnowledgeNormalizer["normalize"]>[0],
          ): Promise<NormalizedKnowledgeDocument> {
            const { document } = input;
            return Object.freeze({
              normalizedText: normalizeText(document.body.normalizedText),
              ...(document.provenance === undefined
                ? {}
                : { provenance: document.provenance }),
              ...(document.sourceAnchors === undefined
                ? {}
                : { sourceAnchors: document.sourceAnchors }),
            });
          },
        }),
      },
    ],
    chunking: [
      {
        id: productionChunkingId,
        version: productionProfileVersion,
        chunker: Object.freeze({
          async chunk(
            input: Parameters<KnowledgeChunker["chunk"]>[0],
          ): Promise<readonly ChunkCandidate[]> {
            const { document } = input;
            return Object.freeze(chunkText(document.normalizedText, 4_000));
          },
        }),
      },
    ],
  });
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .trim();
}

function chunkText(value: string, maximumCharacters: number): ChunkCandidate[] {
  const chunks: ChunkCandidate[] = [];
  let remaining = value;
  while (remaining.length > 0) {
    if (remaining.length <= maximumCharacters) {
      chunks.push(Object.freeze({ content: remaining }));
      break;
    }
    const boundary = Math.max(
      remaining.lastIndexOf("\n\n", maximumCharacters),
      remaining.lastIndexOf("\n", maximumCharacters),
      remaining.lastIndexOf(" ", maximumCharacters),
    );
    const end = boundary > 0 ? boundary : maximumCharacters;
    chunks.push(Object.freeze({ content: remaining.slice(0, end) }));
    remaining = remaining.slice(end).trimStart();
  }
  return chunks;
}

function profileKey(id: string, version: string): string {
  return JSON.stringify([id, version]);
}

function assertProfileIdentifier(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) {
    throw new RangeError("Knowledge text profile identity is invalid.");
  }
}
