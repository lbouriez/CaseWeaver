import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowsDirectory = new URL("./", import.meta.url);
const documentationWorkflow = await readFile(
  new URL("./docs-pages.yml", workflowsDirectory),
  "utf8",
);
const cleanupWorkflow = await readFile(
  new URL("./docs-pages-cleanup.yml", workflowsDirectory),
  "utf8",
);

function jobSection(workflow, name, nextName) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `expected ${name} job`);

  const end = nextName
    ? workflow.indexOf(`  ${nextName}:`, start + 1)
    : workflow.length;

  return workflow.slice(start, end === -1 ? workflow.length : end);
}

test("documentation Pages workflows preserve their isolated publication boundary", () => {
  assert.match(
    documentationWorkflow,
    /\.github\/workflows\/docs-pages-cleanup\.yml/,
  );
  assert.match(
    documentationWorkflow,
    /\.github\/workflows\/docs-pages-contract\.test\.mjs/,
  );
  assert.match(
    documentationWorkflow,
    /node --test \.github\/workflows\/docs-pages-contract\.test\.mjs/,
  );
  assert.match(documentationWorkflow, /pnpm --dir website translations:status/);
  assert.match(documentationWorkflow, /is_https_origin\(\)/);
  assert.match(documentationWorkflow, /is_safe_project_slug\(\)/);
  assert.match(documentationWorkflow, /github\.ref_protected/);
  assert.match(
    documentationWorkflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(
    documentationWorkflow,
    /caseweaver-documentation-\$\{\{ github\.sha \}\}/,
  );

  for (const workflow of [documentationWorkflow, cleanupWorkflow]) {
    const actionReferences = workflow.matchAll(
      /^\s*-?\s*uses:\s+[^\s]+@([^\s]+)\s*$/gm,
    );
    for (const actionReference of actionReferences) {
      assert.match(
        actionReference[1],
        /^[a-f0-9]{40}$/i,
        "actions must use immutable SHAs",
      );
    }
  }

  const verify = jobSection(
    documentationWorkflow,
    "verify",
    "publish-production",
  );
  assert.match(verify, /pnpm --dir website install --frozen-lockfile/);
  assert.match(verify, /pnpm --dir website typecheck/);
  assert.match(verify, /pnpm --dir website test/);
  assert.match(verify, /pnpm --dir website build/);
  assert.match(verify, /path: website\/build/);
  assert.doesNotMatch(verify, /CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(verify, /cloudflare\/wrangler-action/);

  const production = jobSection(
    documentationWorkflow,
    "publish-production",
    "publish-preview",
  );
  assert.match(production, /needs: verify/);
  assert.match(production, /permissions: \{\}/);
  assert.doesNotMatch(production, /actions\/checkout/);
  assert.doesNotMatch(production, /deployments:\s*write/);
  assert.doesNotMatch(production, /gitHubToken/);
  assert.match(production, /actions\/download-artifact/);
  assert.match(production, /github\.ref == 'refs\/heads\/main'/);
  assert.match(production, /github\.ref_protected/);

  const preview = jobSection(documentationWorkflow, "publish-preview");
  assert.match(preview, /needs: verify/);
  assert.match(
    preview,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(preview, /pull-requests:\s*write/);
  assert.doesNotMatch(preview, /actions\/checkout/);
  assert.doesNotMatch(preview, /deployments:\s*write/);
  assert.doesNotMatch(preview, /gitHubToken/);
  assert.match(preview, /actions\/download-artifact/);

  assert.doesNotMatch(
    `${documentationWorkflow}\n${cleanupWorkflow}`,
    /(?:DATABASE_URL|POSTGRES(?:QL)?_|OPENROUTER|OIDC|CONNECTOR_|CASEWEAVER_(?!DOCS_SITE_URL))/,
  );
});

test("cleanup uses protected production pruning, safe retention, dry runs, and pagination", () => {
  const previewCleanup = jobSection(
    cleanupWorkflow,
    "cleanup-stale-previews",
    "cleanup-old-production",
  );
  const productionCleanup = jobSection(
    cleanupWorkflow,
    "cleanup-old-production",
  );

  assert.match(cleanupWorkflow, /keep_production must be a positive integer/);
  assert.match(cleanupWorkflow, /\^\[1-9\]\[0-9\]\*\$/);
  assert.match(cleanupWorkflow, /dry_run must be true or false/);
  assert.match(cleanupWorkflow, /result_info\.total_pages/);
  assert.match(cleanupWorkflow, /\.success == true/);
  assert.match(cleanupWorkflow, /--data-urlencode 'per_page=100'/);
  assert.match(cleanupWorkflow, /set -euo pipefail/);
  assert.match(
    cleanupWorkflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(previewCleanup, /name: cloudflare-pages-preview/);
  assert.match(previewCleanup, /group: cloudflare-pages-preview/);
  assert.match(productionCleanup, /name: cloudflare-pages-production/);
  assert.match(productionCleanup, /group: cloudflare-pages-production/);
  assert.match(productionCleanup, /github\.ref == 'refs\/heads\/main'/);
  assert.match(productionCleanup, /github\.ref_protected/);
});
