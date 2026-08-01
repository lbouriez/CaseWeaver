# Docker delivery

There is one supported **minimum-interaction evaluation stack**:

```powershell
docker compose -f deploy\docker\compose.local.yml up --build --wait
```

It starts a disposable PostgreSQL/pgvector database, applies Prisma and pg-boss
migrations, then keeps only three services running: PostgreSQL, one standalone backend,
and the Admin frontend. The standalone process hosts the API, webhook ingress, scheduler,
durable worker, and outbox relay as reusable modules; it does not make a direct in-memory
dispatch path. Open `http://localhost:8080` or `http://127.0.0.1:8080`; sign in as
`admin` / `admin`. The local runtime config uses the frontend's exact same origin, so
both loopback forms work without a CORS preflight; the disposable API allow-list contains
only those two exact loopback origins. Those credentials exist only because this Compose
file is a loopback-only development/test stack (`NODE_ENV=development`). Stop and remove
its data with:

```powershell
docker compose -f deploy\docker\compose.local.yml down -v
```

The frontend is the only published local port. Its internal Nginx configuration routes
`/v1/` and `/health/` to the backend API, `/webhooks/` to the backend's webhook module,
and all other requests to the static Admin UI. Verify the running stack without exposing
database or backend ports:

```powershell
curl.exe --fail http://localhost:8080/health/live
curl.exe --fail http://localhost:8080/health/ready
curl.exe --fail http://localhost:8080/runtime-config.json
```

Use local environment overrides only when you need to test a different development
administrator. Never expose this stack or retain its database/derived key material:

```powershell
$env:ADMIN_LOGIN = "operator"
$env:ADMIN_PASSWORD = "change-this-before-sharing-the-ui"
docker compose -f deploy\docker\compose.local.yml up --build --wait
```

### Local Docusaurus knowledge-source evaluation

The base stack intentionally does not assume any contributor's workstation paths. To
make one local Git/Docusaurus repository available for a real connector test and durable
synchronization, use the read-only documentation overlay. The supplied host directory
must be the Git worktree root (it must contain `.git`), not a Docusaurus subfolder. The
overlay mounts it only into the standalone backend at
`/mnt/caseweaver/repositories/documentation`; the Admin browser never receives the host
path or the mount.

The provider credential is server-only. It is forwarded to the API and worker, but Admin
must receive only the opaque reference `env:CASEWEAVER_OPENROUTER_KEY`, never its value.

```powershell
$env:CASEWEAVER_DOCUMENTATION_REPOSITORY = "C:/GIT/Documentation"
$env:CASEWEAVER_OPENROUTER_KEY = "<your OpenRouter key>"
docker compose -f deploy\docker\compose.local.yml -f deploy\docker\compose.local.documentation.yml up --build --wait
```

In Admin, configure the Git/Markdown connector with local repository
`/mnt/caseweaver/repositories/documentation`, allowed local root
`/mnt/caseweaver/repositories`, and the desired branch/tag. For the Cloud Docusaurus
site under that worktree, use one exact repository-relative document for the first
metered smoke test, for example
`Cloud/docs/AllAnswered/development/pages/automation/automation-test-knowledge-base/autoit.md`.
The wider `Cloud/docs/**/*.md` and `Cloud/docs/**/*.mdx` patterns are a full import of
roughly 1,600 current documents, not a bounded first run. Configure and activate the
OpenAI-compatible provider with `env:CASEWEAVER_OPENROUTER_KEY`, then use **Refresh
models available from provider**. That server-owned request, not LiteLLM, determines
which models can be bound to this endpoint. Refreshing the trusted catalog is optional
price enrichment; an unmatched model needs an explicit non-zero override before a hard
budget can permit a capability test. Create an active embedding binding, hard budget,
collection, connector instance, and enabled knowledge source. The **Synchronize** action
on that source queues the real worker run. Start with one exact path to bound first-run
cost, then widen the source through a reviewed successor configuration when ready.

## Why there are several Compose files

