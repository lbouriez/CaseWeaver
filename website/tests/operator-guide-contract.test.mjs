import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const siteRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(siteRoot, "..");

function readRepositoryFile(path) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function readGuide(path) {
  return readFileSync(resolve(siteRoot, "docs", path), "utf8");
}

test("the quick start is tied to the supported three-service local topology", () => {
  const guide = readGuide("quick-start.md");
  const compose = readRepositoryFile("deploy/docker/compose.local.yml");

  assert.match(
    guide,
    /docker compose -f deploy\\docker\\compose\.local\.yml up --build --wait/u,
  );
  for (const service of ["postgres", "backend", "frontend"]) {
    assert.match(compose, new RegExp(`^  ${service}:`, "mu"));
  }
  assert.match(
    guide,
    /three persistent services: PostgreSQL\/pgvector, one standalone backend, and[\s\S]*static Admin frontend/u,
  );
  assert.match(compose, /CASEWEAVER_LOCAL_PORT:-8080/u);
  assert.equal((compose.match(/^ {4}ports:/gmu) ?? []).length, 1);
  assert.match(
    guide,
    /docker compose -f deploy\\docker\\compose\.local\.yml down -v/u,
  );
});

test("access and production guides retain the API authentication boundary", () => {
  const accessGuide = readGuide("access-and-secrets.md");
  const configurationGuide = readGuide("configuration-reference.md");
  const selfHostingGuide = readGuide("self-hosting.md");
  const apiConfig = readRepositoryFile("apps/api/src/config.ts");
  const productionExample = readRepositoryFile(
    "deploy/docker/.env.production.example",
  );

  for (const key of [
    "ADMIN_ALLOWED_ORIGINS",
    "ADMIN_LOGIN",
    "ADMIN_PASSWORD",
    "ADMIN_ENABLE_PASSWORD_AUTHENTICATION",
    "ADMIN_DISABLE_LOGIN_AUTHENTICATION",
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CALLBACK_URL",
    "OIDC_EPHEMERAL_ENCRYPTION_KEY",
    "OIDC_EPHEMERAL_KEY_ID",
    "TRUSTED_PROXY_CIDRS",
  ]) {
    assert.match(apiConfig, new RegExp(key, "u"));
    assert.match(`${accessGuide}\n${configurationGuide}`, new RegExp(key, "u"));
  }
  assert.match(productionExample, /ADMIN_DISABLE_LOGIN_AUTHENTICATION=true/u);
  assert.match(selfHostingGuide, /Only the Nginx TLS edge publishes ports\./u);
  assert.match(accessGuide, /There is no localStorage token fallback\./u);
});

test("the production guide keeps attachment preparation in its isolated sidecar", () => {
  const guide = readGuide("self-hosting.md");
  const productionCompose = readRepositoryFile(
    "deploy/docker/compose.production.yml",
  );

  assert.match(productionCompose, /^ {2}attachment-processor:/mu);
  assert.match(productionCompose, /network_mode: none/u);
  assert.match(guide, /separate no-network Unix-socket sidecar/u);
  assert.doesNotMatch(
    guide,
    /attachment processing share one backend process/u,
  );
});

test("the local Git guide uses the actual read-only worktree overlay", () => {
  const guide = readGuide("git-markdown.md");
  const overlay = readRepositoryFile(
    "deploy/docker/compose.local.documentation.yml",
  );

  assert.match(
    guide,
    /CASEWEAVER_DOCUMENTATION_REPOSITORY = "<absolute path to a Git worktree>"/u,
  );
  assert.match(
    guide,
    /"path": "\/mnt\/caseweaver\/repositories\/documentation"/u,
  );
  assert.match(
    guide,
    /"allowedLocalRoots": \["\/mnt\/caseweaver\/repositories"\]/u,
  );
  assert.match(
    overlay,
    /target: \/mnt\/caseweaver\/repositories\/documentation/u,
  );
  assert.match(overlay, /read_only: true/u);
  assert.match(overlay, /CASEWEAVER_GIT_TRUSTED_LOCAL_ROOTS_JSON/u);
});
