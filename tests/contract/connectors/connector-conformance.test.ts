import {
  type AnalysisDestination,
  assertIdempotencyRequest,
  type CaseSource,
  ConnectorCancelledError,
  ConnectorRemoteError,
  createCapabilityLimitedFixture,
  createJitbitShapedCaseFixture,
  createOdooShapedCaseFixture,
  cursorFixture,
  type DiscoveredCase,
  etagFingerprintFixture,
  gitBlobFingerprintFixture,
  type NormalizedCase,
  noFingerprintFixture,
  type PublishRequest,
  sha256CanonicalJson,
  shouldLoadDiscoveredItem,
  versionedOpaqueValue,
} from "../../../packages/connector-sdk/src/index.js";

import { defineConnectorConformanceSuite } from "./connector-conformance.js";

const jitbitCase = createJitbitShapedCaseFixture();
const odooCase = createOdooShapedCaseFixture();

function discoveredCase(
  caseSnapshot: NormalizedCase,
  fingerprint?: DiscoveredCase["fingerprint"],
): DiscoveredCase {
  return { reference: caseSnapshot.reference, fingerprint };
}

function fixtureCaseSource(): CaseSource {
  const cases = new Map(
    [jitbitCase, odooCase].map((caseSnapshot) => [
      caseSnapshot.reference.externalId,
      caseSnapshot,
    ]),
  );

  return {
    async *discoverCases({ cursor, signal }) {
      if (signal.aborted) {
        throw new ConnectorCancelledError();
      }

      if (cursor?.value === "delta") {
        yield {
          mode: "delta",
          events: [
            {
              kind: "upsert",
              item: discoveredCase(
                jitbitCase,
                versionedOpaqueValue("http-etag.v1", '"case-44-v109"'),
              ),
            },
            {
              kind: "tombstone",
              reference: odooCase.reference,
            },
          ],
          complete: true,
        };
        return;
      }

      yield {
        mode: "snapshot",
        scanEpoch: versionedOpaqueValue("fixture-scan.v1", "scan-1"),
        items: [discoveredCase(jitbitCase, etagFingerprintFixture.fingerprint)],
        nextCursor: cursorFixture("snapshot-2"),
        complete: false,
      };
      yield {
        mode: "snapshot",
        scanEpoch: versionedOpaqueValue("fixture-scan.v1", "scan-1"),
        items: [discoveredCase(odooCase)],
        complete: true,
      };
    },
    async loadCase({ reference, signal }) {
      if (signal.aborted) {
        throw new ConnectorCancelledError();
      }

      const caseSnapshot = cases.get(reference.externalId);
      if (caseSnapshot === undefined) {
        throw new Error(`Unknown fixture case ${reference.externalId}.`);
      }
      return caseSnapshot;
    },
  };
}

function fixtureDestination(): AnalysisDestination {
  let firstRequest:
    | Readonly<{
        readonly key: string;
        readonly requestHash: PublishRequest["requestHash"];
      }>
    | undefined;

  return {
    async findPublication() {
      return null;
    },
    async publish(request) {
      if (firstRequest !== undefined) {
        assertIdempotencyRequest("publish", firstRequest, {
          key: request.idempotencyKey,
          requestHash: request.requestHash,
        });
      }
      firstRequest = {
        key: request.idempotencyKey,
        requestHash: request.requestHash,
      };
      return {
        status: "published",
        receipt: {
          marker: request.marker,
          reference: request.target,
          requestId: "publish-request",
        },
      };
    },
  };
}

const source = fixtureCaseSource();
const destination = fixtureDestination();
const publicationTarget = jitbitCase.reference;
const firstRequest: PublishRequest = {
  target: publicationTarget,
  marker: { value: "analysis-44" },
  idempotencyKey: "publish-44",
  requestHash: sha256CanonicalJson({ body: "first" }),
  publication: {
    format: "markdown",
    body: "First publication",
    visibility: "internal",
  },
  signal: new AbortController().signal,
};

defineConnectorConformanceSuite({
  name: "SDK fixture adapter",
  registration: {
    instanceId: "fixture-adapter",
    connectorType: "fixture",
    capabilities: {
      caseSource: source,
      analysisDestination: destination,
    },
  },
  capabilityLimitedRegistration: createCapabilityLimitedFixture(),
  loadCase: async (reference) =>
    source.loadCase({ reference, signal: new AbortController().signal }),
  jitbitCase,
  odooCase,
  discoverSnapshot: () =>
    source.discoverCases({ signal: new AbortController().signal }),
  discoverDelta: () =>
    source.discoverCases({
      cursor: cursorFixture("delta"),
      signal: new AbortController().signal,
    }),
  fingerprintChangeChecks: () => [
    {
      scenario: "unchanged_git_blob",
      shouldLoad: shouldLoadDiscoveredItem(
        { fingerprint: gitBlobFingerprintFixture.fingerprint },
        gitBlobFingerprintFixture,
      ),
    },
    {
      scenario: "changed_etag",
      shouldLoad: shouldLoadDiscoveredItem(
        { fingerprint: etagFingerprintFixture.fingerprint },
        {
          ...etagFingerprintFixture,
          fingerprint: versionedOpaqueValue("http-etag.v1", '"case-44-v109"'),
        },
      ),
    },
    {
      scenario: "missing_fingerprint",
      shouldLoad: shouldLoadDiscoveredItem({}, noFingerprintFixture),
    },
  ],
  cancelledOperation: async () => {
    const controller = new AbortController();
    controller.abort();
    for await (const _page of source.discoverCases({
      signal: controller.signal,
    })) {
      throw new Error("A cancelled source must not yield pages.");
    }
    throw new Error("A cancelled source must throw.");
  },
  rateLimitedOperation: async () => {
    throw new ConnectorRemoteError("The remote service is rate limited.", {
      category: "rateLimit",
      retryable: true,
      requestId: "rate-limit-request",
      retryAfterMs: 30_000,
    });
  },
  publication: {
    firstRequest,
    conflictingRequest: {
      ...firstRequest,
      requestHash: sha256CanonicalJson({ body: "conflict" }),
    },
  },
});
