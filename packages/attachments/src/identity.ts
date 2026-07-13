import { createHash } from "node:crypto";

import type {
  DerivativeCacheIdentity,
  DerivativeCacheIdentityInput,
} from "./contracts.js";

function requireIdentityPart(name: string, value: string): string {
  if (value.length === 0 || value.length > 1_024) {
    throw new RangeError(`Attachment cache identity ${name} is invalid.`);
  }
  return value;
}

export function derivativeCacheIdentity(
  input: DerivativeCacheIdentityInput,
): DerivativeCacheIdentity {
  const normalized = {
    workspaceId: requireIdentityPart("workspaceId", input.workspaceId),
    accessPolicyHash: requireIdentityPart(
      "accessPolicyHash",
      input.accessPolicyHash,
    ),
    contentSha256: requireIdentityPart("contentSha256", input.contentSha256),
    processor: requireIdentityPart("processor", input.processor),
    processorVersion: requireIdentityPart(
      "processorVersion",
      input.processorVersion,
    ),
    securityPolicyVersion: requireIdentityPart(
      "securityPolicyVersion",
      input.securityPolicyVersion,
    ),
    normalizationVersion: requireIdentityPart(
      "normalizationVersion",
      input.normalizationVersion,
    ),
    visionPromptVersion: input.visionPromptVersion,
    visionBindingVersionId: input.visionBindingVersionId,
  };
  if (
    (normalized.visionPromptVersion === undefined) !==
    (normalized.visionBindingVersionId === undefined)
  ) {
    throw new RangeError(
      "Vision cache identity requires both prompt and binding versions.",
    );
  }
  return Object.freeze({
    ...normalized,
    key: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
  });
}