| File | One job | What it starts |
| --- | --- | --- |
| `compose.local.yml` | The complete disposable local evaluation stack. | Three persistent services: database, standalone backend, and Admin frontend; Prisma/queue migrations are short-lived setup jobs. |
| `compose.e2e.yml` | A private deterministic acceptance overlay. | A temporary HTTPS OpenAI-compatible fixture and a seeded Git repository, layered over `compose.local.yml` only by `pnpm test:e2e:compose`. |
| `compose.test.yml` | Dependency-only integration-test database. | PostgreSQL/pgvector at port `54329`; applications run on the host test runner. |
| `compose.admin.yml` | Static UI bridge for an API already hosted elsewhere. | Admin image only; it has no access to a database, queue, secrets, connectors, or providers. |
| `compose.production.yml` | Operator topology using already-published, digest-pinned images. | PostgreSQL, one public TLS edge, static Admin, encrypted S3-compatible storage, and exactly one of the standalone or distributed runtime profiles. |
| `compose.portainer.yml` | Docker Standalone backend for an externally hosted Admin. | PostgreSQL, one standalone backend, a no-network attachment processor, explicit migration jobs, and an API-only TLS edge. The Console is published separately to Cloudflare Pages. |

Only `compose.local.yml` is the simple “start the whole project” command. The other
files are not alternatives to it.

## Portainer backend with Cloudflare Pages Admin

`compose.portainer.yml` is the external-hosting alternative to the embedded Admin
topology. It is for a **Docker Standalone** Portainer endpoint, not Swarm: it consumes
prebuilt `image@sha256:...` releases, does not run a Docker build, does not bind the
repository checkout, and never starts an Admin/frontend service. PostgreSQL has one
durable named volume and no host port. The runtime stores objects in the configured
external S3-compatible service; it does not replace that service with a local test
container.

Copy [`.env.portainer.example`](.env.portainer.example) to an operator-owned location
outside the checkout. In Portainer, paste/upload `compose.portainer.yml` as the stack
definition and enter the same public values as stack environment variables. Every
`CASEWEAVER_*_FILE` path and `CASEWEAVER_APPLICATION_SECRETS_DIRECTORY` must be an
absolute path available to the Docker Standalone node. They are host-owned secret files,
not Git files or Portainer UI text values. Disabled optional features still use an empty,
restricted file to retain the fixed Docker secret contract.

Set these cross-origin values together before the first migration:

- `ADMIN_ALLOWED_ORIGINS=https://<your-admin-project>.pages.dev` — one exact Pages
  origin; never a wildcard or a preview URL.
- `ADMIN_SESSION_COOKIE_SAME_SITE=none` — the separately hosted HTTPS Console needs a
  `Secure; HttpOnly; SameSite=None` API cookie. Same-origin embedded deployments retain
  their default `lax` setting.
- `OIDC_CALLBACK_URL=https://<your-api-host>/v1/auth/callback` — the API remains the
  Authorization Code + PKCE callback endpoint; this is not a Pages URL.
- `TRUSTED_PROXY_CIDRS=172.31.0.0/24` (or your chosen fixed `application` subnet) —
  only the internal API-only edge may supply forwarding headers.

The stack's root/no-network `edge-material` service copies certificate/key secret files
and generates the fixed Nginx configuration inside a private tmpfs. The non-root edge
then exposes only `/v1/`, `/health/`, and `/webhooks/`; `/` returns `404`, so it cannot
accidentally masquerade as the Pages Console. It is safe to use a normal HTTPS API
hostname behind that edge; do not proxy the Pages application through it.

Run the migration chain once for a new release, then start the standalone profile. The
following commands are also a useful Docker Standalone preflight before creating the
Portainer stack:

```powershell
$envFile = 'C:\CaseWeaver\portainer\caseweaver-portainer.env'
docker compose --env-file $envFile -f deploy\docker\compose.portainer.yml --profile migrate up --abort-on-container-exit grant-runtime
if ($LASTEXITCODE -ne 0) { throw 'CaseWeaver migration/grant sequence failed.' }
docker compose --env-file $envFile -f deploy\docker\compose.portainer.yml --profile standalone up -d --wait
curl.exe --fail https://api.caseweaver.example/health/live
curl.exe --fail https://api.caseweaver.example/health/ready
```

