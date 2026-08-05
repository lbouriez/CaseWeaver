import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const playwrightCli = path.join(
  repositoryRoot,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);
const productionCompose = path.join(
  repositoryRoot,
  "deploy",
  "docker",
  "compose.production.yml",
);
const productionOverlay = path.join(
  scriptDirectory,
  "compose.production.e2e.yml",
);
const operations = path.join(
  repositoryRoot,
  "deploy",
  "docker",
  "production-operations.mjs",
);
const keepStack = process.env.CASEWEAVER_E2E_KEEP_STACK === "true";
const skipImageBuild = process.env.CASEWEAVER_E2E_SKIP_IMAGE_BUILD === "true";
const runId = `${process.pid}-${randomBytes(4).toString("hex")}`;
const projectName = `caseweaver-production-e2e-${runId}`;
const portOffset =
  Number.parseInt(runId.slice(0, runId.indexOf("-")), 10) % 1_000;
const httpPort = 21_000 + portOffset;
const httpsPort = 22_000 + portOffset;
const oidcPort = 23_000 + portOffset;
const restoreHttpPort = 24_000 + portOffset;
const restoreHttpsPort = 25_000 + portOffset;
const subnetSeed = 20 + (randomBytes(1)[0] % 200);
// Docker Desktop commonly allocates every 172.17.0.0/16 through
// 172.30.0.0/16 to pre-existing Compose projects. Keep this disposable test
// topology in a distinct private range and vary its third octet per run.
const applicationSubnet = `10.250.${subnetSeed}.0/24`;
const egressSubnet = `10.251.${subnetSeed}.0/24`;
const oidcFixtureIp = `10.251.${subnetSeed}.20`;
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "caseweaver-production-e2e-"),
);
const secretDirectory = path.join(temporaryDirectory, "secrets");
const applicationSecretsDirectory = path.join(
  temporaryDirectory,
  "application-secrets",
);
const environmentFile = path.join(temporaryDirectory, "production.env");
const restoreEnvironmentFile = path.join(temporaryDirectory, "restore.env");
const distributedEnvironmentFile = path.join(
  temporaryDirectory,
  "distributed.env",
);
const backupFile = path.join(temporaryDirectory, "caseweaver.backup");
const objectMarkerFile = path.join(temporaryDirectory, "object-marker.txt");
const objectStorageVolume = `caseweaver-production-e2e-objects-${runId}`;
const values = new Map();
const secretValues = [];
let objectStorageVolumeCreated = false;

// This list is intentionally independent of Compose. It verifies properties of the
// built OCI artifacts themselves before the deployment drill can hide a bad final
// stage behind a working development/build stage.
const releaseImages = [
  {
    target: "migration",
    expectedUser: "node",
  },
  {
    target: "api",
    expectedUser: "node",
    artifactDirectory: "/opt/caseweaver/api",
  },
  {
    target: "admin",
    expectedUser: "101:101",
    artifactDirectory: "/usr/share/nginx/static",
  },
  {
    target: "worker",
    expectedUser: "node",
    artifactDirectory: "/opt/caseweaver/worker",
  },
  {
    target: "scheduler",
    expectedUser: "node",
    artifactDirectory: "/opt/caseweaver/scheduler",
  },
  {
    target: "webhook",
    expectedUser: "node",
    artifactDirectory: "/opt/caseweaver/webhook",
  },
  {
    target: "standalone",
    expectedUser: "node",
    artifactDirectory: "/opt/caseweaver/standalone",
  },
  {
    target: "attachment-processor",
    expectedUser: "node",
    artifactDirectory: "/opt/caseweaver/attachment-processor",
  },
];

