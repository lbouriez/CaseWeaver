import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectTranslations } from "./status.mjs";

const supportedTranslationLocales = ["fr"];

function protectedSegments(markdown) {
  const segments = new Set();
  const frontMatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1];
  if (frontMatter) {
    for (const line of frontMatter.split(/\r?\n/u)) {
      const key = line.split(":", 1)[0]?.trim();
      if (key) segments.add(`${key}:`);
    }
  }
  for (const segment of markdown.matchAll(
    /^```(?!text\b)[^\n]*\n[\s\S]*?^```$/gmu,
  )) {
    segments.add(segment[0]);
  }
  for (const segment of markdown.matchAll(/`[^`\n]+`/gu))
    segments.add(segment[0]);
  for (const segment of markdown.matchAll(/\]\(([^)]+)\)/gu)) {
    segments.add(segment[1]);
  }
  for (const segment of markdown.matchAll(/^:::[A-Za-z-]+.*$/gmu)) {
    segments.add(segment[0]);
  }
  for (const segment of markdown.matchAll(/<\/?[A-Za-z][^>]*>/gu)) {
    segments.add(segment[0]);
  }
  return [...segments].sort((left, right) => left.localeCompare(right, "en"));
}

export function protectedSegmentsMissingFromCandidate(source, candidate) {
  return protectedSegments(source).filter(
    (segment) => !candidate.includes(segment),
  );
}

export async function createTranslationPlan({
  documentationRoot,
  localeDocumentationRoot,
  manifestPath,
  force = false,
  file,
}) {
  const status = await inspectTranslations({
    documentationRoot,
    localeDocumentationRoot,
    manifestPath,
  });
  const candidates = [];

  for (const entry of status.entries) {
    if (file !== undefined && entry.file !== file) continue;
    if (!force && entry.status === "current") continue;
    const source = await readFile(
      resolve(documentationRoot, entry.file),
      "utf8",
    );
    let candidate = "";
    try {
      candidate = await readFile(
        resolve(localeDocumentationRoot, entry.file),
        "utf8",
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    candidates.push({
      file: entry.file,
      status: entry.status,
      protectedSegmentsMissing: candidate
        ? protectedSegmentsMissingFromCandidate(source, candidate)
        : [],
    });
  }
  return candidates;
}

function parseArguments(argumentsList) {
  const options = { dryRun: false, force: false, locale: "fr", verbose: false };
  for (const argument of argumentsList) {
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--verbose") options.verbose = true;
    else if (argument.startsWith("--locale="))
      options.locale = argument.slice(9);
    else if (argument.startsWith("--file=")) options.file = argument.slice(7);
    else if (
      argument === "--content-type=markdown" ||
      argument === "--content-type=all"
    ) {
      // The CaseWeaver planner never creates content, and markdown is the only
      // reviewable source it can safely plan today.
    } else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!supportedTranslationLocales.includes(options.locale)) {
    throw new Error(`Unsupported translation locale: ${options.locale}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/translate-docs/plan.mjs [--locale=fr] [--file=path] [--force] [--dry-run] [--verbose]",
    );
    return;
  }
  const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const candidates = await createTranslationPlan({
    documentationRoot: resolve(siteRoot, "docs"),
    localeDocumentationRoot: resolve(
      siteRoot,
      "i18n",
      options.locale,
      "docusaurus-plugin-content-docs",
      "current",
    ),
    manifestPath: resolve(
      siteRoot,
      "i18n",
      options.locale,
      ".caseweaver-translations.json",
    ),
    force: options.force,
    file: options.file,
  });
  if (candidates.length === 0) {
    console.log("No documentation translations need review.");
    return;
  }
  for (const candidate of candidates) {
    console.log(`${candidate.status.padEnd(15)} ${candidate.file}`);
    if (options.verbose && candidate.protectedSegmentsMissing.length > 0) {
      console.log(
        `  protected syntax missing: ${candidate.protectedSegmentsMissing.join(", ")}`,
      );
    }
  }
  console.log(
    options.dryRun
      ? "Dry run only: no content, manifest, or browser state was changed."
      : "Review candidates only: this command never translates content or calls an AI provider.",
  );
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