For certificate renewal, recreate `edge-material` and then `edge`; it stages a fresh
in-memory copy and the public edge never receives a host private-key bind mount. Keep
the runtime stopped during the existing PostgreSQL/S3 backup and restore procedure—the
Portainer stack preserves the PBI-017 data/recovery boundary but intentionally does not
add a second operational helper implementation.

The corresponding Admin Cloudflare Pages artifact is generated by
`apps/admin/scripts/write-pages-runtime-config.mjs`. Configure the dedicated GitHub
workflow variables `CASEWEAVER_ADMIN_PAGES_API_ORIGIN`,
`CASEWEAVER_ADMIN_PAGES_ACCOUNT_ID`, and `CASEWEAVER_ADMIN_PAGES_PROJECT`, plus the
protected-environment secret `CASEWEAVER_ADMIN_PAGES_API_TOKEN`. See
[`.github/README.md`](../../.github/README.md#admin-console--verified-cloudflare-pages-artifact)
for the publish boundary. The API's exact allowed Pages origin must match the project
that workflow publishes; dynamic pull-request Pages previews are intentionally absent.

## Automated Compose acceptance

Run the fully isolated provider-onboarding and knowledge-ingestion acceptance journey:

```powershell
pnpm test:e2e:compose
```

The runner assigns a unique Compose project and uses port `18080` by default (override
with `CASEWEAVER_E2E_PORT`). It starts the local topology plus the test-only overlay,
generates an ephemeral private CA/server certificate inside a disposable Docker volume,
and configures standalone-backend trust only for that fixture CA. The fixture exposes
one authenticated OpenAI-compatible embedding model and the runner seeds one local Git
repository volume. Playwright completes the Admin workflow and the runner then verifies
the durable knowledge document and embedding allocation before removing every test
container and volume. It does not call OpenRouter, use a user credential, or publish a
port other than the temporary loopback frontend.

For failure diagnosis only, set `CASEWEAVER_E2E_KEEP_STACK=true`; the runner prints the
unique project name in Docker output. Do not use this file as an operator deployment or
combine it with production Compose.

## Images and local topology

`Dockerfile` produces eight non-root final targets:

- `migration`: versioned Prisma migration runner, separate from the API image.
- `api`: cookie-session administration/control-plane API.
- `admin`: static React-Admin console and public runtime-config generator only.
- `worker`: durable queue worker and outbox relay.
- `scheduler`: durable knowledge and analysis schedule producer.
- `webhook`: verified public webhook ingress.
- `standalone`: the same API, worker, scheduler, and webhook semantics in one process.
- `attachment-processor`: the no-network Unix-socket sidecar that performs bounded
  archive and text preparation for enabled attachment policies.

All runtime images use digest-pinned base images and OCI source/version/revision labels.
The Admin image contains neither Node, database libraries, connector/provider code,
OIDC credentials, nor application secrets.

The local Compose file builds the migration, standalone, and Admin targets from the
checked-out source. It runs real Prisma migrations followed by the pg-boss queue
migration before the backend starts. It is therefore suitable for exercising the actual
UI/API/worker boundary, but is not a production deployment.

The API, worker, and standalone images include the Git CLI because the Git/Markdown
connector's optional server-side `connector.test` and runtime repository adapter need
it. The browser never executes Git or receives repository credentials; the container
check is bounded and returns only a safe status through the API.

## Published-image production topology

PBI-017 supports a small, self-hosted **linux/amd64** installation. It is deliberately
different from the disposable local stack: every application image is an OCI digest,
only the TLS edge publishes ports, migrations are explicit, and the database/runtime
roles are separate. Read the [production threat model](THREAT_MODEL.md) before exposing
the edge to a network.

The `v*` release workflow publishes these eight targets to the registry selected by the
repository variable (GitHub Container Registry is merely the default):

```text
${CASEWEAVER_CONTAINER_REGISTRY:-ghcr.io}/${owner}/caseweaver-{migration,api,admin,worker,scheduler,webhook,standalone,attachment-processor}
```

The release record contains the exact `image@sha256:...` reference for every target.
A tag is only a convenient discovery label; it is never a production deployment input.
The release pipeline builds only linux/amd64, scans the final image and its generated
SPDX SBOM for HIGH/CRITICAL findings, attaches GitHub provenance and SBOM attestations,
pulls the published digest in a clean job, verifies both attestations from the OCI
registry, then creates the release record. There is no unreviewed vulnerability-ignore
file or severity exception in this initial policy.

### Prepare an operator directory

Keep production configuration and secret files outside the checkout. Copy
`.env.production.example` to an operator-owned location, fill only its public values,
and use the release record's digest for **every** `CASEWEAVER_*_IMAGE` setting. Its
`CASEWEAVER_S3_OPERATIONS_IMAGE` value is the pinned generic S3 client used only during
an explicit backup or restore.

```powershell
$operator = 'C:\CaseWeaver\production'
New-Item -ItemType Directory -Force -Path $operator, "$operator\secrets", "$operator\application-secrets" | Out-Null
Copy-Item deploy\docker\.env.production.example "$operator\production.env"
notepad "$operator\production.env"
```

The environment file is public configuration: public HTTPS origin, selected image
digests, non-secret database role/name, selected mode's upstreams, S3 endpoint/bucket
names, and paths to secret files. Never put a password, token, private key, or
credential-bearing database URL in it. Create restrictive files named by the variables
in the example (`CASEWEAVER_*_FILE`), including empty files for disabled optional
features because Docker mounts a fixed secret contract. The helper requires non-empty
files for PostgreSQL, the migration/runtime URLs, TLS certificate/key, and all required
S3 encryption/credential material.

`CASEWEAVER_APPLICATION_SECRETS_DIRECTORY` is a read-only directory of additional
server-private connector/provider/repository values. Each filename must be a safe
environment-variable name such as `CASEWEAVER_OPENROUTER_KEY`; its content is the value.
The API, worker, or standalone host loads it at startup. It never becomes an Admin API
response, browser value, URL, Compose interpolation value, diagnostic, or log. The
webhook and scheduler deliberately do not mount it because they only admit/enqueue or
schedule durable work.

Set one exact public origin and matching certificate/identity callback, not a Docker
hostname. For `standalone`, set `CASEWEAVER_EDGE_API_UPSTREAM=standalone:3000` and
`CASEWEAVER_EDGE_WEBHOOK_UPSTREAM=standalone:8081`; for `distributed`, set
`api:3000` and `webhook:8081`. The helper rejects a mismatch and refuses direct values
where a production secret file is required.

### Verify, migrate, and start

Use the helper rather than ad-hoc profile commands. It validates all digest, secret-file,
TLS, object-storage, trusted-proxy, and mutually-exclusive-profile inputs before asking
Docker to render or start anything.

```powershell
node deploy\docker\production-operations.mjs validate --env-file C:\CaseWeaver\production\production.env
node deploy\docker\production-operations.mjs migrate --env-file C:\CaseWeaver\production\production.env --mode standalone
node deploy\docker\production-operations.mjs start --env-file C:\CaseWeaver\production\production.env --mode standalone
```

The migration sequence starts private PostgreSQL, runs Prisma migrations, runs the
pg-boss migration, then grants the runtime role. It is forward-only. The migration URL
belongs only to these bounded jobs; API, worker, scheduler, webhook, and standalone use
the separate runtime URL, whose role has DML privileges and cannot create tables. After
starting, browse the configured `ADMIN_ALLOWED_ORIGINS` URL and check:

```powershell
curl.exe --fail https://caseweaver.example.com/health/live
curl.exe --fail https://caseweaver.example.com/health/ready
```

Only `edge` binds HTTP/HTTPS. It redirects HTTP to HTTPS, terminates TLS, replaces
forwarded headers, serves the static Admin application same-origin, and proxies API,
health, and webhook paths. `tls-material` is a root/no-network certificate holder that
copies certificate material to a private memory volume; the public Nginx edge has no
direct host private-key mount and runs as non-root. Recreate it through `start` after a
certificate renewal. PostgreSQL is the one documented container-security exception: the
official image uses root briefly to initialize a new data volume and then drops to its
own account; it has no published port and joins only the private data network.

`standalone` is the default small installation: one backend process hosts API, webhook,
scheduler, worker, relay, and the no-network attachment processor. `distributed` keeps
the same durable PostgreSQL queue/outbox/leases/configuration pins but runs API,
webhook, scheduler, and worker separately. Never run both profiles. To change mode,
make a backup, stop the old runtime, re-run `migrate` for the selected release, change
the two upstream settings, then `start` the new mode. It is a controlled restart, not a
zero-downtime transition.

### OIDC, password bootstrap, and proxy trust

OIDC is the production default. Put its client secret and ephemeral encryption key in
their individual secret files; set exact `OIDC_ISSUER`, `OIDC_CLIENT_ID`, HTTPS
`OIDC_CALLBACK_URL`, a stable bootstrap subject/display name for a fresh deployment,
and leave password authentication disabled. Remove bootstrap identity values once the
mapping exists. The API owns Authorization Code + PKCE state/nonce/signature/time
validation, secure `HttpOnly` sessions, CSRF, workspace switching, authorization, and
audit events. The browser never receives an OAuth token or client secret.

Password login is an explicit break-glass option only: set
`ADMIN_ENABLE_PASSWORD_AUTHENTICATION=true`, use unique values in the two password
secret files, and restrict access while you establish OIDC. Do not reuse the local
`admin` / `admin` credentials. `TRUSTED_PROXY_CIDRS` must equal the fixed internal
application subnet because the API must trust forwarding headers only from the edge.

### Backup, recovery, upgrades, and rollback

The helper's backup boundary is intentionally a stopped runtime. It stops the selected
profile, copies the configured object prefix to a unique prefix in the separate backup
bucket, writes a PostgreSQL custom-format dump, and creates a non-secret
`<backup>.manifest.json` beside it. It then leaves the runtime stopped so an operator
can inspect the artifacts before starting it again:

```powershell
$backup = 'C:\CaseWeaver\backups\caseweaver-2026-07-31.dump'
node deploy\docker\production-operations.mjs backup --env-file C:\CaseWeaver\production\production.env --mode standalone --output $backup
node deploy\docker\production-operations.mjs start --env-file C:\CaseWeaver\production\production.env --mode standalone
```

For recovery, use a clean or deliberately emptied target object prefix and a matching
deployment configuration. The helper refuses a manifest whose source bucket/prefix or
backup bucket does not match, stops the runtime, restores objects without deleting any
target objects, restores PostgreSQL, and reapplies the controlled migration/grant
sequence. Start only after restore succeeds:

```powershell
node deploy\docker\production-operations.mjs restore --env-file C:\CaseWeaver\production\production.env --mode standalone --input C:\CaseWeaver\backups\caseweaver-2026-07-31.dump
node deploy\docker\production-operations.mjs start --env-file C:\CaseWeaver\production\production.env --mode standalone
```

The repository's production acceptance test proves this procedure with a private
S3-compatible store: it writes an object, backs up PostgreSQL and objects, removes the
original project, restores into an isolated project, checks TLS readiness/audit state,
and verifies the object. It is not a promise that a large real installation restores in
the same time. Your RPO is the interval between completed backups and your real RTO is
the measured time to restore your data/host. Version the backup bucket, protect it from
the runtime identity, and run a measured drill after material data or topology changes.

For an upgrade, verify the new digest/attestation, make a backup, stop/drain the old
runtime, run `migrate`, and start the selected mode. An image-only rollback is allowed
only if the existing forward-only schema is known compatible. Otherwise restore the
tested backup; the helper intentionally has no destructive automatic downgrade.

### Attestation verification and disconnected delivery

Before deployment, verify the release record's digest while authenticated to the chosen
registry. This checks the GitHub workflow identity and source revision, not merely a
mutable tag:

```powershell
gh attestation verify oci://registry.example/caseweaver-standalone@sha256:<digest> --repo <owner>/<repository> --source-digest <source-commit> --signer-workflow <owner>/<repository>/.github/workflows/containers.yml --bundle-from-oci
gh attestation verify oci://registry.example/caseweaver-standalone@sha256:<digest> --repo <owner>/<repository> --source-digest <source-commit> --signer-workflow <owner>/<repository>/.github/workflows/containers.yml --predicate-type https://github.com/in-toto/attestation/blob/main/spec/predicates/spdx.md --bundle-from-oci
```

For a disconnected site, mirror every exact image digest **and its OCI attestations**
to the internal registry, retain the release record/SBOM artifacts with the change
record, authenticate Docker and `gh` to that mirror, then run the same verification
against the mirrored digest before using the helper. Do not convert a digest to a local
tag as the production identity.

### Production troubleshooting

| Symptom | First safe check |
| --- | --- |
| Helper refuses a configuration | Run `validate`; correct the public environment/secret file path it names. It never prints a secret value. |
| Edge or Admin is not healthy | `docker compose --env-file <file> -f deploy/docker/compose.production.yml ps`; check only the named service's redacted logs. Confirm the TLS files and exact upstream mode settings. |
| `/health/ready` fails | Check PostgreSQL health, runtime-role grants, migration completion, and the selected API/standalone service. Do not grant DDL to make it green. |
| OIDC callback fails | Compare the public HTTPS origin, issuer configuration, registered callback, certificate hostname, and trusted-proxy subnet. Browser tokens are never a workaround. |
| Backup/restore fails | Keep the runtime stopped, preserve dump and manifest, confirm backup/source bucket/prefix match, then investigate S3 access and PostgreSQL output. The helper never deletes target objects. |
| A scan/attestation release job fails | Treat the tag as unaccepted. Use the retained security artifact and signed digest evidence; create a reviewed remediation/exception design rather than overriding the job. |

## OIDC in the local stack

Password login is enough for local evaluation. To exercise OIDC, set all required
values before starting Compose. The callback and origin must be real HTTPS URLs; the
loopback edge is not a public OIDC deployment.

```powershell
$env:OIDC_ISSUER = "https://issuer.example.com"
$env:OIDC_CLIENT_ID = "caseweaver-local"
$env:OIDC_CALLBACK_URL = "https://caseweaver-local.example.com/v1/auth/callback"
$env:OIDC_EPHEMERAL_ENCRYPTION_KEY = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
$env:OIDC_EPHEMERAL_KEY_ID = "local-key-1"
$env:ADMIN_BOOTSTRAP_OIDC_SUBJECT = "issuer-stable-subject"
$env:ADMIN_BOOTSTRAP_DISPLAY_NAME = "Local administrator"
$env:ADMIN_DISABLE_LOGIN_AUTHENTICATION = "true"
docker compose -f deploy\docker\compose.local.yml up --build --wait
```

## Test database and Admin bridge

For host-run PostgreSQL/pgvector integration tests:

```powershell
docker compose -f deploy\docker\compose.test.yml up -d --wait
$env:DATABASE_URL = "postgresql://caseweaver:caseweaver@localhost:54329/caseweaver_test"
pnpm test:integration
docker compose -f deploy\docker\compose.test.yml down -v
```

`compose.admin.yml` is only for an API that is already running elsewhere:

```powershell
$env:CASEWEAVER_ADMIN_API_BASE_URL = "https://api.example.com"
docker compose -f deploy\docker\compose.admin.yml up --build --wait
```

It exposes the UI on `http://127.0.0.1:8082` and is not a TLS or authentication
boundary; the API owns authentication, authorization, CSRF, auditing, and secrets.
