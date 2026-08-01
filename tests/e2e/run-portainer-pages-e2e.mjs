import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const portainerCompose = path.join(
  repositoryRoot,
  "deploy",
  "docker",
  "compose.portainer.yml",
);
const overlayCompose = path.join(scriptDirectory, "compose.portainer.e2e.yml");
const fixtureDirectory = path.join(scriptDirectory, "fixtures");
const keepStack = process.env.CASEWEAVER_E2E_KEEP_STACK === "true";
const skipImageBuild = process.env.CASEWEAVER_E2E_SKIP_IMAGE_BUILD === "true";
const runId = `${process.pid}-${randomBytes(4).toString("hex")}`;
const projectName = `caseweaver-portainer-pages-e2e-${runId}`;
const portOffset =
  Number.parseInt(runId.slice(0, runId.indexOf("-")), 10) % 1_000;
const apiHttpPort = 24_000 + portOffset;
const apiHttpsPort = 25_000 + portOffset;
const pagesHttpsPort = 26_000 + portOffset;
const oidcPort = 27_000 + portOffset;
const subnetSeed = 20 + (randomBytes(1)[0] % 200);
const applicationSubnet = `10.252.${subnetSeed}.0/24`;
const egressSubnet = `10.253.${subnetSeed}.0/24`;
const oidcFixtureIp = `10.253.${subnetSeed}.20`;
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "caseweaver-portainer-pages-e2e-"),
);
const secretDirectory = path.join(temporaryDirectory, "secrets");
const applicationSecretsDirectory = path.join(
  temporaryDirectory,
  "application-secrets",
);
const environmentFile = path.join(temporaryDirectory, "portainer.env");
const values = new Map();
const secretValues = [];

