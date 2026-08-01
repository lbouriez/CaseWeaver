import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const composeFile = resolve(
  repositoryRoot,
  "deploy/docker/compose.portainer.yml",
);
const edgeMaterialImage =
  "nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0";
const digest = (name, fill) =>
  `registry.example.invalid/caseweaver-${name}@sha256:${fill.repeat(64)}`;

function renderPortainerStack() {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "caseweaver-portainer-contract-"),
  );
  const secretFile = join(temporaryDirectory, "secret");
  const applicationSecrets = join(temporaryDirectory, "application-secrets");
  writeFileSync(secretFile, "contract-only-value\n", { mode: 0o600 });
  // Compose only needs this explicit absolute host path to render the bind mount.
  // The stack itself receives its application secrets from deployment-owned files.
  const environment = {
    ...process.env,
    CASEWEAVER_RELEASE_VERSION: "contract",
    CASEWEAVER_POSTGRES_IMAGE: digest("postgres", "a"),
    CASEWEAVER_MIGRATION_IMAGE: digest("migration", "b"),
    CASEWEAVER_STANDALONE_IMAGE: digest("standalone", "c"),
    CASEWEAVER_ATTACHMENT_PROCESSOR_IMAGE: digest("attachment-processor", "d"),
    CASEWEAVER_EDGE_IMAGE: digest("edge", "e"),
    CASEWEAVER_S3_OPERATIONS_IMAGE: digest("s3-operations", "f"),
    ADMIN_ALLOWED_ORIGINS: "https://caseweaver-admin.pages.dev",
    ADMIN_SESSION_COOKIE_SAME_SITE: "none",
    API_WORKSPACE_ID: "contract-workspace",
    API_PRINCIPAL_ID: "contract-principal",
    TRUSTED_PROXY_CIDRS: "172.31.0.0/24",
    CASEWEAVER_EDGE_HTTP_BINDING: "8088",
    CASEWEAVER_EDGE_HTTPS_BINDING: "8448",
    CASEWEAVER_EDGE_PUBLIC_HTTPS_PORT: "8448",
    OBJECT_STORAGE_BACKEND_ID: "contract-store",
    OBJECT_STORAGE_S3_ENDPOINT: "https://objects.example.test",
    OBJECT_STORAGE_S3_REGION: "ca-central-1",
    OBJECT_STORAGE_S3_BUCKET: "caseweaver-contract",
    CASEWEAVER_APPLICATION_SECRETS_DIRECTORY: applicationSecrets,
    CASEWEAVER_POSTGRES_PASSWORD_FILE: secretFile,
    CASEWEAVER_RUNTIME_DATABASE_PASSWORD_FILE: secretFile,
    CASEWEAVER_MIGRATION_DATABASE_URL_FILE: secretFile,
    CASEWEAVER_RUNTIME_DATABASE_URL_FILE: secretFile,
    CASEWEAVER_OIDC_CLIENT_SECRET_FILE: secretFile,
    CASEWEAVER_OIDC_EPHEMERAL_ENCRYPTION_KEY_FILE: secretFile,
    CASEWEAVER_ADMIN_LOGIN_FILE: secretFile,
    CASEWEAVER_ADMIN_PASSWORD_FILE: secretFile,
    CASEWEAVER_OBJECT_STORAGE_KEY_DERIVATION_SECRET_FILE: secretFile,
    CASEWEAVER_OBJECT_STORAGE_S3_ACCESS_KEY_ID_FILE: secretFile,
    CASEWEAVER_OBJECT_STORAGE_S3_SECRET_ACCESS_KEY_FILE: secretFile,
    CASEWEAVER_TRUSTED_CA_FILE: secretFile,
    CASEWEAVER_TLS_CERTIFICATE_FILE: secretFile,
    CASEWEAVER_TLS_PRIVATE_KEY_FILE: secretFile,
  };

  try {
    const validation = spawnSync(
      "docker",
      [
        "compose",
        "-f",
        composeFile,
        "--profile",
        "migrate",
        "--profile",
        "standalone",
        "config",
        "-q",
      ],
      { cwd: repositoryRoot, encoding: "utf8", env: environment },
    );
    assert.equal(
      validation.status,
      0,
      `Portainer Compose validation failed: ${validation.stderr}`,
    );

    const rendered = spawnSync(
      "docker",
      [
        "compose",
        "-f",
        composeFile,
        "--profile",
        "migrate",
        "--profile",
        "standalone",
        "config",
        "--format",
        "json",
      ],
      { cwd: repositoryRoot, encoding: "utf8", env: environment },
    );
    assert.equal(
      rendered.status,
      0,
      `Portainer Compose rendering failed: ${rendered.stderr}`,
    );
    return JSON.parse(rendered.stdout);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

test("Portainer backend stack is source-free, digest-only, and exposes only its TLS edge", () => {
  const stack = renderPortainerStack();
  const services = stack.services;

  assert.ok(services.postgres);
  assert.ok(services.standalone);
  assert.ok(services.edge);
  assert.equal(services.admin, undefined);
  assert.equal(services.frontend, undefined);

  for (const [name, service] of Object.entries(services)) {
    assert.equal(
      service.build,
      undefined,
      `${name} must not build from source.`,
    );
    assert.match(
      service.image,
      /@sha256:[a-f0-9]{64}$/,
      `${name} must use an immutable image digest.`,
    );
    if (name !== "edge") {
      assert.equal(
        service.ports,
        undefined,
        `${name} must not publish a host port.`,
      );
    }
  }

  assert.equal(services.edge.ports.length, 2);
  assert.deepEqual(
    services.edge.ports
      .map((port) => port.target)
      .sort((left, right) => left - right),
    [8080, 8443],
  );
  assert.equal(services.postgres.ports, undefined);
  assert.deepEqual(services.postgres.volumes, [
    {
      type: "volume",
      source: "caseweaver_portainer_postgres_data",
      target: "/var/lib/postgresql/data",
      volume: {},
    },
  ]);
  assert.equal(
    stack.volumes.caseweaver_portainer_postgres_data.name,
    "caseweaver-portainer_caseweaver_portainer_postgres_data",
  );
  assert.equal(
    services.standalone.environment.ADMIN_ALLOWED_ORIGINS,
    "https://caseweaver-admin.pages.dev",
  );
  assert.equal(
    services.standalone.environment.ADMIN_SESSION_COOKIE_SAME_SITE,
    "none",
  );
  assert.equal(services["edge-material"].network_mode, "none");
  assert.match(
    services["runtime-role-bootstrap"].command.join("\n"),
    /CREATE EXTENSION IF NOT EXISTS vector/,
  );
  assert.match(services.postgres.healthcheck.test.join(" "), /pg_isready/);
  assert.doesNotMatch(
    services.postgres.healthcheck.test.join(" "),
    /pg_extension/,
  );
  assert.equal(
    services.edge.volumes.some((volume) => volume.type === "bind"),
    false,
  );
  assert.equal(
    services.standalone.volumes.some((volume) => volume.type === "bind"),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(stack),
    /"build"\s*:|"context"\s*:|"dockerfile"\s*:/,
  );
});

test("Portainer edge-material renders Nginx variables once and rejects UI routes", () => {
  const stack = renderPortainerStack();
  const command = stack.services["edge-material"].command.join("\n");

  assert.match(
    command,
    /return 308 https:\/\/__CASEWEAVER_NGINX_DOLLAR__host:8448__CASEWEAVER_NGINX_DOLLAR__request_uri/,
  );
  assert.match(
    command,
    /set __CASEWEAVER_NGINX_DOLLAR__api_upstream standalone:3000/,
  );
  assert.match(
    command,
    /set __CASEWEAVER_NGINX_DOLLAR__webhook_upstream standalone:8081/,
  );
  assert.match(command, /location \/ \{\n\s+return 404;/);
  assert.doesNotMatch(
    command,
    /\$\$host|\$\$api_upstream|\$\$webhook_upstream/,
  );

  const template = command.match(
    /cat > \/run\/caseweaver-edge\/default\.conf <<'NGINX'\n([\s\S]*?)\nNGINX/,
  )?.[1];
  assert.ok(
    template,
    "The material service must contain a fixed Nginx template.",
  );

  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "caseweaver-portainer-nginx-"),
  );
  const generatedConfig = join(temporaryDirectory, "default.conf");
  writeFileSync(generatedConfig, template, { mode: 0o600 });
  try {
    const shell = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "-v",
        `${temporaryDirectory}:/work`,
        "--entrypoint",
        "sh",
        edgeMaterialImage,
        "-ec",
        "sed -i 's/__CASEWEAVER_NGINX_DOLLAR__/$/g' /work/default.conf && cat /work/default.conf",
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      shell.status,
      0,
      `The edge material shell rendering failed: ${shell.stderr}`,
    );
    assert.match(shell.stdout, /return 308 https:\/\/\$host:8448\$request_uri/);
    assert.match(shell.stdout, /set \$api_upstream standalone:3000/);
    assert.match(shell.stdout, /proxy_pass http:\/\/\$webhook_upstream/);
    assert.doesNotMatch(shell.stdout, /__CASEWEAVER_NGINX_DOLLAR__|\$\$host/);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});
