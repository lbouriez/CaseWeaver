import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const composeFile = path.join(scriptDirectory, "compose.production.yml");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const immutableDigest = /^[^\s@]+@sha256:[a-f0-9]{64}$/iu;
const safeMode = new Set(["standalone", "distributed"]);
const requiredImages = [
  "CASEWEAVER_POSTGRES_IMAGE",
  "CASEWEAVER_MIGRATION_IMAGE",
  "CASEWEAVER_API_IMAGE",
  "CASEWEAVER_ADMIN_IMAGE",
  "CASEWEAVER_WORKER_IMAGE",
  "CASEWEAVER_SCHEDULER_IMAGE",
  "CASEWEAVER_WEBHOOK_IMAGE",
  "CASEWEAVER_STANDALONE_IMAGE",
  "CASEWEAVER_ATTACHMENT_PROCESSOR_IMAGE",
  "CASEWEAVER_EDGE_IMAGE",
  "CASEWEAVER_S3_OPERATIONS_IMAGE",
];
const requiredSecretFiles = [
  "CASEWEAVER_POSTGRES_PASSWORD_FILE",
  "CASEWEAVER_RUNTIME_DATABASE_PASSWORD_FILE",
  "CASEWEAVER_MIGRATION_DATABASE_URL_FILE",
  "CASEWEAVER_RUNTIME_DATABASE_URL_FILE",
  "CASEWEAVER_TLS_CERTIFICATE_FILE",
  "CASEWEAVER_TLS_PRIVATE_KEY_FILE",
];

function isIsolatedTestImage(environment, value) {
  return (
    environment.CASEWEAVER_DEPLOYMENT_TEST_MODE === "true" &&
    /^caseweaver-(?:migration|api|admin|worker|scheduler|webhook|standalone|attachment-processor):production-e2e$/u.test(
      value,
    )
  );
}
const mountedSecretFiles = [
  ...requiredSecretFiles,
  "CASEWEAVER_OIDC_CLIENT_SECRET_FILE",
  "CASEWEAVER_OIDC_EPHEMERAL_ENCRYPTION_KEY_FILE",
  "CASEWEAVER_ADMIN_LOGIN_FILE",
  "CASEWEAVER_ADMIN_PASSWORD_FILE",
  "CASEWEAVER_OBJECT_STORAGE_KEY_DERIVATION_SECRET_FILE",
  "CASEWEAVER_OBJECT_STORAGE_S3_ACCESS_KEY_ID_FILE",
  "CASEWEAVER_OBJECT_STORAGE_S3_SECRET_ACCESS_KEY_FILE",
  "CASEWEAVER_TRUSTED_CA_FILE",
];
const requiredObjectStorageValues = [
  "OBJECT_STORAGE_KIND",
  "OBJECT_STORAGE_BACKEND_ID",
  "OBJECT_STORAGE_S3_REGION",
  "OBJECT_STORAGE_S3_BUCKET",
  "OBJECT_STORAGE_S3_BACKUP_BUCKET",
];
const requiredObjectStorageSecretFiles = [
  "CASEWEAVER_OBJECT_STORAGE_KEY_DERIVATION_SECRET_FILE",
  "CASEWEAVER_OBJECT_STORAGE_S3_ACCESS_KEY_ID_FILE",
  "CASEWEAVER_OBJECT_STORAGE_S3_SECRET_ACCESS_KEY_FILE",
];

function usage() {
  console.error(
    "Usage: node deploy/docker/production-operations.mjs <validate|migrate|start|backup|restore> --env-file <path> [--mode standalone|distributed] [--output <file>|--input <file>]",
  );
}

function parseArguments(argumentsList) {
  const [command, ...rest] = argumentsList;
  const options = {
    command,
    envFile: undefined,
    mode: undefined,
    output: undefined,
    input: undefined,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    const value = rest[index + 1];
    if (key === "--env-file") options.envFile = value;
    else if (key === "--mode") options.mode = value;
    else if (key === "--output") options.output = value;
    else if (key === "--input") options.input = value;
    else throw new Error("The deployment helper received an invalid option.");
    index += 1;
  }
  if (
    !["validate", "migrate", "start", "backup", "restore"].includes(command) ||
    options.envFile === undefined
  ) {
    throw new Error("The deployment helper requires a command and --env-file.");
  }
  return options;
}