function run(executable, argumentsList, options = {}) {
  const result = spawnSync(executable, argumentsList, {
    cwd: repositoryRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error("An isolated production Compose command failed.");
}

function capture(executable, argumentsList, options = {}) {
  const result = spawnSync(executable, argumentsList, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    ...options,
  });
  return result;
}

function composePrefix(envFile, includeFixture = true) {
  return [
    "compose",
    "--env-file",
    envFile,
    "--file",
    productionCompose,
    ...(includeFixture ? ["--file", productionOverlay] : []),
  ];
}

function compose(envFile, ...argumentsList) {
  run(docker, [...composePrefix(envFile), ...argumentsList]);
}

function operationsCommand(...argumentsList) {
  run(process.execPath, [operations, ...argumentsList]);
}

function objectStoreCommand(envFile, ...argumentsList) {
  compose(
    envFile,
    "--profile",
    "operations",
    "run",
    "--rm",
    "--no-deps",
    "object-store-operations",
    "--endpoint-url",
    "https://object-store:9000",
    ...argumentsList,
  );
}

function createObjectStoreBuckets(envFile) {
  for (const bucket of ["caseweaver-e2e-storage", "caseweaver-e2e-backups"]) {
    objectStoreCommand(
      envFile,
      "s3api",
      "create-bucket",
      "--bucket",
      bucket,
      "--create-bucket-configuration",
      "LocationConstraint=ca-central-1",
    );
  }
}

function seedObjectMarker(envFile) {
  objectStoreCommand(
    envFile,
    "s3",
    "cp",
    "/run/caseweaver-e2e/object-marker.txt",
    "s3://caseweaver-e2e-storage/caseweaver-e2e/recovery-marker.txt",
    "--no-progress",
    "--only-show-errors",
  );
}

function deleteObjectMarker(envFile) {
  objectStoreCommand(
    envFile,
    "s3",
    "rm",
    "s3://caseweaver-e2e-storage/caseweaver-e2e/recovery-marker.txt",
  );
}

function assertObjectMarker(envFile) {
  objectStoreCommand(
    envFile,
    "s3api",
    "head-object",
    "--bucket",
    "caseweaver-e2e-storage",
    "--key",
    "caseweaver-e2e/recovery-marker.txt",
  );
}

function randomSecret() {
  return randomBytes(36).toString("base64url");
}

async function secretFile(name, contents = randomSecret()) {
  const destination = path.join(secretDirectory, name);
  await writeFile(destination, `${contents}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (contents.length > 0) secretValues.push(contents);
  return destination;
}

async function createCertificate(certificate, privateKey) {
  // The fixture writes into a host-owned temporary directory. On Linux, the
  // Docker daemon otherwise creates the private key as root, which prevents
  // this runner from reading it back to prove the generated material exists.
  // Windows has no process UID/GID contract, so retain Docker's default there.
  const hostUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? `${process.getuid()}:${process.getgid()}`
      : undefined;
  run(docker, [
    "run",
    "--rm",
    ...(hostUser === undefined ? [] : ["--user", hostUser]),
    "--mount",
    `type=bind,source=${temporaryDirectory},target=/out`,
    "caseweaver-e2e-fixtures:production",
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "/out/secrets/tls-private-key.pem",
    "-out",
    "/out/secrets/tls-certificate.pem",
    "-days",
    "1",
    "-subj",
    "/CN=caseweaver.test",
    "-addext",
    "subjectAltName=DNS:caseweaver.test,DNS:oidc.caseweaver.test,DNS:object-store,IP:127.0.0.1",
  ]);
  await Promise.all([
    readFile(certificate, "utf8"),
    readFile(privateKey, "utf8"),
  ]);
}

function createObjectStorageVolume() {
  run(docker, [
    "volume",
    "create",
    "--label",
    "caseweaver.e2e.fixture=object-storage",
    objectStorageVolume,
  ]);
  objectStorageVolumeCreated = true;
}

function removeObjectStorageVolume() {
  if (!objectStorageVolumeCreated) return;
  const removed = capture(docker, ["volume", "rm", objectStorageVolume]);
  if (removed.status !== 0) {
    throw new Error(
      "The isolated object-store fixture volume could not be removed.",
    );
  }
  objectStorageVolumeCreated = false;
}

async function writeEnvironment(destination, overrides = {}) {
  const lines = [...values.entries()]
    .map(([key, value]) => `${key}=${overrides[key] ?? value}`)
    .join("\n");
  await writeFile(destination, `${lines}\n`, { encoding: "utf8", mode: 0o600 });
}

function assertWithoutSecrets(output, context) {
  for (const secret of secretValues) {
    if (output.includes(secret)) {
      throw new Error(`${context} disclosed an isolated test secret.`);
    }
  }
}

function runtimeRoleCannotCreateTables(envFile) {
  const result = capture(docker, [
    ...composePrefix(envFile),
    "exec",
    "-T",
    "postgres",
    "sh",
    "-ec",
    "PGPASSWORD=\"$(cat /run/secrets/runtime-database-password)\" psql -h 127.0.0.1 -U caseweaver_runtime -d caseweaver -v ON_ERROR_STOP=1 -c 'CREATE TABLE caseweaver_runtime_must_not_create (id integer)'",
  ]);
  if (result.status === 0)
    throw new Error("The runtime database role unexpectedly created a table.");
  assertWithoutSecrets(
    `${result.stdout}${result.stderr}`,
    "The database-role test",
  );
}

function assertOnlyEdgePublishesPorts(envFile) {
  const containers = capture(docker, [
    ...composePrefix(envFile),
    "ps",
    "--format",
    "json",
  ]);
  if (containers.status !== 0)
    throw new Error("Could not inspect the production Compose services.");
  const services = containers.stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  for (const service of services) {
    const publishesHostPort =
      Array.isArray(service.Publishers) &&
      service.Publishers.some(
        (publisher) =>
          publisher !== null &&
          typeof publisher === "object" &&
          "PublishedPort" in publisher &&
          typeof publisher.PublishedPort === "number" &&
          publisher.PublishedPort > 0,
      );
    if (!publishesHostPort || service.Service === "edge") continue;
    // `oidc-provider` exists only in the private test overlay, where its YAML
    // binding is explicitly loopback-only. It lets Playwright follow a real
    // authorization redirect. Every service in the operator Compose file other
    // than the TLS edge must remain unpublished.
    if (service.Service !== "oidc-provider") {
      throw new Error(
        "A production service other than the TLS edge published a host port.",
      );
    }
  }
}

function auditRowsExist(envFile) {
  const result = capture(docker, [
    ...composePrefix(envFile),
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "caseweaver_migrator",
    "-d",
    "caseweaver",
    "-tAc",
    "SELECT count(*) FROM audit_events",
  ]);
  if (result.status !== 0 || Number.parseInt(result.stdout.trim(), 10) < 1) {
    throw new Error(
      "The restored production database did not retain audit evidence.",
    );
  }
}

function assertTlsReadiness(project) {
  const restoredHealth = capture(docker, [
    "run",
    "--rm",
    "--network",
    `${project}_ingress`,
    "caseweaver-e2e-fixtures:production",
    "node",
    "-e",
    "require('node:https').get({host:'edge',port:8443,path:'/health/ready',rejectUnauthorized:false},(response)=>{response.resume();response.on('end',()=>process.exit(response.statusCode===200?0:1))}).on('error',()=>process.exit(1))",
  ]);
  if (restoredHealth.status !== 0) {
    throw new Error("The TLS edge did not report readiness.");
  }
}

async function writeConfiguration() {
  await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
  await mkdir(applicationSecretsDirectory, { recursive: true, mode: 0o700 });

  const postgresPassword = await secretFile("postgres-password");
  const runtimePassword = await secretFile("runtime-database-password");
  const oidcClientSecret = await secretFile("oidc-client-secret");
  const oidcEphemeralKey = await secretFile(
    "oidc-ephemeral-key",
    randomBytes(32).toString("base64url"),
  );
  const adminLogin = await secretFile("admin-login", `operator-${runId}`);
  const adminPassword = await secretFile("admin-password");
  const objectStorageKey = await secretFile("object-storage-key-derivation");
  const objectStorageAccessKey = await secretFile("object-storage-access-key");
  const objectStorageSecret = await secretFile("object-storage-secret");
  const tlsCertificate = path.join(secretDirectory, "tls-certificate.pem");
  const tlsPrivateKey = path.join(secretDirectory, "tls-private-key.pem");
  await createCertificate(tlsCertificate, tlsPrivateKey);
  const postgresPasswordValue = (
    await readFile(postgresPassword, "utf8")
  ).trim();
  const runtimePasswordValue = (await readFile(runtimePassword, "utf8")).trim();
  const migrationUrl = await secretFile(
    "migration-database-url",
    `postgresql://caseweaver_migrator:${encodeURIComponent(postgresPasswordValue)}@postgres:5432/caseweaver`,
  );
  const runtimeUrl = await secretFile(
    "runtime-database-url",
    `postgresql://caseweaver_runtime:${encodeURIComponent(runtimePasswordValue)}@postgres:5432/caseweaver`,
  );
  const origin = `https://caseweaver.test:${httpsPort}`;

  values.set("COMPOSE_PROJECT_NAME", projectName);
  values.set("CASEWEAVER_DEPLOYMENT_TEST_MODE", "true");
  values.set("CASEWEAVER_RELEASE_VERSION", "production-e2e");
  values.set(
    "CASEWEAVER_POSTGRES_IMAGE",
    "pgvector/pgvector:pg17@sha256:7ae6051efd0e60444282c27c7e141af07f322ce033300e727a49c3dd11075e38",
  );
  values.set(
    "CASEWEAVER_MIGRATION_IMAGE",
    "caseweaver-migration:production-e2e",
  );
  values.set("CASEWEAVER_API_IMAGE", "caseweaver-api:production-e2e");
  values.set("CASEWEAVER_ADMIN_IMAGE", "caseweaver-admin:production-e2e");
  values.set("CASEWEAVER_WORKER_IMAGE", "caseweaver-worker:production-e2e");
  values.set(
    "CASEWEAVER_SCHEDULER_IMAGE",
    "caseweaver-scheduler:production-e2e",
  );
  values.set("CASEWEAVER_WEBHOOK_IMAGE", "caseweaver-webhook:production-e2e");
  values.set(
    "CASEWEAVER_STANDALONE_IMAGE",
    "caseweaver-standalone:production-e2e",
  );
  values.set(
    "CASEWEAVER_ATTACHMENT_PROCESSOR_IMAGE",
    "caseweaver-attachment-processor:production-e2e",
  );
  values.set(
    "CASEWEAVER_EDGE_IMAGE",
    "nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0",
  );
  values.set(
    "CASEWEAVER_S3_OPERATIONS_IMAGE",
    "amazon/aws-cli@sha256:1a491b258590cc66866cd550f592edff80082f44daf1d903820daeca2f4954de",
  );
  values.set("ADMIN_ALLOWED_ORIGINS", origin);
  values.set("API_WORKSPACE_ID", "caseweaver-e2e-workspace");
  values.set("API_PRINCIPAL_ID", "caseweaver-e2e-principal");
  values.set("TRUSTED_PROXY_CIDRS", applicationSubnet);
  values.set("CASEWEAVER_APPLICATION_SUBNET", applicationSubnet);
  values.set("CASEWEAVER_EGRESS_SUBNET", egressSubnet);
  values.set("CASEWEAVER_EDGE_HTTP_BINDING", `127.0.0.1:${httpPort}`);
  values.set("CASEWEAVER_EDGE_HTTPS_BINDING", `127.0.0.1:${httpsPort}`);
  values.set("CASEWEAVER_EDGE_PUBLIC_HTTPS_PORT", String(httpsPort));
  values.set("CASEWEAVER_EDGE_API_UPSTREAM", "standalone:3000");
  values.set("CASEWEAVER_EDGE_WEBHOOK_UPSTREAM", "standalone:8081");
  values.set("POSTGRES_DB", "caseweaver");
  values.set("POSTGRES_USER", "caseweaver_migrator");
  values.set("CASEWEAVER_RUNTIME_DATABASE_ROLE", "caseweaver_runtime");
  values.set("ADMIN_DISABLE_LOGIN_AUTHENTICATION", "false");
  values.set("ADMIN_ENABLE_PASSWORD_AUTHENTICATION", "true");
  values.set("OIDC_ISSUER", `https://oidc.caseweaver.test:${oidcPort}/issuer`);
  values.set("OIDC_CLIENT_ID", "caseweaver-production-e2e");
  values.set("OIDC_CALLBACK_URL", `${origin}/v1/auth/callback`);
  values.set("OIDC_EPHEMERAL_KEY_ID", "caseweaver-e2e-key");
  values.set(
    "ADMIN_BOOTSTRAP_OIDC_SUBJECT",
    "caseweaver-e2e-oidc-administrator",
  );
  values.set(
    "ADMIN_BOOTSTRAP_DISPLAY_NAME",
    "CaseWeaver E2E OIDC Administrator",
  );
  values.set("CASEWEAVER_E2E_OIDC_PORT", String(oidcPort));
  values.set("CASEWEAVER_E2E_OIDC_IP", oidcFixtureIp);
  values.set("CASEWEAVER_E2E_OBJECT_STORAGE_IP", `10.251.${subnetSeed}.21`);
  values.set("CASEWEAVER_E2E_OBJECT_STORAGE_VOLUME", objectStorageVolume);
  values.set(
    "CASEWEAVER_E2E_OIDC_FIXTURE_PATH",
    path.join(scriptDirectory, "fixtures", "oidc-provider.mjs"),
  );
  values.set(
    "CASEWEAVER_APPLICATION_SECRETS_DIRECTORY",
    applicationSecretsDirectory,
  );
  values.set("OBJECT_STORAGE_KIND", "s3");
  values.set("OBJECT_STORAGE_BACKEND_ID", "caseweaver-e2e-storage");
  values.set("OBJECT_STORAGE_KEY_PREFIX", "caseweaver-e2e");
  values.set("OBJECT_STORAGE_S3_ENDPOINT", "https://object-store:9000");
  values.set("OBJECT_STORAGE_S3_REGION", "ca-central-1");
  values.set("OBJECT_STORAGE_S3_BUCKET", "caseweaver-e2e-storage");
  values.set("OBJECT_STORAGE_S3_BACKUP_BUCKET", "caseweaver-e2e-backups");
  values.set("OBJECT_STORAGE_S3_BACKUP_PREFIX", "caseweaver-e2e-backups");
  values.set("OBJECT_STORAGE_S3_FORCE_PATH_STYLE", "true");
  values.set("OBJECT_STORAGE_S3_ENCRYPTION", "AES256");
  values.set("CASEWEAVER_POSTGRES_PASSWORD_FILE", postgresPassword);
  values.set("CASEWEAVER_RUNTIME_DATABASE_PASSWORD_FILE", runtimePassword);
  values.set("CASEWEAVER_MIGRATION_DATABASE_URL_FILE", migrationUrl);
  values.set("CASEWEAVER_RUNTIME_DATABASE_URL_FILE", runtimeUrl);
  values.set("CASEWEAVER_OIDC_CLIENT_SECRET_FILE", oidcClientSecret);
  values.set("CASEWEAVER_OIDC_EPHEMERAL_ENCRYPTION_KEY_FILE", oidcEphemeralKey);
  values.set("CASEWEAVER_ADMIN_LOGIN_FILE", adminLogin);
  values.set("CASEWEAVER_ADMIN_PASSWORD_FILE", adminPassword);
  values.set(
    "CASEWEAVER_OBJECT_STORAGE_KEY_DERIVATION_SECRET_FILE",
    objectStorageKey,
  );
  values.set(
    "CASEWEAVER_OBJECT_STORAGE_S3_ACCESS_KEY_ID_FILE",
    objectStorageAccessKey,
  );
  values.set(
    "CASEWEAVER_OBJECT_STORAGE_S3_SECRET_ACCESS_KEY_FILE",
    objectStorageSecret,
  );
  values.set("CASEWEAVER_TRUSTED_CA_FILE", tlsCertificate);
  values.set("CASEWEAVER_TLS_CERTIFICATE_FILE", tlsCertificate);
  values.set("CASEWEAVER_TLS_PRIVATE_KEY_FILE", tlsPrivateKey);
  values.set("CASEWEAVER_E2E_OBJECT_MARKER_FILE", objectMarkerFile);
  await writeFile(objectMarkerFile, `CaseWeaver object recovery ${runId}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeEnvironment(environmentFile);
  return {
    origin,
    adminLogin: (await readFile(adminLogin, "utf8")).trim(),
    adminPassword: (await readFile(adminPassword, "utf8")).trim(),
  };
}

async function buildFixtureImages() {
  run(docker, [
    "build",
    "--file",
    "deploy/docker/Dockerfile",
    "--target",
    "migration",
    "--tag",
    "caseweaver-migration:production-e2e",
    ".",
  ]);
  run(docker, [
    "build",
    "--file",
    "deploy/docker/Dockerfile",
    "--target",
    "attachment-processor",
    "--tag",
    "caseweaver-attachment-processor:production-e2e",
    ".",
  ]);
  run(docker, [
    "build",
    "--file",
    "deploy/docker/Dockerfile",
    "--target",
    "standalone",
    "--tag",
    "caseweaver-standalone:production-e2e",
    ".",
  ]);
  for (const target of ["api", "webhook", "scheduler", "worker"]) {
    run(docker, [
      "build",
      "--file",
      "deploy/docker/Dockerfile",
      "--target",
      target,
      "--tag",
      `caseweaver-${target}:production-e2e`,
      ".",
    ]);
  }
  run(docker, [
    "build",
    "--file",
    "deploy/docker/Dockerfile",
    "--target",
    "admin",
    "--tag",
    "caseweaver-admin:production-e2e",
    ".",
  ]);
  run(docker, [
    "build",
    "--file",
    "tests/e2e/fixtures/Dockerfile",
    "--tag",
    "caseweaver-e2e-fixtures:production",
    "tests/e2e/fixtures",
  ]);
}

function assertReleaseImageHardening() {
  for (const image of releaseImages) {
    const reference = `caseweaver-${image.target}:production-e2e`;
    const inspected = capture(docker, [
      "image",
      "inspect",
      reference,
      "--format",
      "{{json .Config}}",
    ]);
    if (inspected.status !== 0) {
      throw new Error(`The ${image.target} OCI image could not be inspected.`);
    }
    const configuration = JSON.parse(inspected.stdout);
    if (configuration.User !== image.expectedUser) {
      throw new Error(
        `The ${image.target} OCI image does not run as its expected non-root user.`,
      );
    }
    const labels = configuration.Labels;
    if (
      labels?.["org.opencontainers.image.source"] !==
        "https://github.com/caseweaver/caseweaver" ||
      typeof labels["org.opencontainers.image.title"] !== "string" ||
      typeof labels["org.opencontainers.image.version"] !== "string" ||
      typeof labels["org.opencontainers.image.revision"] !== "string"
    ) {
      throw new Error(
        `The ${image.target} OCI image is missing required source metadata labels.`,
      );
    }
    if (image.artifactDirectory === undefined) continue;

    // Runtime image roots must contain deployable artifacts only. Do not inspect
    // third-party dependencies here: they can legitimately package sources, while
    // this test protects against copying the CaseWeaver checkout or an env file into
    // the final stage. The migration target is excluded because checked-in migration
    // history is intentionally its sole application artifact.
    run(docker, [
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      reference,
      "-ec",
      `test ! -d ${image.artifactDirectory}/src && test ! -d ${image.artifactDirectory}/test && test ! -d ${image.artifactDirectory}/tests && test ! -d ${image.artifactDirectory}/coverage && test ! -e ${image.artifactDirectory}/.git && test ! -e ${image.artifactDirectory}/.env`,
    ]);
  }
}

function artifactFingerprint(reference, artifactDirectory) {
  const fingerprint = capture(docker, [
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    reference,
    "-ec",
    `cd ${artifactDirectory} && find . -type f -exec sha256sum {} \\; | LC_ALL=C sort`,
  ]);
  if (fingerprint.status !== 0) {
    throw new Error(`Could not fingerprint ${reference}'s final artifact.`);
  }
  return fingerprint.stdout;
}

function assertDeterministicReleaseArtifacts() {
  // Rebuild the two operator-facing artifacts with their build stages uncached,
  // while retaining the pinned dependency stage. Comparing final payload digests
  // catches non-deterministic compilation without making each PR download and
  // reinstall the locked dependency graph a second time.
  for (const image of [
    { target: "api", artifactDirectory: "/opt/caseweaver/api/dist" },
    { target: "admin", artifactDirectory: "/usr/share/nginx/static" },
  ]) {
    const reference = `caseweaver-${image.target}:production-e2e`;
    const before = artifactFingerprint(reference, image.artifactDirectory);
    run(docker, [
      "build",
      "--file",
      "deploy/docker/Dockerfile",
      "--no-cache-filter",
      `${image.target}-build`,
      "--target",
      image.target,
      "--tag",
      reference,
      ".",
    ]);
    const after = artifactFingerprint(reference, image.artifactDirectory);
    if (before !== after) {
      throw new Error(
        `The ${image.target} final artifact changed across equivalent locked builds.`,
      );
    }
  }
}

function removeLabeledDockerResources(project) {
  const resourceKinds = [
    ["container", ["container", "ls", "--all", "--quiet"]],
    ["network", ["network", "ls", "--quiet"]],
    ["volume", ["volume", "ls", "--quiet"]],
  ];
  for (const [kind, listCommand] of resourceKinds) {
    const listed = capture(docker, [
      ...listCommand,
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ]);
    const identifiers = listed.stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (identifiers.length === 0) continue;
    const removed = capture(docker, [kind, "rm", "-f", ...identifiers]);
    if (removed.status !== 0) {
      // A `compose down` and an operations-profile `run --rm` can race over the
      // same short-lived container. Treat a resource that has disappeared
      // between listing and removal as successful cleanup, but never hide a
      // resource that remains labelled with this isolated project.
      const remaining = capture(docker, [
        ...listCommand,
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ]);
      if (remaining.stdout.trim().length > 0) {
        throw new Error(
          "The isolated production Compose resources could not be removed.",
        );
      }
    }
  }
}

async function removeProject(envFile, project) {
  try {
    await access(envFile);
  } catch {
    removeLabeledDockerResources(project);
    return;
  }
  const result = capture(docker, [
    ...composePrefix(envFile),
    "down",
    "--volumes",
    "--remove-orphans",
    "--timeout",
    "30",
  ]);
  if (result.status !== 0) {
    assertWithoutSecrets(
      `${result.stdout}${result.stderr}`,
      "The Compose cleanup",
    );
  }
  removeLabeledDockerResources(project);
}

try {
  if (!skipImageBuild) await buildFixtureImages();
  assertDeterministicReleaseArtifacts();
  assertReleaseImageHardening();
  const fixture = await writeConfiguration();
  createObjectStorageVolume();
  operationsCommand("validate", "--env-file", environmentFile);
  operationsCommand(
    "migrate",
    "--env-file",
    environmentFile,
    "--mode",
    "standalone",
  );
  compose(
    environmentFile,
    "--profile",
    "standalone",
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "240",
    "--remove-orphans",
  );
  assertOnlyEdgePublishesPorts(environmentFile);
  runtimeRoleCannotCreateTables(environmentFile);
  createObjectStoreBuckets(environmentFile);
  run(
    process.execPath,
    [playwrightCli, "test", "tests/e2e/production-compose.spec.ts"],
    {
      env: {
        ...process.env,
        CASEWEAVER_E2E_PRODUCTION_ORIGIN: fixture.origin,
        CASEWEAVER_E2E_PRODUCTION_HTTP_ORIGIN: `http://caseweaver.test:${httpPort}`,
        CASEWEAVER_E2E_PRODUCTION_LOGIN: fixture.adminLogin,
        CASEWEAVER_E2E_PRODUCTION_PASSWORD: fixture.adminPassword,
      },
    },
  );
  const logs = capture(docker, [
    ...composePrefix(environmentFile),
    "logs",
    "--no-color",
  ]);
  assertWithoutSecrets(
    `${logs.stdout}${logs.stderr}`,
    "The production Compose logs",
  );
  seedObjectMarker(environmentFile);
  assertObjectMarker(environmentFile);
  operationsCommand(
    "backup",
    "--env-file",
    environmentFile,
    "--mode",
    "standalone",
    "--output",
    backupFile,
  );
  deleteObjectMarker(environmentFile);
  await removeProject(environmentFile, projectName);

  const restoreOrigin = `https://caseweaver.test:${restoreHttpsPort}`;
  await writeEnvironment(restoreEnvironmentFile, {
    COMPOSE_PROJECT_NAME: `${projectName}-restore`,
    CASEWEAVER_EDGE_HTTP_BINDING: `127.0.0.1:${restoreHttpPort}`,
    CASEWEAVER_EDGE_HTTPS_BINDING: `127.0.0.1:${restoreHttpsPort}`,
    CASEWEAVER_EDGE_PUBLIC_HTTPS_PORT: String(restoreHttpsPort),
    ADMIN_ALLOWED_ORIGINS: restoreOrigin,
    OIDC_CALLBACK_URL: `${restoreOrigin}/v1/auth/callback`,
  });
  compose(restoreEnvironmentFile, "up", "--detach", "--wait", "object-store");
  operationsCommand(
    "restore",
    "--env-file",
    restoreEnvironmentFile,
    "--mode",
    "standalone",
    "--input",
    backupFile,
  );
  operationsCommand(
    "start",
    "--env-file",
    restoreEnvironmentFile,
    "--mode",
    "standalone",
  );
  assertTlsReadiness(`${projectName}-restore`);
  assertObjectMarker(restoreEnvironmentFile);
  auditRowsExist(restoreEnvironmentFile);
  await removeProject(restoreEnvironmentFile, `${projectName}-restore`);

  const distributedProject = `${projectName}-distributed`;
  const distributedOrigin = `https://caseweaver.test:${restoreHttpsPort + 2}`;
  await writeEnvironment(distributedEnvironmentFile, {
    COMPOSE_PROJECT_NAME: distributedProject,
    CASEWEAVER_EDGE_HTTP_BINDING: `127.0.0.1:${restoreHttpPort + 2}`,
    CASEWEAVER_EDGE_HTTPS_BINDING: `127.0.0.1:${restoreHttpsPort + 2}`,
    CASEWEAVER_EDGE_PUBLIC_HTTPS_PORT: String(restoreHttpsPort + 2),
    ADMIN_ALLOWED_ORIGINS: distributedOrigin,
    OIDC_CALLBACK_URL: `${distributedOrigin}/v1/auth/callback`,
    CASEWEAVER_EDGE_API_UPSTREAM: "api:3000",
    CASEWEAVER_EDGE_WEBHOOK_UPSTREAM: "webhook:8081",
  });
  operationsCommand(
    "migrate",
    "--env-file",
    distributedEnvironmentFile,
    "--mode",
    "distributed",
  );
  operationsCommand(
    "start",
    "--env-file",
    distributedEnvironmentFile,
    "--mode",
    "distributed",
  );
  assertOnlyEdgePublishesPorts(distributedEnvironmentFile);
  assertTlsReadiness(distributedProject);
  await removeProject(distributedEnvironmentFile, distributedProject);
  console.log(
    "Production Compose TLS, authentication, role isolation, backup/restore, and both runtime modes passed.",
  );
} finally {
  if (!keepStack) {
    try {
      await removeProject(environmentFile, projectName);
      await removeProject(restoreEnvironmentFile, `${projectName}-restore`);
      await removeProject(
        distributedEnvironmentFile,
        `${projectName}-distributed`,
      );
      removeObjectStorageVolume();
    } catch (error) {
      console.error(
        error instanceof Error
          ? error.message
          : "The isolated production Compose cleanup failed.",
      );
      if (process.exitCode === undefined || process.exitCode === 0)
        process.exitCode = 1;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
