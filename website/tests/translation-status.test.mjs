import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectTranslations,
  sourceHash,
  writeReviewedManifest,
} from "../scripts/translate-docs/status.mjs";

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "caseweaver-translation-"));
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
  await writeFile(
    join(documentationRoot, "overview.md"),
    "# Overview\n",
    "utf8",
  );
  await writeFile(
    join(localeDocumentationRoot, "overview.md"),
    "# Présentation\n",
    "utf8",
  );
  return { documentationRoot, localeDocumentationRoot, manifestPath };
}

test("reviewed translation manifest records the exact English source revision", async () => {
  const fixture = await makeFixture();
  const manifest = await writeReviewedManifest({
    ...fixture,
    locale: "fr",
  });

  assert.equal(
    manifest.sources["overview.md"].sourceHash,
    sourceHash("# Overview\n"),
  );
  assert.equal(
    (
      await inspectTranslations({
        ...fixture,
      })
    ).isCurrent,
    true,
  );
});

test("source changes require a fresh human translation review", async () => {
  const fixture = await makeFixture();
  await writeReviewedManifest({ ...fixture, locale: "fr" });
  await writeFile(
    join(fixture.documentationRoot, "overview.md"),
    "# Changed\n",
    "utf8",
  );

  const status = await inspectTranslations(fixture);
  assert.deepEqual(
    status.entries.map((entry) => entry.status),
    ["review-required"],
  );
  assert.equal(status.isCurrent, false);
});

test("a missing locale document cannot be registered as reviewed", async () => {
  const fixture = await makeFixture();
  await writeFile(
    join(fixture.documentationRoot, "architecture.md"),
    "# Architecture\n",
    "utf8",
  );

  await assert.rejects(
    writeReviewedManifest({ ...fixture, locale: "fr" }),
    /missing: architecture\.md/u,
  );
});
