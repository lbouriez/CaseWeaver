import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTranslationPlan,
  protectedSegmentsMissingFromCandidate,
} from "../scripts/translate-docs/plan.mjs";
import { writeReviewedManifest } from "../scripts/translate-docs/status.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "caseweaver-translation-plan-"));
  const documentationRoot = join(root, "docs");
  const localeDocumentationRoot = join(root, "i18n", "fr", "docs");
  const manifestPath = join(
    root,
    "i18n",
    "fr",
    ".caseweaver-translations.json",
  );
  await mkdir(documentationRoot, { recursive: true });
  await mkdir(localeDocumentationRoot, { recursive: true });
  const source = [
    "---",
    "title: Example",
    "---",
    "",
    "[Guide](./guide.md#safe-anchor)",
    "",
    ":::warning",
    "Text",
    ":::",
    "",
    "```json",
    '{ "safe": true }',
    "```",
    "",
    "Use `CASEWEAVER_SAFE_KEY`.",
  ].join("\n");
  await writeFile(join(documentationRoot, "example.md"), source, "utf8");
  await writeFile(join(localeDocumentationRoot, "example.md"), source, "utf8");
  return { documentationRoot, localeDocumentationRoot, manifestPath, source };
}

test("the deterministic planner has no candidate when the reviewed hash is current", async () => {
  const input = await fixture();
  await writeReviewedManifest({ ...input, locale: "fr" });
  assert.deepEqual(await createTranslationPlan(input), []);
});

test("the plan reports changed sources without writing a translation", async () => {
  const input = await fixture();
  await writeReviewedManifest({ ...input, locale: "fr" });
  await writeFile(
    join(input.documentationRoot, "example.md"),
    `${input.source}\nNew text.\n`,
    "utf8",
  );
  assert.deepEqual(
    (await createTranslationPlan(input)).map(({ file, status }) => ({
      file,
      status,
    })),
    [{ file: "example.md", status: "review-required" }],
  );
});

test("translation review protects front matter, code, URLs, anchors, and admonitions", () => {
  const source = [
    "---",
    "title: Example",
    "---",
    ":::warning",
    "```json",
    '{ "safe": true }',
    "```",
    "[Guide](./guide.md#safe-anchor)",
    "Use `CASEWEAVER_SAFE_KEY`.",
  ].join("\n");
  assert.deepEqual(protectedSegmentsMissingFromCandidate(source, source), []);
  assert.notDeepEqual(
    protectedSegmentsMissingFromCandidate(source, "# Traduction\n"),
    [],
  );
});
