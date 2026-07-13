import { describe, expect, it } from "vitest";

import {
  etagFingerprintFixture,
  gitBlobFingerprintFixture,
  noFingerprintFixture,
} from "./fakes.js";
import { shouldLoadDiscoveredItem } from "./discovery.js";

describe("discovery fingerprints", () => {
  it("skips equal Git blobs and ETags but loads sources without fingerprints", () => {
    expect(
      shouldLoadDiscoveredItem(
        { fingerprint: gitBlobFingerprintFixture.fingerprint },
        gitBlobFingerprintFixture,
      ),
    ).toBe(false);
    expect(
      shouldLoadDiscoveredItem(
        { fingerprint: etagFingerprintFixture.fingerprint },
        etagFingerprintFixture,
      ),
    ).toBe(false);
    expect(shouldLoadDiscoveredItem({}, noFingerprintFixture)).toBe(true);
  });
});
