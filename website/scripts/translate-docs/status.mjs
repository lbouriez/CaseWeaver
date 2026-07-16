import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

export const MANIFEST_FILE = ".caseweaver-translations.json";

function isDocumentationFile(fileName) {
  return fileName.endsWith(".md") || fileName.endsWith(".mdx");
}

export function sourceHash(source) {
  return createHash("sha256").update(source).digest("hex");
}

export async function documentationFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await documentationFiles(root, entryPath)));
    } else if (entry.isFile() && isDocumentationFile(entry.name)) {
      files.push(relative(root, entryPath));
    }
  }

  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function readManifest(manifestPath) {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    return manifest?.schemaVersion === 1 && typeof manifest.sources === "object"
      ? manifest
      : { schemaVersion: 1, sources: {} };
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 1, sources: {} };
    throw new Error(
      `Cannot read translation manifest ${manifestPath}: ${error.message}`,
    );
  }
}

async function exists(path) {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function inspectTranslations({
  documentationRoot,
  localeDocumentationRoot,
  manifestPath,
}) {
  const manifest = await readManifest(manifestPath);
  const entries = [];

  for (const file of await documentationFiles(documentationRoot)) {
    const source = await readFile(join(documentationRoot, file), "utf8");
    const translatedPath = join(localeDocumentationRoot, file);
    const hash = sourceHash(source);
    const registeredHash = manifest.sources[file]?.sourceHash;
    const translationExists = await exists(translatedPath);
    const status = !translationExists
      ? "missing"
      : registeredHash === hash
        ? "current"
        : "review-required";

    entries.push({ file, hash, status });
  }

  return {
    entries,
    manifest,
    isCurrent: entries.every((entry) => entry.status === "current"),
  };
}

export async function writeReviewedManifest({
  documentationRoot,
  locale,
  localeDocumentationRoot,
  manifestPath,
}) {
  const status = await inspectTranslations({
    documentationRoot,
    localeDocumentationRoot,
    manifestPath,
  });
  const missing = status.entries.filter((entry) => entry.status === "missing");

  if (missing.length > 0) {
    throw new Error(
      `Cannot record reviewed ${locale} translations; missing: ${missing
        .map((entry) => entry.file)
        .join(", ")}`,
    );
  }

  const sources = Object.fromEntries(
    status.entries.map((entry) => [
      entry.file,
      { sourceHash: entry.hash, translationPath: entry.file },
    ]),
  );
  const manifest = {
    schemaVersion: 1,
    locale,
    sources,
  };

  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

function parseArguments(argumentsList) {
  const options = { check: false, locale: "fr", writeManifest: false };

  for (const argument of argumentsList) {
    if (argument === "--check") options.check = true;
    else if (argument === "--write-manifest") options.writeManifest = true;
    else if (argument.startsWith("--locale="))
      options.locale = argument.slice(9);
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

export async function runTranslationStatus({
  locale,
  siteRoot,
  writeManifest,
}) {
  const documentationRoot = resolve(siteRoot, "docs");
  const localeRoot = resolve(siteRoot, "i18n", locale);
  const localeDocumentationRoot = join(
    localeRoot,
    "docusaurus-plugin-content-docs",
    "current",
  );
  const manifestPath = join(localeRoot, MANIFEST_FILE);

  if (writeManifest) {
    await writeReviewedManifest({
      documentationRoot,
      locale,
      localeDocumentationRoot,
      manifestPath,
    });
  }

  return inspectTranslations({
    documentationRoot,
    localeDocumentationRoot,
    manifestPath,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/translate-docs/status.mjs [--locale=fr] [--check] [--write-manifest]",
    );
    return;
  }

  const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const status = await runTranslationStatus({
    locale: options.locale,
    siteRoot,
    writeManifest: options.writeManifest,
  });

  for (const entry of status.entries) {
    console.log(`${entry.status.padEnd(15)} ${entry.file}`);
  }

  if (!status.isCurrent) {
    console.error(
      "Translations need review. Add or review the locale file, then run --write-manifest after human approval.",
    );
    if (options.check) process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
