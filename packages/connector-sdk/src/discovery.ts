import type { ExternalFingerprint, ExternalReference } from "./primitives.js";

export interface PreviousDiscoveryObservation {
  readonly fingerprint?: ExternalFingerprint;
}

export interface CurrentDiscoveryObservation {
  readonly reference: ExternalReference;
  readonly fingerprint?: ExternalFingerprint;
}

/**
 * Returns true when a source must load content and compare its normalized hash. A
 * fingerprint is only a cheap first check; no fingerprint never implies unchanged.
 */
export function shouldLoadDiscoveredItem(
  previous: PreviousDiscoveryObservation | undefined,
  current: CurrentDiscoveryObservation,
): boolean {
  if (previous === undefined) {
    return true;
  }

  if (previous.fingerprint === undefined || current.fingerprint === undefined) {
    return true;
  }

  return (
    previous.fingerprint.version !== current.fingerprint.version ||
    previous.fingerprint.value !== current.fingerprint.value
  );
}
