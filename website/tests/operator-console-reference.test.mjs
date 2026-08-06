import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const siteRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(siteRoot, "..");
const englishGuidePath = resolve(
  siteRoot,
  "docs/operator-console-reference.md",
);
const frenchGuidePath = resolve(
  siteRoot,
  "i18n/fr/docusaurus-plugin-content-docs/current/operator-console-reference.md",
);

function readRepositoryFile(path) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function routeReferencePattern(route) {
  if (route === "/") return "#/(?![A-Za-z0-9-])";
  return `#${escapeRegularExpression(route)}(?![A-Za-z0-9-])`;
}

test("the Console reference covers every source-registered primary navigation route", () => {
  const guides = [
    ["English", readFileSync(englishGuidePath, "utf8")],
    ["French", readFileSync(frenchGuidePath, "utf8")],
  ];
  const navigation = readRepositoryFile("apps/admin/src/pages/navigation.ts");
  const routes = [...navigation.matchAll(/path:\s*"([^"]+)"/gu)].map(
    ([, route]) => route,
  );

  assert.ok(
    routes.length > 0,
    "navigation must expose at least one primary route",
  );
  for (const route of routes) {
    for (const [locale, guide] of guides) {
      assert.match(
        guide,
        new RegExp(routeReferencePattern(route), "u"),
        `missing ${locale} Console reference for registered route ${route}`,
      );
    }
  }
});

test("the Console reference names the current authoring, recovery, and audit boundaries", () => {
  const guide = readFileSync(englishGuidePath, "utf8");
  const authoringSources = [
    "apps/admin/src/app.tsx",
    "apps/admin/src/pages/section-page.tsx",
    "apps/admin/src/pages/secret-reference-registration.tsx",
    "apps/admin/src/pages/descriptor-catalog.tsx",
    "apps/admin/src/pages/control-plane-authoring.tsx",
    "apps/admin/src/pages/source-schedule-drafts.tsx",
    "apps/admin/src/pages/ai-configuration-authoring.tsx",
    "apps/admin/src/pages/knowledge-collection-authoring.tsx",
    "apps/admin/src/pages/repository-analysis-workflows.tsx",
    "apps/admin/src/pages/diagnostic-export.tsx",
    "apps/admin/src/pages/role-assignment-editor.tsx",
  ]
    .map(readRepositoryFile)
    .join("\n");
  const contracts = readRepositoryFile("apps/admin/src/api/contracts.ts");
  const normalizedGuide = guide.replace(/\s+/gu, " ");
  const normalizedAuthoringSources = authoringSources.replace(/\s+/gu, " ");

  for (const label of [
    "Register where a secret lives",
    "Connector configuration drafts",
    "Create an inert source draft",
    "Create a source-version-pinned draft",
    "Refresh models available from provider",
    "Create a model binding draft",
    "Create a collection",
    "Create a code repository draft",
    "Create an analysis recipe draft",
    "Create a case analysis trigger draft",
    "Create a case intake schedule draft",
    "Create an attachment handling policy draft",
    "Create a repository execution policy draft",
    "Create a publication profile draft",
    "Audited diagnostics export",
    "Replace an operator's role set",
  ]) {
    assert.match(normalizedAuthoringSources, new RegExp(label, "u"));
    assert.match(normalizedGuide, new RegExp(label, "u"));
  }

  for (const resource of [
    "secret-references",
    "connector-instances",
    "knowledge-sources",
    "ai-provider-instances",
    "collections",
    "analysis-recipes",
    "operation-jobs",
    "audit-events",
  ]) {
    assert.match(contracts, new RegExp(`"${resource}"`, "u"));
  }

  for (const invariant of [
    "unknown price, never zero",
    "outcome_unknown",
    "server-audited",
    "immutable version",
    "browser-crafted API request",
  ]) {
    assert.match(guide, new RegExp(invariant, "u"));
  }
});

test("the Console reference has a French counterpart and no credential-bearing URL or value", () => {
  assert.equal(existsSync(englishGuidePath), true);
  assert.equal(existsSync(frenchGuidePath), true);

  const guides = `${readFileSync(englishGuidePath, "utf8")}\n${readFileSync(
    frenchGuidePath,
    "utf8",
  )}`;
  assert.doesNotMatch(guides, /https:\/\/[^\s/]+:[^\s@/]+@/u);
  assert.doesNotMatch(
    guides,
    /(?:api[_-]?key|token|password)\s*[:=]\s*[A-Za-z0-9_-]{12,}/iu,
  );
});