async function readEnvironment(envFile) {
  let source;
  try {
    source = await fs.readFile(envFile, "utf8");
  } catch {
    throw new Error(
      "Set --env-file to a readable operator-owned environment file.",
    );
  }
  const values = { ...process.env };
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0)
      throw new Error("The production environment file is malformed.");
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) {
      throw new Error(
        "The production environment file contains an invalid key.",
      );
    }
    values[key] = value;
  }
  return values;
}

function requiredValue(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Set ${key} in the operator-owned environment file.`);
  }
  return value;
}

async function validateEnvironment(environment, mode) {
  for (const key of requiredImages) {
    const image = requiredValue(environment, key);
    if (
      !immutableDigest.test(image) &&
      !isIsolatedTestImage(environment, image)
    ) {
      throw new Error(`${key} must be an immutable image@sha256 digest.`);
    }
  }
  requiredValue(environment, "CASEWEAVER_RELEASE_VERSION");
  const origin = requiredValue(environment, "ADMIN_ALLOWED_ORIGINS");
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error("ADMIN_ALLOWED_ORIGINS must be one exact HTTPS origin.");
  }
  if (
    parsedOrigin.protocol !== "https:" ||
    parsedOrigin.username.length > 0 ||
    parsedOrigin.password.length > 0 ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search.length > 0 ||
    parsedOrigin.hash.length > 0
  ) {
    throw new Error("ADMIN_ALLOWED_ORIGINS must be one exact HTTPS origin.");
  }
  requiredValue(environment, "API_WORKSPACE_ID");
  requiredValue(environment, "API_PRINCIPAL_ID");
  for (const key of requiredObjectStorageValues)
    requiredValue(environment, key);
  if (environment.OBJECT_STORAGE_KIND !== "s3") {
    throw new Error("OBJECT_STORAGE_KIND must be s3 in production.");
  }
  const subnet = environment.CASEWEAVER_APPLICATION_SUBNET ?? "172.28.0.0/24";
  if (requiredValue(environment, "TRUSTED_PROXY_CIDRS") !== subnet) {
    throw new Error(
      "TRUSTED_PROXY_CIDRS must equal CASEWEAVER_APPLICATION_SUBNET.",
    );
  }
  requiredValue(environment, "CASEWEAVER_EDGE_HTTP_BINDING");
  requiredValue(environment, "CASEWEAVER_EDGE_HTTPS_BINDING");
  requiredValue(environment, "CASEWEAVER_EDGE_PUBLIC_HTTPS_PORT");
  if (mode !== undefined) {
    if (!safeMode.has(mode))
      throw new Error("--mode must be standalone or distributed.");
    const expectedApi = mode === "standalone" ? "standalone:3000" : "api:3000";
    const expectedWebhook =
      mode === "standalone" ? "standalone:8081" : "webhook:8081";
    if (environment.CASEWEAVER_EDGE_API_UPSTREAM !== expectedApi) {
      throw new Error(
        "CASEWEAVER_EDGE_API_UPSTREAM does not match the selected profile.",
      );
    }
    if (environment.CASEWEAVER_EDGE_WEBHOOK_UPSTREAM !== expectedWebhook) {
      throw new Error(
        "CASEWEAVER_EDGE_WEBHOOK_UPSTREAM does not match the selected profile.",
      );
    }
  }
  for (const key of mountedSecretFiles) {
    const secretPath = requiredValue(environment, key);
    let stat;
    try {
      stat = await fs.stat(secretPath);
    } catch {
      throw new Error(`Set ${key} to a readable operator-owned secret file.`);
    }
    if (!stat.isFile())
      throw new Error(`Set ${key} to a regular operator-owned secret file.`);
    if (
      [...requiredSecretFiles, ...requiredObjectStorageSecretFiles].includes(
        key,
      ) &&
      stat.size === 0
    ) {
      throw new Error(
        `${key} must reference a non-empty operator-owned secret file.`,
      );
    }
  }
  const applicationSecrets = requiredValue(
    environment,
    "CASEWEAVER_APPLICATION_SECRETS_DIRECTORY",
  );
  try {
    if (!(await fs.stat(applicationSecrets)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new Error(
      "Set CASEWEAVER_APPLICATION_SECRETS_DIRECTORY to a readable secret directory.",
    );
  }
}

function composeArguments(envFile, argumentsList) {
  return [
    "compose",
    "--env-file",
    envFile,
    "--file",
    composeFile,
    ...argumentsList,
  ];
}

function runCompose(envFile, argumentsList, environment, options = {}) {
  const result = spawnSync(docker, composeArguments(envFile, argumentsList), {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("The Docker Compose operation failed.");
  }
}

function applyMigrations(envFile, environment) {
  // `docker compose up --abort-on-container-exit` aborts as soon as the
  // successful Prisma job exits, so it cannot compose a migration chain. Keep
  // PostgreSQL alive and run the bounded jobs in their explicit order instead.
  runCompose(envFile, ["up", "--detach", "--wait", "postgres"], environment);
  for (const service of ["migrate", "queue-migrate", "grant-runtime"]) {
    runCompose(
      envFile,
      ["--profile", "migrate", "run", "--rm", "--no-deps", service],
      environment,
    );
  }
}

function refreshTlsMaterial(envFile, environment) {
  // A one-shot job owns the in-memory, unprivileged TLS copy. Recreate it on
  // every helper start so a renewed operator file is never silently ignored.
  runCompose(envFile, ["rm", "--force", "--stop", "tls-material"], environment);
}

async function streamCompose(
  envFile,
  argumentsList,
  environment,
  input,
  output,
) {
  await new Promise((resolve, reject) => {
    const child = spawn(docker, composeArguments(envFile, argumentsList), {
      cwd: repositoryRoot,
      env: environment,
      stdio: [input, output, "inherit"],
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error("The Docker Compose stream operation failed."));
    });
  });
}

function requireMode(mode) {
  if (!safeMode.has(mode)) {
    throw new Error(
      "backup and restore require --mode standalone or distributed.",
    );
  }
  return mode;
}

function backupManifestPath(output) {
  return `${output}.manifest.json`;
}

function normalizedObjectPrefix(value) {
  const prefix = value ?? "caseweaver-backups";
  if (
    !/^[a-z0-9][a-z0-9._/-]{0,199}$/u.test(prefix) ||
    prefix.includes("//") ||
    prefix.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("OBJECT_STORAGE_S3_BACKUP_PREFIX is invalid.");
  }
  return prefix.replace(/\/+$/u, "");
}

function s3Location(bucket, prefix) {
  return `s3://${bucket}/${prefix.replace(/^\/+|\/+$/gu, "")}`;
}

