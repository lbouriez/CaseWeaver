import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const origin =
  process.env.CASEWEAVER_E2E_COMPOSE_ORIGIN ?? "http://127.0.0.1:8080";
const documentationRepository = process.env.CASEWEAVER_DOCUMENTATION_REPOSITORY;
const runId = randomUUID().replaceAll("-", "");
const sourceName = `Live OpenRouter documentation ${runId}`;
const sourceNameSqlLiteral = `'${sourceName.replaceAll("'", "''")}'`;
const composeFiles = [
  path.join(repositoryRoot, "deploy", "docker", "compose.local.yml"),
  path.join(
    repositoryRoot,
    "deploy",
    "docker",
    "compose.local.documentation.yml",
  ),
];
const composePrefix = [
  "compose",
  ...composeFiles.flatMap((file) => ["--file", file]),
];
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const playwrightCli = path.join(
  repositoryRoot,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);

if (
  documentationRepository === undefined ||
  documentationRepository.length === 0
) {
  throw new Error(
    "Set CASEWEAVER_DOCUMENTATION_REPOSITORY to the mounted Git worktree before running the live acceptance test.",
  );
}

const parsedOrigin = new URL(origin);
if (
  parsedOrigin.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(parsedOrigin.hostname)
) {
  throw new Error(
    "Live OpenRouter acceptance is restricted to loopback Compose.",
  );
}

/** The browser test and this verifier never need the provider value. Removing
 * it from child environments proves only the already-running backend sees it. */
const environment = {
  ...process.env,
  CASEWEAVER_E2E_COMPOSE_ORIGIN: origin,
  CASEWEAVER_E2E_LIVE_OPENROUTER: "true",
  CASEWEAVER_E2E_OPENROUTER_EMBEDDINGS_AVAILABLE: "true",
  CASEWEAVER_E2E_LIVE_RUN_ID: runId,
};
delete environment.CASEWEAVER_OPENROUTER_KEY;

function run(executable, argumentsList, options = {}) {
  const result = spawnSync(executable, argumentsList, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} ${argumentsList.join(" ")} failed.`);
  }
}

function synchronizationCompleted() {
  const query = [
    "WITH selected_source AS (",
    "SELECT source.workspace_id, source.id FROM knowledge_sources AS source",
    "JOIN administration_configurations AS configuration",
    "ON configuration.workspace_id = source.workspace_id AND configuration.id = source.id",
    "JOIN administration_configuration_versions AS version",
    "ON version.workspace_id = configuration.workspace_id AND version.id = configuration.current_version_id",
    "WHERE configuration.resource_type = 'knowledge-sources'",
    `AND version.display_name = ${sourceNameSqlLiteral}`,
    ") SELECT CASE WHEN",
    "EXISTS (SELECT 1 FROM selected_source AS source JOIN knowledge_source_states AS state",
    "ON state.workspace_id = source.workspace_id AND state.knowledge_source_id = source.id",
    "WHERE state.last_completed_at IS NOT NULL)",
    "AND EXISTS (SELECT 1 FROM selected_source AS source JOIN knowledge_documents AS document",
    "ON document.workspace_id = source.workspace_id AND document.knowledge_source_id = source.id",
    "WHERE document.lifecycle = 'active' AND document.active_revision_id IS NOT NULL)",
    "AND EXISTS (SELECT 1 FROM selected_source AS source JOIN knowledge_documents AS document",
    "ON document.workspace_id = source.workspace_id AND document.knowledge_source_id = source.id",
    "JOIN knowledge_revisions AS revision ON revision.workspace_id = document.workspace_id",
    "AND revision.id = document.active_revision_id",
    "JOIN knowledge_chunks AS chunk ON chunk.workspace_id = revision.workspace_id",
    "AND chunk.knowledge_revision_id = revision.id",
    "JOIN knowledge_embedding_cache_entries AS cache ON cache.workspace_id = chunk.workspace_id",
    "AND cache.id = chunk.embedding_cache_entry_id",
    "JOIN knowledge_embedding_allocations AS allocation ON allocation.workspace_id = cache.workspace_id",
    "AND allocation.embedding_cache_entry_id = cache.id)",
    "THEN 'ready' ELSE 'waiting' END;",
  ].join(" ");
  const result = spawnSync(
    docker,
    [
      ...composePrefix,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "caseweaver",
      "-d",
      "caseweaver",
      "-tAc",
      query,
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      shell: false,
      timeout: 5_000,
    },
  );
  return result.status === 0 && result.stdout.trim() === "ready";
}

async function waitForSynchronization() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (synchronizationCompleted()) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    "The live source synchronization did not create a durable document and embedding allocation within three minutes.",
  );
}

console.log(
  "Running browser onboarding against the existing local Compose stack.",
);
run(process.execPath, [
  playwrightCli,
  "test",
  "tests/e2e/live-openrouter-knowledge.spec.ts",
  "--workers=1",
]);
console.log("Waiting for durable live knowledge synchronization.");
await waitForSynchronization();
console.log(
  "Live OpenRouter provider onboarding and knowledge synchronization passed.",
);
