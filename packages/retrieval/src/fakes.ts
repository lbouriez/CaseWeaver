import type {
  RetrievalSearchInput,
  RetrievalSearchPort,
  RetrievalSnapshot,
  RetrievalSnapshotPort,
  RetrievalTokenCounter,
} from "./contracts.js";

export class WhitespaceTokenCounter implements RetrievalTokenCounter {
  public count(input: {
    readonly text: string;
    readonly bindingVersionId: string;
    readonly purpose: "embedding" | "reranking" | "context";
  }): number {
    const trimmed = input.text.trim();
    return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
  }
}

export class InMemoryRetrievalSnapshotPort implements RetrievalSnapshotPort {
  private readonly stored = new Map<string, RetrievalSnapshot>();

  public async persist(snapshot: RetrievalSnapshot): Promise<void> {
    if (this.stored.has(snapshot.id)) {
      throw new Error(`Retrieval snapshot "${snapshot.id}" already exists.`);
    }
    this.stored.set(snapshot.id, snapshot);
  }

  public get(id: string): RetrievalSnapshot | undefined {
    return this.stored.get(id);
  }

  public values(): readonly RetrievalSnapshot[] {
    return [...this.stored.values()];
  }
}

export class DeterministicRetrievalSearchPort implements RetrievalSearchPort {
  public readonly requests: RetrievalSearchInput[] = [];

  public constructor(
    private readonly candidates: readonly import("./contracts.js").RetrievalCandidate[],
  ) {}

  public async search(
    input: RetrievalSearchInput,
  ): Promise<readonly import("./contracts.js").RetrievalCandidate[]> {
    this.requests.push(input);
    return this.candidates;
  }
}