function objectStoreArguments(environment) {
  const endpoint = environment.OBJECT_STORAGE_S3_ENDPOINT?.trim();
  return endpoint === undefined || endpoint.length === 0
    ? []
    : ["--endpoint-url", endpoint];
}

function runObjectStoreOperation(envFile, environment, argumentsList) {
  runCompose(
    envFile,
    [
      "--profile",
      "operations",
      "run",
      "--rm",
      "--no-deps",
      "object-store-operations",
      ...objectStoreArguments(environment),
      ...argumentsList,
    ],
    environment,
  );
}

function stopRuntime(envFile, environment, mode) {
  const services =
    mode === "standalone"
      ? ["edge", "admin", "standalone", "attachment-processor"]
      : [
          "edge",
          "admin",
          "api",
          "webhook",
          "scheduler",
          "worker",
          "attachment-processor",
        ];
  // The supported backup and restore boundary is a stopped runtime. This
  // prevents new outbox/queue/object writes while PostgreSQL and S3 snapshots
  // are taken or applied. PostgreSQL remains running for the logical dump.
  runCompose(
    envFile,
    ["--profile", mode, "stop", "--timeout", "60", ...services],
    environment,
  );
}

async function readBackupManifest(output) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(backupManifestPath(output), "utf8"));
  } catch {
    throw new Error(
      "restore requires the matching object-store backup manifest.",
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.format !== "caseweaver-object-store-backup/v1" ||
    typeof parsed.sourceBucket !== "string" ||
    typeof parsed.sourcePrefix !== "string" ||
    typeof parsed.backupBucket !== "string" ||
    typeof parsed.backupPrefix !== "string"
  ) {
    throw new Error("The object-store backup manifest is invalid.");
  }
  return parsed;
}

