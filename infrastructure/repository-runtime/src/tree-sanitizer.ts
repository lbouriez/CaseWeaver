/**
 * Returns whether a UTF-8 repository text blob may enter a model-readable
 * prepared tree. It deliberately recognises only conventional credential
 * files and high-confidence literal credential forms; it is not a substitute
 * for keeping secrets out of source control.
 */
export function isSafeRepositoryTextFile(
  path: string,
  contents: Uint8Array,
): boolean {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".netrc" ||
    name === ".npmrc" ||
    name === ".pypirc" ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/iu.test(name)
  ) {
    return false;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    return false;
  }
  return !(
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u.test(text) ||
    /\bAKIA[0-9A-Z]{16}\b/u.test(text) ||
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u.test(text) ||
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u.test(text)
  );
}
