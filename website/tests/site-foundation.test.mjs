import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const siteRoot = resolve(import.meta.dirname, "..");

test("the portal foundation has its required standalone files", () => {
  for (const file of [
    "docusaurus.config.ts",
    "sidebars.ts",
    "src/theme/Navbar/index.tsx",
    "src/theme/Footer/index.tsx",
    "docs/overview.md",
    "docs/capability-status.md",
  ]) {
    assert.equal(
      existsSync(resolve(siteRoot, file)),
      true,
      `${file} is missing`,
    );
  }
});

test("the portal uses CaseWeaver-owned presentation rather than Rekindle imports", () => {
  const sources = [
    "docusaurus.config.ts",
    "src/theme/Navbar/index.tsx",
    "src/theme/Footer/index.tsx",
    "src/localization/languages.ts",
  ].map((file) => readFileSync(resolve(siteRoot, file), "utf8"));

  assert.equal(sources.join("\n").includes("@rekindle/"), false);
});

test("all required launch locales are configured", () => {
  const config = readFileSync(
    resolve(siteRoot, "docusaurus.config.ts"),
    "utf8",
  );
  for (const locale of ["en", "fr"]) {
    assert.match(config, new RegExp(`"${locale}"`, "u"));
  }
});
