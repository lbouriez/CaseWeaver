export type SafeConfigurationObject = Readonly<Record<string, unknown>>;

const secretLikeKey =
  /secret|token|pass(?:word)?|credential|api[-_]?key|authorization|private[-_]?key|locator/iu;

/**
 * Browser policy JSON is intentionally limited to a generic object and rejects
 * credential-shaped keys before a request is made. This keeps forms from
 * rendering, retaining, or submitting secret material; opaque secret metadata
 * has its own dedicated registration workflow.
 */
export function parseSafeConfiguration(
  text: string,
  label: string,
): SafeConfigurationObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be a valid JSON object.`);
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be a JSON object.`);
  }
  if (containsSecretLikeKey(value)) {
    throw new Error(
      "Credential-shaped configuration fields are not accepted here. Register an opaque external reference instead.",
    );
  }
  return value as SafeConfigurationObject;
}

function containsSecretLikeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretLikeKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, nested]) => secretLikeKey.test(key) || containsSecretLikeKey(nested),
  );
}
