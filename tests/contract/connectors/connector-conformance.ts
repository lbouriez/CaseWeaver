import { describe, expect, it } from "vitest";
import {
  ConnectorCancelledError,
  ConnectorError,
  ConnectorIdempotencyConflictError,
  type ConnectorRegistration,
  type DiscoveredCase,
  type DiscoveryPage,
  type NormalizedCase,
  normalizedCaseSchema,
  type PublishRequest,
} from "../../../packages/connector-sdk/src/index.js";

export interface FingerprintChangeCheck {
  readonly scenario:
    | "unchanged_git_blob"
    | "changed_etag"
    | "missing_fingerprint";
  readonly shouldLoad: boolean;
}

export interface ConnectorConformanceSubject {
  readonly name: string;
  readonly registration: ConnectorRegistration;
  readonly capabilityLimitedRegistration: ConnectorRegistration;
  readonly loadCase: (
    reference: NormalizedCase["reference"],
  ) => Promise<NormalizedCase>;
  readonly jitbitCase: NormalizedCase;
  readonly odooCase: NormalizedCase;
  readonly discoverSnapshot: () => AsyncIterable<DiscoveryPage<DiscoveredCase>>;
  readonly discoverDelta: () => AsyncIterable<DiscoveryPage<DiscoveredCase>>;
  readonly fingerprintChangeChecks: () => readonly FingerprintChangeCheck[];
  readonly cancelledOperation: () => Promise<never>;
  readonly rateLimitedOperation: () => Promise<never>;
  readonly publication: Readonly<{
    readonly firstRequest: PublishRequest;
    readonly conflictingRequest: PublishRequest;
  }>;
}

async function collect<T>(items: AsyncIterable<T>): Promise<readonly T[]> {
  const result: T[] = [];
  for await (const item of items) {
    result.push(item);
  }
  return result;
}

function expectNormalizedCase(caseSnapshot: NormalizedCase): void {
  expect(normalizedCaseSchema.safeParse(caseSnapshot).success).toBe(true);

  const sequences = caseSnapshot.messages.map((message) => message.sequence);
  expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
}

/**
 * Defines adapter-facing tests using only connector-SDK contracts and deterministic
 * fixture operations. An adapter supplies its own remote fake to the subject; no
 * application service or application fixture is required.
 */
export function defineConnectorConformanceSuite(
  subject: ConnectorConformanceSubject,
): void {
  describe(`${subject.name} connector conformance`, () => {
    it("normalizes Jitbit-shaped and Odoo-shaped cases without vendor fields", async () => {
      const jitbitCase = await subject.loadCase(subject.jitbitCase.reference);
      const odooCase = await subject.loadCase(subject.odooCase.reference);

      expectNormalizedCase(jitbitCase);
      expectNormalizedCase(odooCase);
      expect(jitbitCase.messages.map((message) => message.visibility)).toEqual([
        "public",
        "internal",
        "system",
      ]);
      expect(odooCase.messages.map((message) => message.visibility)).toEqual([
        "public",
        "internal",
      ]);
    });

    it("does not fabricate optional capabilities", () => {
      expect(subject.registration.capabilities.caseSource).toBeDefined();
      expect(
        subject.capabilityLimitedRegistration.capabilities.caseSource,
      ).toBeUndefined();
      expect(
        subject.capabilityLimitedRegistration.capabilities.attachmentSource,
      ).toBeUndefined();
      expect(
        subject.capabilityLimitedRegistration.capabilities.analysisDestination,
      ).toBeUndefined();
      expect(
        subject.capabilityLimitedRegistration.capabilities.webhookAdapter,
      ).toBeUndefined();
    });

    it("preserves a snapshot scan epoch and exposes completion", async () => {
      const pages = await collect(subject.discoverSnapshot());
      const firstPage = pages[0];
      const lastPage = pages.at(-1);

      expect(firstPage).toBeDefined();
      expect(lastPage).toBeDefined();
      expect(pages.every((page) => page.mode === "snapshot")).toBe(true);

      if (
        firstPage === undefined ||
        lastPage === undefined ||
        firstPage.mode !== "snapshot"
      ) {
        throw new Error("The snapshot fixture must contain snapshot pages.");
      }

      expect(
        pages.every(
          (page) =>
            page.mode === "snapshot" &&
            page.scanEpoch.version === firstPage.scanEpoch.version &&
            page.scanEpoch.value === firstPage.scanEpoch.value,
        ),
      ).toBe(true);
      expect(lastPage.complete).toBe(true);
      expect(pages.slice(0, -1).every((page) => !page.complete)).toBe(true);
    });

    it("reports delta upserts and explicit tombstones", async () => {
      const pages = await collect(subject.discoverDelta());
      const events = pages.flatMap((page) =>
        page.mode === "delta" ? page.events : [],
      );

      expect(pages.every((page) => page.mode === "delta")).toBe(true);
      expect(pages.at(-1)?.complete).toBe(true);
      expect(events.some((event) => event.kind === "upsert")).toBe(true);
      expect(events.some((event) => event.kind === "tombstone")).toBe(true);
    });

    it("uses opaque fingerprints only as a cheap change check", () => {
      expect(subject.fingerprintChangeChecks()).toEqual([
        { scenario: "unchanged_git_blob", shouldLoad: false },
        { scenario: "changed_etag", shouldLoad: true },
        { scenario: "missing_fingerprint", shouldLoad: true },
      ]);
    });

    it("keeps cancellation distinct and preserves rate-limit metadata", async () => {
      await expect(subject.cancelledOperation()).rejects.toBeInstanceOf(
        ConnectorCancelledError,
      );
      try {
        await subject.rateLimitedOperation();
      } catch (error) {
        expect(error).toBeInstanceOf(ConnectorError);
        expect(error).toMatchObject({
          category: "rateLimit",
          retryable: true,
          details: { requestId: "rate-limit-request", retryAfterMs: 30_000 },
        } satisfies Partial<ConnectorError>);
        return;
      }
      throw new Error("The rate-limited operation must fail.");
    });

    it("rejects a reused idempotency key with a different request hash", async () => {
      const destination = subject.registration.capabilities.analysisDestination;
      if (destination === undefined) {
        throw new Error("The conformance fixture must expose a destination.");
      }

      await expect(
        destination.publish(subject.publication.firstRequest),
      ).resolves.toMatchObject({ status: "published" });
      await expect(
        destination.publish(subject.publication.conflictingRequest),
      ).rejects.toBeInstanceOf(ConnectorIdempotencyConflictError);
    });
  });
}