function run(executable, argumentsList, options = {}) {
  const result = spawnSync(executable, argumentsList, {
    cwd: repositoryRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error("An isolated Portainer/Pages Compose command failed.");
}

function capture(executable, argumentsList, options = {}) {
  return spawnSync(executable, argumentsList, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    ...options,
  });
}

function composePrefix() {
  return [
    "compose",
    "--env-file",
    environmentFile,
    "--file",
    portainerCompose,
    "--file",
    overlayCompose,
  ];
}

function compose(...argumentsList) {
  run(docker, [...composePrefix(), ...argumentsList]);
}

function randomSecret() {
  return randomBytes(32).toString("base64url");
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
  run(docker, [
    "run",
    "--rm",
    "--volume",
    `${secretDirectory}:/out`,
    "caseweaver-e2e-fixtures:portainer-e2e",
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "/out/tls-private-key.pem",
    "-out",
    "/out/tls-certificate.pem",
    "-days",
    "1",
    "-subj",
    "/CN=api.caseweaver.test",
    "-addext",
    "subjectAltName=DNS:api.caseweaver.test,DNS:console.pages.test,DNS:attacker.pages.test,DNS:oidc.caseweaver.test,IP:127.0.0.1",
  ]);
  await Promise.all([
    readFile(certificate, "utf8"),
    readFile(privateKey, "utf8"),
  ]);
}

function assertWithoutSecrets(output, context) {
  for (const secret of secretValues) {
    if (output.includes(secret)) {
      throw new Error(`${context} disclosed an isolated test secret.`);
    }
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
  const adminLogin = await secretFile("admin-login", "");
  const adminPassword = await secretFile("admin-password", "");
  const objectStorageKey = await secretFile("object-storage-key-derivation");
  const objectStorageAccessKey = await secretFile("object-storage-access-key");
  const objectStorageSecret = await secretFile("object-storage-secret");
  const certificate = path.join(secretDirectory, "tls-certificate.pem");
  const privateKey = path.join(secretDirectory, "tls-private-key.pem");
  await createCertificate(certificate, privateKey);

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
  const apiOrigin = `https://api.caseweaver.test:${apiHttpsPort}`;
  const consoleOrigin = `https://console.pages.test:${pagesHttpsPort}`;

  values.set("COMPOSE_PROJECT_NAME", projectName);
  values.set("CASEWEAVER_RELEASE_VERSION", "portainer-pages-e2e");
  values.set(
    "CASEWEAVER_POSTGRES_IMAGE",
    "pgvector/pgvector:pg17@sha256:7ae6051efd0e60444282c27c7e141af07f322ce033300e727a49c3dd11075e38",
  );
  values.set(
    "CASEWEAVER_MIGRATION_IMAGE",
    "caseweaver-migration:portainer-e2e",
  );
  values.set(
    "CASEWEAVER_STANDALONE_IMAGE",
    "caseweaver-standalone:portainer-e2e",
  );
  values.set(
    "CASEWEAVER_ATTACHMENT_PROCESSOR_IMAGE",
    "caseweaver-attachment-processor:portainer-e2e",
  );
  values.set("CASEWEAVER_ADMIN_IMAGE", "caseweaver-admin:portainer-e2e");
  values.set(
    "CASEWEAVER_EDGE_IMAGE",
    "nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0",
  );
  values.set(
    "CASEWEAVER_S3_OPERATIONS_IMAGE",
    "amazon/aws-cli@sha256:1a491b258590cc66866cd550f592edff80082f44daf1d903820daeca2f4954de",
  );
  values.set("ADMIN_ALLOWED_ORIGINS", consoleOrigin);
  values.set("ADMIN_SESSION_COOKIE_SAME_SITE", "none");
  values.set("API_WORKSPACE_ID", "portainer-e2e-workspace");
  values.set("API_PRINCIPAL_ID", "portainer-e2e-principal");
  values.set("TRUSTED_PROXY_CIDRS", applicationSubnet);
  values.set("CASEWEAVER_APPLICATION_SUBNET", applicationSubnet);
  values.set("CASEWEAVER_EGRESS_SUBNET", egressSubnet);
  values.set("CASEWEAVER_EDGE_HTTP_BINDING", `127.0.0.1:${apiHttpPort}`);
  values.set("CASEWEAVER_EDGE_HTTPS_BINDING", `127.0.0.1:${apiHttpsPort}`);
  values.set("CASEWEAVER_EDGE_PUBLIC_HTTPS_PORT", String(apiHttpsPort));
  values.set("POSTGRES_DB", "caseweaver");
  values.set("POSTGRES_USER", "caseweaver_migrator");
  values.set("CASEWEAVER_RUNTIME_DATABASE_ROLE", "caseweaver_runtime");
  values.set("ADMIN_DISABLE_LOGIN_AUTHENTICATION", "true");
  values.set("ADMIN_ENABLE_PASSWORD_AUTHENTICATION", "false");
  values.set("OIDC_ISSUER", `https://oidc.caseweaver.test:${oidcPort}/issuer`);
  values.set("OIDC_CLIENT_ID", "caseweaver-portainer-e2e");
  values.set("OIDC_CALLBACK_URL", `${apiOrigin}/v1/auth/callback`);
  values.set("OIDC_EPHEMERAL_KEY_ID", "portainer-e2e-key");
  values.set(
    "ADMIN_BOOTSTRAP_OIDC_SUBJECT",
    "caseweaver-e2e-oidc-administrator",
  );
  values.set(
    "ADMIN_BOOTSTRAP_DISPLAY_NAME",
    "CaseWeaver E2E OIDC Administrator",
  );
  values.set("OBJECT_STORAGE_BACKEND_ID", "portainer-e2e-storage");
  values.set("OBJECT_STORAGE_KEY_PREFIX", "portainer-e2e");
  values.set("OBJECT_STORAGE_S3_ENDPOINT", "https://object-store.invalid:9000");
  values.set("OBJECT_STORAGE_S3_REGION", "ca-central-1");
  values.set("OBJECT_STORAGE_S3_BUCKET", "portainer-e2e-storage");
  values.set("OBJECT_STORAGE_S3_FORCE_PATH_STYLE", "true");
  values.set("OBJECT_STORAGE_S3_ENCRYPTION", "AES256");
  values.set(
    "CASEWEAVER_APPLICATION_SECRETS_DIRECTORY",
    applicationSecretsDirectory,
  );
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
  values.set("CASEWEAVER_TRUSTED_CA_FILE", certificate);
  values.set("CASEWEAVER_TLS_CERTIFICATE_FILE", certificate);
  values.set("CASEWEAVER_TLS_PRIVATE_KEY_FILE", privateKey);
  values.set("CASEWEAVER_E2E_OIDC_PORT", String(oidcPort));
  values.set("CASEWEAVER_E2E_OIDC_IP", oidcFixtureIp);
  values.set("CASEWEAVER_E2E_API_ORIGIN", apiOrigin);
  values.set("CASEWEAVER_E2E_PAGES_HTTPS_PORT", String(pagesHttpsPort));
  values.set(
    "CASEWEAVER_E2E_PAGES_NGINX_CONFIG",
    path.join(fixtureDirectory, "external-admin-nginx.conf"),
  );
  values.set(
    "CASEWEAVER_E2E_OIDC_FIXTURE_PATH",
    path.join(fixtureDirectory, "oidc-provider.mjs"),
  );
  await writeFile(
    environmentFile,
    `${[...values.entries()].map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return { apiOrigin, consoleOrigin };
}

function buildImages() {
  for (const target of [
    "migration",
    "attachment-processor",
    "standalone",
    "admin",
  ]) {
    run(docker, [
      "build",
      "--file",
      "deploy/docker/Dockerfile",
      "--target",
      target,
      "--tag",
      `caseweaver-${target}:portainer-e2e`,
      ".",
    ]);
  }
  run(docker, [
    "build",
    "--file",
    "tests/e2e/fixtures/Dockerfile",
    "--tag",
    "caseweaver-e2e-fixtures:portainer-e2e",
    "tests/e2e/fixtures",
  ]);
}

function assertOnlyTestEdgesPublishPorts() {
  const result = capture(docker, [
    ...composePrefix(),
    "ps",
    "--format",
    "json",
  ]);
  if (result.status !== 0)
    throw new Error("Could not inspect the Portainer test stack.");
  const services = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const published = services
    .filter(
      (service) =>
        Array.isArray(service.Publishers) &&
        service.Publishers.some(
          (publisher) =>
            publisher !== null &&
            typeof publisher === "object" &&
            "PublishedPort" in publisher &&
            typeof publisher.PublishedPort === "number" &&
            publisher.PublishedPort > 0,
        ),
    )
    .map((service) => service.Service)
    .sort();
  if (
    JSON.stringify(published) !==
    JSON.stringify(["edge", "oidc-provider", "pages-edge"])
  ) {
    throw new Error(
      "The Portainer test stack published an unexpected service port.",
    );
  }
}

async function cleanup() {
  const result = capture(docker, [
    ...composePrefix(),
    "down",
    "--volumes",
    "--remove-orphans",
    "--timeout",
    "30",
  ]);
  if (result.status !== 0) {
    assertWithoutSecrets(
      `${result.stdout}${result.stderr}`,
      "Portainer test cleanup",
    );
    throw new Error("The Portainer test stack could not be removed.");
  }
}

try {
  if (!skipImageBuild) buildImages();
  const topology = await writeConfiguration();
  compose(
    "--profile",
    "migrate",
    "up",
    "--abort-on-container-exit",
    "--exit-code-from",
    "grant-runtime",
    "grant-runtime",
  );
  compose(
    "--profile",
    "standalone",
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "240",
    "--remove-orphans",
  );
  assertOnlyTestEdgesPublishPorts();
  run(
    process.execPath,
    [playwrightCli, "test", "tests/e2e/portainer-pages.spec.ts"],
    {
      env: {
        ...process.env,
        CASEWEAVER_E2E_PORTAINER_API_ORIGIN: topology.apiOrigin,
        CASEWEAVER_E2E_PORTAINER_CONSOLE_ORIGIN: topology.consoleOrigin,
        CASEWEAVER_E2E_PORTAINER_ATTACKER_ORIGIN: `https://attacker.pages.test:${pagesHttpsPort}`,
      },
    },
  );
  const logs = capture(docker, [...composePrefix(), "logs", "--no-color"]);
  assertWithoutSecrets(`${logs.stdout}${logs.stderr}`, "Portainer test logs");
  console.log(
    "Portainer backend and separately hosted Admin OIDC journey passed.",
  );
} finally {
  if (!keepStack) {
    try {
      await cleanup();
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