async function backup(options, environment) {
  if (options.output === undefined)
    throw new Error("backup requires --output.");
  const mode = requireMode(options.mode);
  const output = path.resolve(options.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  stopRuntime(options.envFile, environment, mode);
  const backupPrefix = `${normalizedObjectPrefix(
    environment.OBJECT_STORAGE_S3_BACKUP_PREFIX,
  )}/${randomUUID()}/objects`;
  runObjectStoreOperation(options.envFile, environment, [
    "s3",
    "sync",
    s3Location(
      requiredValue(environment, "OBJECT_STORAGE_S3_BUCKET"),
      requiredValue(environment, "OBJECT_STORAGE_KEY_PREFIX"),
    ),
    s3Location(
      requiredValue(environment, "OBJECT_STORAGE_S3_BACKUP_BUCKET"),
      backupPrefix,
    ),
    "--no-progress",
    "--only-show-errors",
  ]);
  const databaseOutput = await fs.open(output, "wx", 0o600);
  try {
    await streamCompose(
      options.envFile,
      [
        "exec",
        "-T",
        "postgres",
        "pg_dump",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "-U",
        environment.POSTGRES_USER ?? "caseweaver_migrator",
        "-d",
        environment.POSTGRES_DB ?? "caseweaver",
      ],
      environment,
      "ignore",
      databaseOutput.fd,
    );
  } finally {
    await databaseOutput.close();
  }
  await fs.writeFile(
    backupManifestPath(output),
    `${JSON.stringify({
      format: "caseweaver-object-store-backup/v1",
      createdAt: new Date().toISOString(),
      releaseVersion: requiredValue(environment, "CASEWEAVER_RELEASE_VERSION"),
      sourceBucket: requiredValue(environment, "OBJECT_STORAGE_S3_BUCKET"),
      sourcePrefix: requiredValue(environment, "OBJECT_STORAGE_KEY_PREFIX"),
      backupBucket: requiredValue(
        environment,
        "OBJECT_STORAGE_S3_BACKUP_BUCKET",
      ),
      backupPrefix,
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

async function restore(options, environment) {
  if (options.input === undefined || !existsSync(options.input)) {
    throw new Error("restore requires an existing --input backup file.");
  }
  const mode = requireMode(options.mode);
  const output = path.resolve(options.input);
  const manifest = await readBackupManifest(output);
  if (
    manifest.sourceBucket !==
      requiredValue(environment, "OBJECT_STORAGE_S3_BUCKET") ||
    manifest.sourcePrefix !==
      requiredValue(environment, "OBJECT_STORAGE_KEY_PREFIX") ||
    manifest.backupBucket !==
      requiredValue(environment, "OBJECT_STORAGE_S3_BACKUP_BUCKET")
  ) {
    throw new Error(
      "The object-store backup manifest does not match this deployment configuration.",
    );
  }
  stopRuntime(options.envFile, environment, mode);
  runCompose(options.envFile, ["up", "-d", "--wait", "postgres"], environment);
  // Copy into a new/emptied recovery prefix before restoring database references.
  // `sync` intentionally never deletes a destination object: destructive object
  // cleanup is an explicit operator recovery decision, not a helper side effect.
  runObjectStoreOperation(options.envFile, environment, [
    "s3",
    "sync",
    s3Location(manifest.backupBucket, manifest.backupPrefix),
    s3Location(manifest.sourceBucket, manifest.sourcePrefix),
    "--no-progress",
    "--only-show-errors",
  ]);
  const databaseInput = await fs.open(output, "r");
  try {
    await streamCompose(
      options.envFile,
      [
        "exec",
        "-T",
        "postgres",
        "pg_restore",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "-U",
        environment.POSTGRES_USER ?? "caseweaver_migrator",
        "-d",
        environment.POSTGRES_DB ?? "caseweaver",
      ],
      environment,
      databaseInput.fd,
      "inherit",
    );
  } finally {
    await databaseInput.close();
  }
  applyMigrations(options.envFile, environment);
}

try {
  const options = parseArguments(process.argv.slice(2));
  const environment = await readEnvironment(options.envFile);
  await validateEnvironment(
    environment,
    options.command === "validate" ? undefined : options.mode,
  );
  if (options.command === "validate") {
    runCompose(options.envFile, ["config", "-q"], environment);
  } else if (options.command === "migrate") {
    applyMigrations(options.envFile, environment);
  } else if (options.command === "start") {
    if (options.mode === undefined) throw new Error("start requires --mode.");
    refreshTlsMaterial(options.envFile, environment);
    runCompose(
      options.envFile,
      ["--profile", options.mode, "up", "--detach", "--wait"],
      environment,
    );
  } else if (options.command === "backup") {
    await backup(options, environment);
  } else {
    await restore(options, environment);
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "The production operation failed.",
  );
  usage();
  process.exitCode = 1;
}
