import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const siteRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(siteRoot, "..");
const composeFiles = [
  "compose.local.yml",
  "compose.local.documentation.yml",
  "compose.e2e.yml",
  "compose.test.yml",
  "compose.admin.yml",
  "compose.production.yml",
  "compose.portainer.yml",
];
const deploymentExampleFiles = [
  ".env.production.example",
  ".env.portainer.example",
];

function readRepositoryFile(path) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function readGuide(path) {
  return readFileSync(resolve(siteRoot, "docs", path), "utf8");
}

function composeInterpolationKeys(source) {
  return [
    ...source.matchAll(/\$\{([A-Z][A-Z0-9_]+)/gu),
  ].map((match) => match[1]);
}

function deploymentExampleKeys(source) {
  return source
    .split("\n")
    .flatMap((line) => line.match(/^([A-Z][A-Z0-9_]*)=/u)?.[1] ?? []);
}

test("the deployment reference classifies every tracked Compose topology", () => {
  const guide = readGuide("deployment-reference.md");
  for (const file of composeFiles) {
    assert.equal(guide.includes(`\`${file}\``), true, file);
    assert.match(
      readRepositoryFile(`deploy/docker/${file}`),
      /(?:services:|name:)/u,
    );
  }
  assert.match(guide, /minimum-interaction way to try the product/u);
  assert.match(guide, /deterministic product acceptance journey/u);
  assert.match(guide, /Host-run PostgreSQL integration tests/u);
  assert.match(guide, /Admin image only/u);
});

test("the configuration catalog covers every Compose interpolation boundary", () => {
  const catalog = readGuide("configuration-reference.md");
  const keys = new Set(
    composeFiles.flatMap((file) =>
      composeInterpolationKeys(readRepositoryFile(`deploy/docker/${file}`)),
    ),
  );

  for (const key of keys) {
    assert.equal(catalog.includes(`\`${key}\``), true, key);
  }
});

test("the configuration catalog covers published deployment inputs and separates paths from secret content", () => {
  const catalog = readGuide("configuration-reference.md");
  const keys = new Set(
    deploymentExampleFiles.flatMap((file) =>
      deploymentExampleKeys(readRepositoryFile(`deploy/docker/${file}`)),
    ),
  );

  for (const key of keys) {
    assert.equal(catalog.includes(`\`${key}\``), true, key);
  }

  assert.match(
    catalog,
    /A `\*_FILE` value is a public path; its file content is\s+secret\./u,
  );
  assert.match(catalog, /## Docker secret-file paths/u);
});

test("production and Portainer documentation retain their distinct security contracts", () => {
  const guide = readGuide("deployment-reference.md");
  const production = readRepositoryFile("deploy/docker/compose.production.yml");
  const portainer = readRepositoryFile("deploy/docker/compose.portainer.yml");

  for (const target of [
    "migration",
    "api",
    "admin",
    "worker",
    "scheduler",
    "webhook",
    "standalone",
    "attachment-processor",
  ]) {
    assert.equal(guide.includes(`\`${target}\``), true, target);
  }
  assert.match(production, /caseweaver_postgres_data/u);
  assert.match(production, /network_mode: none/u);
  assert.match(guide, /mutually exclusive runtime profiles/u);
  assert.match(guide, /production-operations\.mjs/u);
  assert.match(portainer, /location \/ \{\s*return 404;/u);
  assert.match(guide, /no Admin service and its root route is `404`/u);
  assert.match(guide, /`ADMIN_SESSION_COOKIE_SAME_SITE=none`/u);
  assert.match(guide, /`\/v1\/auth\/callback`/u);
  assert.match(guide, /does not implement a second\s+backup helper/u);
});

test("deployment documentation does not contain credential-bearing URLs or secret assignments", () => {
  const docs = [
    readGuide("deployment-reference.md"),
    readGuide("configuration-reference.md"),
    readGuide("self-hosting.md"),
  ].join("\n");

  assert.doesNotMatch(docs, /https:\/\/[^\s/:]+:[^\s@/]+@/u);
  assert.doesNotMatch(
    docs,
    /(?:api[_-]?key|token|password|private[_-]?key)\s*[:=]\s*[A-Za-z0-9_-]{12,}/iu,
  );
});
