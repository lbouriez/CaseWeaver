import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("./admin-pages.yml", import.meta.url),
  "utf8",
);

test("Admin Pages verification has no deployment credential and retains a checked artifact", () => {
  const verifySection = workflow.slice(
    workflow.indexOf("  verify:"),
    workflow.indexOf("  publish-production:"),
  );

  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.match(
    verifySection,
    /node --test apps\/admin\/scripts\/write-pages-runtime-config\.test\.mjs/,
  );
  assert.match(verifySection, /pnpm --filter @caseweaver\/admin build/);
  assert.match(
    verifySection,
    /write-pages-runtime-config\.mjs apps\/admin\/dist/,
  );
  assert.match(verifySection, /caseweaver-admin-pages-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(verifySection, /API_TOKEN|wrangler-action|pages deploy/);
  assert.doesNotMatch(verifySection, /secrets\./);
  assert.doesNotMatch(verifySection, /pull_request_target|workflow_run/);
});

test("Admin Pages is protected-main, artifact-only, and never creates a dynamic preview", () => {
  const publishSection = workflow.slice(
    workflow.indexOf("  publish-production:"),
  );

  assert.match(publishSection, /github\.ref_protected/);
  assert.match(publishSection, /name: caseweaver-admin-pages-production/);
  assert.match(publishSection, /CASEWEAVER_ADMIN_PAGES_PROJECT/);
  assert.match(publishSection, /CASEWEAVER_ADMIN_PAGES_API_TOKEN/);
  assert.match(publishSection, /Download verified Admin Pages artifact/);
  assert.match(publishSection, /pages deploy apps\/admin\/dist/);
  assert.doesNotMatch(publishSection, /actions\/checkout/);
  assert.doesNotMatch(
    publishSection,
    /setup-node|pnpm|write-pages-runtime-config/,
  );
  assert.doesNotMatch(workflow, /publish-preview|--branch=pr-/);
  assert.doesNotMatch(workflow, /permissions:\s*write-all/);
});
