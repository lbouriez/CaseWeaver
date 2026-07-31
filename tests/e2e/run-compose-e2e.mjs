import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const e2ePort = process.env.CASEWEAVER_E2E_PORT ?? "18080";
const projectName =
  process.env.CASEWEAVER_E2E_PROJECT ?? `caseweaver-e2e-${process.pid}`;
const keepStack = process.env.CASEWEAVER_E2E_KEEP_STACK === "true";
const composeFiles = [
  path.join(repositoryRoot, "deploy", "docker", "compose.local.yml"),
  path.join(repositoryRoot, "deploy", "docker", "compose.e2e.yml"),
];
const composePrefix = [
  "compose",
  "--project-name",
  projectName,
  ...composeFiles.flatMap((file) => ["--file", file]),
];
const command = process.platform === "win32" ? "docker.exe" : "docker";
const playwrightCli = path.join(
  repositoryRoot,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);
const environment = {
  ...process.env,
  CASEWEAVER_E2E_PORT: e2ePort,
  CASEWEAVER_LOCAL_PORT: e2ePort,
  CASEWEAVER_E2E_COMPOSE_ORIGIN: `http://127.0.0.1:${e2ePort}`,
};

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

function compose(...argumentsList) {
  run(command, [...composePrefix, ...argumentsList]);
}

function projectContainerIds() {
  const result = spawnSync(
    command,
    [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
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
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Could not inspect the isolated Compose project.");
  }
  return result.stdout.trim();
}

async function removeProject() {
  console.log("Removing the isolated E2E Compose project.");
  compose("down", "--volumes", "--remove-orphans", "--timeout", "30");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (projectContainerIds().length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The isolated E2E Compose project did not finish removing.");
}

function synchronizationCompleted() {
  const query = [
    "SELECT CASE WHEN",
    "EXISTS (SELECT 1 FROM knowledge_source_states WHERE last_completed_at IS NOT NULL)",
    "AND EXISTS (SELECT 1 FROM knowledge_documents WHERE lifecycle = 'active')",
    "AND EXISTS (SELECT 1 FROM knowledge_embedding_allocations)",
    "THEN 'ready' ELSE 'waiting' END;",
  ].join(" ");
  const result = spawnSync(
    command,
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
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (synchronizationCompleted()) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    "The source synchronization did not create an active document and embedding allocation within 90 seconds.",
  );
}

try {
  await removeProject();
  console.log("Starting the isolated E2E Compose project.");
  compose("up", "--build", "--wait", "--wait-timeout", "240");
  console.log("Running the browser onboarding journey.");
  run(process.execPath, [
    playwrightCli,
    "test",
    "tests/e2e/provider-onboarding-compose.spec.ts",
  ]);
  console.log("Waiting for durable knowledge synchronization.");
  await waitForSynchronization();
  console.log(
    "Deterministic provider onboarding and knowledge synchronization passed.",
  );
} finally {
  if (!keepStack) {
    try {
      await removeProject();
    } catch (_error) {
      console.error("The E2E stack cleanup failed.");
      if (!process.exitCode) process.exitCode = 1;
    }
  }
}
