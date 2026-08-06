import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const maximumTitleLength = 120;

function invalidConfiguration(message) {
  return new Error(
    `Cloudflare Pages Admin configuration is invalid: ${message}`,
  );
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

/**
 * The Pages artifact has a narrower public contract than the general runtime
 * configuration: it always calls a separately hosted HTTPS API origin. Keeping
 * that restriction here prevents a deployment variable from accidentally
 * publishing a credential-bearing URL or a path that changes the API boundary.
 */
export function parsePagesRuntimeConfiguration({ apiBaseUrl, uiTitle }) {
  if (typeof apiBaseUrl !== "string" || apiBaseUrl.trim() === "") {
    throw invalidConfiguration("CASEWEAVER_ADMIN_API_BASE_URL is required.");
  }

  let apiUrl;
  try {
    apiUrl = new URL(apiBaseUrl.trim());
  } catch {
    throw invalidConfiguration("the API URL must be an absolute HTTPS origin.");
  }

  if (apiUrl.protocol !== "https:") {
    throw invalidConfiguration("the API URL must use HTTPS.");
  }
  if (apiUrl.username !== "" || apiUrl.password !== "") {
    throw invalidConfiguration("the API URL must not contain credentials.");
  }
  if (apiUrl.pathname !== "/" || apiUrl.search !== "" || apiUrl.hash !== "") {
    throw invalidConfiguration(
      "the API URL must be an origin without a path, query string, or fragment.",
    );
  }
  if (apiUrl.origin === "null") {
    throw invalidConfiguration("the API URL must have a network origin.");
  }

  if (typeof uiTitle !== "string") {
    throw invalidConfiguration("CASEWEAVER_ADMIN_UI_TITLE must be text.");
  }
  const title = uiTitle.trim();
  if (title.length === 0 || title.length > maximumTitleLength) {
    throw invalidConfiguration(
      `CASEWEAVER_ADMIN_UI_TITLE must contain 1 to ${maximumTitleLength} characters.`,
    );
  }
  if (containsControlCharacter(title)) {
    throw invalidConfiguration(
      "CASEWEAVER_ADMIN_UI_TITLE must not contain control characters.",
    );
  }

  return Object.freeze({ apiBaseUrl: apiUrl.origin, uiTitle: title });
}

export function createPagesHeaders(apiOrigin) {
  const policy = [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin}`,
  ].join("; ");

  return [
    "/runtime-config.json",
    "  Cache-Control: no-store, max-age=0",
    "  Content-Type: application/json; charset=utf-8",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    `  Content-Security-Policy: ${policy}`,
    "",
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    "  X-Frame-Options: DENY",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
    `  Content-Security-Policy: ${policy}`,
    "",
  ].join("\n");
}

function writeAtomically(path, contents) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o644 });
  renameSync(temporaryPath, path);
}

export function writeCloudflarePagesRuntimeConfiguration({
  apiBaseUrl,
  uiTitle,
  outputDirectory,
}) {
  const runtimeConfig = parsePagesRuntimeConfiguration({ apiBaseUrl, uiTitle });
  if (typeof outputDirectory !== "string" || outputDirectory.trim() === "") {
    throw invalidConfiguration("an output directory is required.");
  }

  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: true });
  const runtimeConfigPath = resolve(output, "runtime-config.json");
  const headersPath = resolve(output, "_headers");

  if (
    dirname(runtimeConfigPath) !== output ||
    dirname(headersPath) !== output
  ) {
    throw invalidConfiguration("the output directory is unsafe.");
  }

  writeAtomically(
    runtimeConfigPath,
    `${JSON.stringify(runtimeConfig, null, 2)}\n`,
  );
  writeAtomically(headersPath, createPagesHeaders(runtimeConfig.apiBaseUrl));

  return Object.freeze({ runtimeConfig, runtimeConfigPath, headersPath });
}

function invokedAsScript() {
  return (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (invokedAsScript()) {
  const outputDirectory = process.argv[2] ?? "apps/admin/dist";
  const result = writeCloudflarePagesRuntimeConfiguration({
    apiBaseUrl: process.env.CASEWEAVER_ADMIN_API_BASE_URL,
    uiTitle: process.env.CASEWEAVER_ADMIN_UI_TITLE ?? "CaseWeaver Control Room",
    outputDirectory,
  });

  process.stdout.write(
    `Wrote public Pages runtime configuration to ${result.runtimeConfigPath}.\n`,
  );
}
