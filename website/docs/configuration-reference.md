---
sidebar_position: 9
title: Configuration reference
---

# Configuration reference

This is the source-verified catalog of CaseWeaver deployment inputs. It documents
environment variables and secret-file **paths**, not Admin form fields. The Admin
console creates workspace-scoped configuration; deployment configuration decides where
and how the trusted runtime is allowed to run. Do not use this page to put a password,
token, private key, credential-bearing URL, or provider value into an environment file.

The table uses these classifications:

- **Public config** — an operator-owned environment file or host environment may contain
  the value, but it still deserves change control.
- **Secret content** — supply the value only through the named restrictive file or
  server-only secret directory. A `*_FILE` value is a public path; its file content is
  secret.
- **Local/test only** — a disposable development or fixture input. Never promote it to
  production.
- **Runtime-only** — recognized by a process but not currently passed through the
  official production/Portainer Compose environment. Use it only when composing that
  process yourself; do not assume it is a supported Compose setting.

## Read this before setting a value

1. Select a topology in [Deployment reference](./deployment-reference.md). A key that
   is valid in `compose.local.yml` can be unsafe or ignored in production.
2. Copy the matching example outside the repository: `.env.production.example` for
   embedded production Admin, `.env.portainer.example` for an external Admin. These
   examples are the source of the supported public inputs.
3. Put secret contents in individual operator-owned files and point the matching
   `CASEWEAVER_*_FILE` variable at them. Do not interpolate secret content into Compose,
   command lines, URLs, browser runtime config, diagnostics, or logs.
4. In production, run `production-operations.mjs validate` before Docker renders the
   configuration. It rejects missing/unsafe production boundaries without printing
   secret values.

## Core API, database, and local build inputs

| Key | Applies to | Required/default | Validation and effect | Classification / supply path | Safe automation rule |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | API, worker, scheduler, webhook, standalone, object storage | API defaults to `development`; supported values are `development`, `test`, `production`. Production Compose sets `production`. | Selects production secret-file rules and forbids local object storage in production. | Public config. | Set by the chosen topology; never use a development flag to bypass production validation. |
| `HOST`, `PORT` | API process | `HOST` defaults to `0.0.0.0`; `PORT` is required by a directly composed API. Official Compose fixes it internally. | Port is an integer from `1` to `65535`. | Public config; runtime-only for official production Compose. | Do not publish this internal port directly. |
| `DATABASE_URL` | Direct API/worker/scheduler/webhook/standalone/test execution | Required by every runtime process when no `DATABASE_URL_FILE` loader is used. | Must be a PostgreSQL URL. Production entrypoints reject direct secret values. | Secret content; direct local/test process only. Production uses the corresponding file path below. | Never serialize, log, or place it in a `.env` file. |
| `DATABASE_READINESS_TIMEOUT_MS` | API | Required by a direct API; production/Portainer Compose default `5000`. | Integer `1` through `60000`; bounds readiness waiting only. | Public config. | Tune only after measuring database startup/readiness; it does not repair database permissions. |
| `API_WORKSPACE_ID`, `API_PRINCIPAL_ID` | API/standalone bootstrap | Required in production and Portainer examples. | Identifier-shaped bootstrap execution context, not a browser identity or permission grant. | Public config. | Treat changes as an identity/bootstrap change and validate authorization after deployment. |
| `POSTGRES_DB`, `POSTGRES_USER`, `CASEWEAVER_RUNTIME_DATABASE_ROLE` | Production/Portainer PostgreSQL and migration chain | Defaults are `caseweaver`, `caseweaver_migrator`, and `caseweaver_runtime` in examples. | The runtime role is granted DML, not DDL. | Public config. | Keep migration and runtime roles separate; never grant DDL to runtime to make health checks pass. |
| `CASEWEAVER_BACKEND_IMAGE`, `CASEWEAVER_FRONTEND_IMAGE`, `CASEWEAVER_MIGRATION_IMAGE` | Local Compose build/cache | Local names default to local image names; the migration image is also a production image input. | Local Compose builds backend/frontend targets; production validates its image variables as digests. | Local/test only for backend/frontend; see production image group for migration. | Do not replace release image identities with local tags in production. |
| `CASEWEAVER_IMAGE_VERSION`, `CASEWEAVER_IMAGE_REVISION`, `CASEWEAVER_IMAGE_SOURCE`, `CASEWEAVER_IMAGE_CREATED` | Local image build labels | All default to local build metadata. | OCI source/version/revision label inputs only. | Local/test only. | Supply non-secret provenance metadata; never put credentials in `CASEWEAVER_IMAGE_SOURCE`. |

## Admin artifact and browser-origin inputs

| Key | Applies to | Required/default | Validation and effect | Classification / supply path | Safe automation rule |
| --- | --- | --- | --- | --- | --- |
| `CASEWEAVER_ADMIN_API_BASE_URL` | Admin image / Cloudflare Pages artifact | Required for `compose.admin.yml`; `/` for a same-origin proxy, otherwise a credential-free HTTPS origin (HTTP loopback only for development). | Generates the browser `runtime-config.json`; it is not an API authorization setting. | Public config. | Keep it origin-only; never include a path, query, fragment, username, password, or token. |
| `CASEWEAVER_ADMIN_UI_TITLE` | Admin image / Pages artifact | Defaults to `CaseWeaver Control Room` (local Compose adds a local suffix). | Limited safe text is written into runtime config. | Public config. | Treat it as display text only; do not use it for environment or identity data. |
| `CASEWEAVER_ADMIN_PORT` | `compose.admin.yml` | Defaults to `8082`. | Binds the Admin-only bridge to loopback. | Local/test only. | Do not expose this bridge as a production security boundary. |
| `CASEWEAVER_LOCAL_PORT` | `compose.local.yml` | Defaults to `8080`. | The only published local stack port; it also determines the two exact local UI origins. | Local/test only. | Bind only to loopback and restart the stack after changing it. |
| `CASEWEAVER_ADMIN_PAGES_API_ORIGIN`, `CASEWEAVER_ADMIN_PAGES_ACCOUNT_ID`, `CASEWEAVER_ADMIN_PAGES_PROJECT`, `CASEWEAVER_ADMIN_PAGES_API_TOKEN` | Admin Pages publishing workflow, not Compose | Required only when the repository owner enables the Pages publication contract. | Produces a static external Admin artifact; the token is a protected-environment secret. | First three are public GitHub workflow variables; `CASEWEAVER_ADMIN_PAGES_API_TOKEN` is secret content in the protected GitHub environment. | Follow [GitHub automation](https://github.com/lbouriez/CaseWeaver/blob/main/.github/README.md#admin-console--verified-cloudflare-pages-artifact); never copy the token into Docker or Admin runtime config. |

## Authentication, cookies, OIDC, and proxies

| Key | Applies to | Required/default | Validation and effect | Classification / supply path | Safe automation rule |
| --- | --- | --- | --- | --- | --- |
| `ADMIN_ALLOWED_ORIGINS` | Every interactive API/standalone deployment | Required. Local Compose supplies its two loopback origins; production/Portainer require one exact HTTPS origin. | Comma-separated exact origins; no wildcard, path, credential, query, fragment, duplicate, or non-loopback HTTP origin. | Public config. | Keep it equal to the deployed Admin origin, not a redirect URL or a list of guessed origins. |
| `ADMIN_SESSION_COOKIE_SAME_SITE` | API/standalone | Defaults to `lax`; `none` is permitted only in production. | Controls the API-managed, host-only `HttpOnly` session cookie. | Public config. | Use `none` only for the documented external HTTPS Admin model; it never relaxes origin or CSRF checks. |
| `ADMIN_DISABLE_LOGIN_AUTHENTICATION`, `ADMIN_ENABLE_PASSWORD_AUTHENTICATION` | API/standalone | Disable defaults to `false` in API and `true` in production examples; enable defaults to development/test behavior. | They cannot both select password access. Production password access requires explicit non-default credentials. | Public config. | Prefer OIDC; use password login only as restricted break-glass access and remove it when no longer needed. |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD` | Local login or direct process composition | Development/test have documented disposable defaults. Production only accepts explicit non-default values if password access is deliberately enabled. | API never returns either value. | Secret content; production uses `CASEWEAVER_ADMIN_LOGIN_FILE` and `CASEWEAVER_ADMIN_PASSWORD_FILE`. | Never put a production password in source control, an environment file, a URL, or a browser. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CALLBACK_URL`, `OIDC_EPHEMERAL_KEY_ID`, `OIDC_EPHEMERAL_ENCRYPTION_KEY` | API-managed OIDC Authorization Code + PKCE | The first five form one all-or-nothing OIDC configuration. Callback is public HTTPS outside loopback and ends in `/v1/auth/callback`. | Issuer/callback are HTTPS, key ID is an identifier, encryption key decodes to 32 bytes. | Public config except `OIDC_EPHEMERAL_ENCRYPTION_KEY`, which is secret content supplied by `CASEWEAVER_OIDC_EPHEMERAL_ENCRYPTION_KEY_FILE` in production. | Register the API callback with the identity provider; never use a Pages UI URL as the callback. |
| `OIDC_CLIENT_SECRET` | OIDC confidential client | Optional only where the provider/client requires it. | Loaded by the API only; absent is allowed for public-client flows. | Secret content; production uses `CASEWEAVER_OIDC_CLIENT_SECRET_FILE`. | Never expose it to the browser, static artifact, or an operator form. |
| `ADMIN_BOOTSTRAP_OIDC_SUBJECT`, `ADMIN_BOOTSTRAP_DISPLAY_NAME` | Fresh OIDC installation | Optional pair; both are required together and only with OIDC. | Creates the first administrator mapping atomically; not an HTTP API. | Public config. | Remove both once the mapping exists; do not use a mutable email address as the stable subject. |
| `TRUSTED_PROXY_CIDRS` | API/standalone behind an edge | Empty only when no proxy is trusted. Production helper requires it to equal `CASEWEAVER_APPLICATION_SUBNET`. | Comma-separated IP/CIDR values; `/0` is rejected. Only listed sources may influence forwarded headers. | Public config. | Name the fixed internal edge subnet only, never a broad internet range. |
| `AI_CATALOG_LITELLM_COMMIT_SHA` | Trusted AI catalog refresh | Optional. | When supplied, it must be a 40-character trusted source commit and pins the server-owned catalog source. | Public config. | It enriches pricing/capability metadata only; it never makes a model executable or selects a provider endpoint. |

## Production image, network, and lifecycle inputs

| Key | Applies to | Required/default | Validation and effect | Classification / supply path | Safe automation rule |
| --- | --- | --- | --- | --- | --- |
| `CASEWEAVER_RELEASE_VERSION` | Production/Portainer | Required. | Becomes telemetry/release identity. | Public config. | Tie it to the verified release record, not an arbitrary user label. |
| `CASEWEAVER_POSTGRES_IMAGE`, `CASEWEAVER_MIGRATION_IMAGE`, `CASEWEAVER_API_IMAGE`, `CASEWEAVER_ADMIN_IMAGE`, `CASEWEAVER_WORKER_IMAGE`, `CASEWEAVER_SCHEDULER_IMAGE`, `CASEWEAVER_WEBHOOK_IMAGE`, `CASEWEAVER_STANDALONE_IMAGE`, `CASEWEAVER_ATTACHMENT_PROCESSOR_IMAGE`, `CASEWEAVER_EDGE_IMAGE`, `CASEWEAVER_S3_OPERATIONS_IMAGE` | Production Compose | All are required by the production helper. Portainer uses the images it contains; no API/Admin/worker/scheduler/webhook services exist there. | Each must be a linux/amd64 immutable `image@sha256:<digest>` identity; a tag is not accepted. | Public config. | Take every value from the same verified release record and verify provenance/SBOM before changing it. |
| `CASEWEAVER_APPLICATION_SUBNET`, `CASEWEAVER_EGRESS_SUBNET` | Production/Portainer internal networks | Defaults differ by topology (`172.28.0.0/24` production, `172.31.0.0/24` Portainer application). | The application subnet must exactly match `TRUSTED_PROXY_CIDRS` in production validation. | Public config. | Reserve non-overlapping private ranges and keep host firewall policy aligned. |
| `CASEWEAVER_EDGE_HTTP_BINDING`, `CASEWEAVER_EDGE_HTTPS_BINDING`, `CASEWEAVER_EDGE_PUBLIC_HTTPS_PORT` | Production/Portainer edge | Required in production validation. | The TLS edge is the sole public port publisher; public HTTPS port is validated as a port number in Portainer. | Public config. | Do not bind API or PostgreSQL directly as a workaround. |
| `CASEWEAVER_EDGE_API_UPSTREAM`, `CASEWEAVER_EDGE_WEBHOOK_UPSTREAM` | `compose.production.yml` only | Required when a profile is selected. | Must match the selected `standalone` or `distributed` profile exactly. | Public config. | Never set both profiles or point to an arbitrary Docker hostname. |
| `CASEWEAVER_APPLICATION_SECRETS_DIRECTORY` | Production/Portainer runtime/worker/standalone | Required by production validation. | A read-only operator-owned directory; each non-empty file name must be a safe environment-variable identifier. | Secret content directory; directory path is public config. | Mount it only into trusted processes that resolve connector/provider/repository values. It must never reach Admin. |
| `CASEWEAVER_DEPLOYMENT_TEST_MODE` | Deployment acceptance fixtures | No production default; recognized only by controlled deployment tests. | Temporarily permits fixture image identities in validation. | Local/test only. | Never set it in a real deployment. |

## Docker secret-file paths

Every file-path key below is required by the fixed production/Portainer Compose secret
contract. Optional disabled features still use an intentionally empty, access-restricted
file so Docker can mount a fixed shape. PostgreSQL, migration/runtime URL, object-storage
credential material, and TLS files must be non-empty when their topology validates.

| Key | Applies to | Required/default | Validation and effect | Classification / supply path | Safe automation rule |
| --- | --- | --- | --- | --- | --- |
| `CASEWEAVER_POSTGRES_PASSWORD_FILE`, `CASEWEAVER_RUNTIME_DATABASE_PASSWORD_FILE` | Production/Portainer PostgreSQL bootstrap | Required, non-empty regular files. | Separates database owner/bootstrap and DML runtime credentials. | Public path / secret content. | Use different restricted files and rotate independently. |
| `CASEWEAVER_MIGRATION_DATABASE_URL_FILE`, `CASEWEAVER_RUNTIME_DATABASE_URL_FILE` | Migration and runtime services | Required, non-empty regular files. | The migration URL is mounted only into migration jobs; runtime services receive the runtime URL. | Public path / secret content. | Do not swap or reuse the paths; never place either URL in Compose environment values. |
| `CASEWEAVER_OIDC_CLIENT_SECRET_FILE`, `CASEWEAVER_OIDC_EPHEMERAL_ENCRYPTION_KEY_FILE` | OIDC API/standalone | Required paths; contents may be intentionally empty only when OIDC is disabled. | The entrypoint loads their content into the trusted process. | Public path / secret content. | Keep both unreadable to the frontend and unmounted from scheduler/webhook. |
| `CASEWEAVER_ADMIN_LOGIN_FILE`, `CASEWEAVER_ADMIN_PASSWORD_FILE` | Optional production password login | Required paths; contents may be intentionally empty when password login is disabled. | Supply non-default values only with deliberate break-glass access. | Public path / secret content. | Treat them as emergency credentials and remove/rotate after use. |
| `CASEWEAVER_OBJECT_STORAGE_KEY_DERIVATION_SECRET_FILE`, `CASEWEAVER_OBJECT_STORAGE_S3_ACCESS_KEY_ID_FILE`, `CASEWEAVER_OBJECT_STORAGE_S3_SECRET_ACCESS_KEY_FILE` | Production/Portainer storage and backup operations | Required, non-empty regular files for supported S3 production operation. | Loads encryption derivation and S3 identity only into worker/standalone/object operation paths. | Public path / secret content. | Use least-privilege storage credentials and never copy them into the Admin secret-reference registry. |
| `CASEWEAVER_TRUSTED_CA_FILE` | Production/Portainer outbound TLS | Required path; intentionally empty when public trust roots are enough. | Mounted as the trusted extra CA file. | Public path / secret content if private CA material. | Maintain it as a CA bundle, not a client certificate or a browser asset. |
| `CASEWEAVER_TLS_CERTIFICATE_FILE`, `CASEWEAVER_TLS_PRIVATE_KEY_FILE` | Production/Portainer public edge | Required, non-empty regular files. | A root/no-network material service copies them to private tmpfs for non-root Nginx. | Public path / secret content (private key). | Renew source files deliberately and recreate edge material through the documented procedure. |

## Object storage, repository, and attachment runtime inputs

| Key | Applies to | Required/default | Validation and effect | Classification / supply path | Safe automation rule |
| --- | --- | --- | --- | --- | --- |
| `OBJECT_STORAGE_KIND`, `OBJECT_STORAGE_BACKEND_ID`, `OBJECT_STORAGE_KEY_PREFIX` | Worker/standalone storage | Production requires `OBJECT_STORAGE_KIND=s3`; key prefix defaults to `caseweaver`. | Backend ID and prefix are validated identifiers/prefixes. | Public config. | Use a distinct backend ID and prefix per environment; do not use local storage in production. |
| `OBJECT_STORAGE_KEY_DERIVATION_SECRET` | Direct process/local storage configuration | Required by object-storage runtime. | Never accepted as a direct production bootstrap value. | Secret content; production uses `CASEWEAVER_OBJECT_STORAGE_KEY_DERIVATION_SECRET_FILE`. | Keep it server-only and rotate with storage recovery planning. |
| `OBJECT_STORAGE_LOCAL_ROOT` | Direct/local storage | Required absolute path only when local storage is used outside production. | Local storage is rejected when `NODE_ENV=production`. | Local/test only. | Do not use it as a durable production object store. |
| `OBJECT_STORAGE_S3_ENDPOINT`, `OBJECT_STORAGE_S3_REGION`, `OBJECT_STORAGE_S3_BUCKET`, `OBJECT_STORAGE_S3_FORCE_PATH_STYLE`, `OBJECT_STORAGE_S3_MULTIPART_PART_SIZE_BYTES` | S3-compatible runtime | Region/bucket are required for S3; endpoint is optional in production Compose but required by Portainer; force-path-style defaults `false`. | Endpoint has no credentials; multipart size is bounded by runtime validation. | Public config. | Use TLS endpoints where required and separate credentials into the secret files above. |
| `OBJECT_STORAGE_S3_ENCRYPTION`, `OBJECT_STORAGE_S3_KMS_KEY_ID` | S3-compatible runtime | Encryption defaults to `AES256`; KMS ID is required when the selected encryption mode needs it. | Invalid encryption/KMS combinations fail configuration. | Public config. | Use provider-approved encryption policy; a KMS identifier is not a credential. |
| `OBJECT_STORAGE_S3_BACKUP_BUCKET`, `OBJECT_STORAGE_S3_BACKUP_PREFIX` | Production helper backup/restore | Both are required for production helper backup policy; prefix defaults in the example. | The backup location must be distinct/valid and is recorded in a non-secret manifest. | Public config. | Use a separately protected, versioned backup bucket; do not let normal runtime credentials delete it. |
| `WORKER_GIT_TEMPORARY_DIRECTORY`, `WORKER_GIT_REMOTE_CACHE_DIRECTORY` | Worker/standalone Git runtime | Official production/Portainer Compose default them to private temporary paths. | If supplied, each is an absolute path. | Public config. | Use private writable temporary storage; do not mount a browser-visible or shared developer directory. |
| `CASEWEAVER_GIT_TRUSTED_LOCAL_ROOTS_JSON`, `CASEWEAVER_DOCUMENTATION_REPOSITORY`, `CASEWEAVER_OPENROUTER_KEY` | Local documentation overlay | The overlay requires the host worktree variable and sets the trusted-root JSON itself; provider value is optional and backend-only. | Worktree is mounted read-only at the fixed path. | Local/test only; `CASEWEAVER_OPENROUTER_KEY` is secret content in host environment. | Never send the path or provider value to Admin; use an opaque `env:` secret reference in the Console. |
| `WORKER_ATTACHMENT_RUNTIME_SOCKET_PATH`, `WORKER_ATTACHMENT_RUNTIME_JOBS_DIRECTORY` | Worker and attachment processor | Official production/Portainer Compose fixes both to private Unix-socket paths. | Both are required together when attachment processing is enabled. | Public config; runtime-only outside official Compose. | Keep the volume private to worker/standalone and the no-network sidecar. |
| `WORKER_ATTACHMENT_RUNTIME_TIMEOUT_MS`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_MEMORY_BYTES`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_INPUT_BYTES`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_OUTPUT_BYTES`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_FILES`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_EXPANDED_BYTES`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_EXTRACTED_FILE_BYTES`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_ARCHIVE_DEPTH`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_COMPRESSION_RATIO` | Attachment sidecar | Production/Portainer Compose provide safe defaults. | Strict integer ceilings bound duration, memory, archive expansion, file count/depth, and output. | Public config. | Lower limits first when evaluating untrusted attachments; never remove the no-network sidecar boundary. |
| `WORKER_ATTACHMENT_EVIDENCE_MAXIMUM_BYTES`, `WORKER_ATTACHMENT_EVIDENCE_MAXIMUM_CHARACTERS` | Worker evidence reader | Runtime defaults are bounded; not mapped by official Compose. | Limits retained attachment derivative evidence. | Runtime-only. | Change only in a custom composed runtime with an explicit retention/evidence review. |
| `ADMIN_REPOSITORY_ANALYSIS_GIT_TEMPORARY_DIRECTORY`, `ADMIN_REPOSITORY_ANALYSIS_GIT_REMOTE_CACHE_DIRECTORY`, `ADMIN_REPOSITORY_ANALYSIS_MOUNTS_JSON`, `ADMIN_REPOSITORY_ANALYSIS_SANDBOX_POLICIES_JSON`, `ADMIN_REPOSITORY_ANALYSIS_ATTACHMENT_PROCESSOR_POLICIES_JSON` | API repository-analysis authoring runtime | Optional trusted deployment inputs; not mapped by official Compose. | JSON values are validated server-side and remain deployment-owned. | Runtime-only. | Do not expose paths, mounts, policy JSON, repository remotes, or secret locators to Admin. |
| `WORKER_REPOSITORY_AGENT_SOURCES_JSON`, `WORKER_REPOSITORY_AGENT_MOUNTS_JSON`, `WORKER_REPOSITORY_AGENT_SANDBOX_IMAGE`, `WORKER_REPOSITORY_AGENT_DOCKER_SOCKET_PATH` | Worker repository-agent runtime | Optional all-or-nothing boundary; sandbox image must be digest-pinned. | Maps only trusted repository sources/mount aliases into isolated analysis. | Runtime-only. | Do not give a sandbox inherited credentials, network, or an unrestricted Docker socket. |

## Scheduling, webhook, observability, and test inputs

| Key | Applies to | Required/default | Validation and effect | Classification / supply path | Safe automation rule |
| --- | --- | --- | --- | --- | --- |
| `SCHEDULER_POLL_INTERVAL_MS`, `SCHEDULER_BATCH_LIMIT`, `SCHEDULER_LEASE_MS` | Scheduler | Defaults are `1000`, `25`, and `30000`; official production Compose uses them implicitly. | Bounded positive integers control due-work polling and leases, not connector execution. | Runtime-only. | Tune with queue metrics and lease recovery tests; never use scheduling to bypass worker budgets. |
| `WEBHOOK_HOST`, `WEBHOOK_PORT`, `WEBHOOK_MAXIMUM_BODY_BYTES` | Webhook process | Production distributed Compose fixes host/port internally. | Binds verified ingress and bounds request bytes. | Public config; host/port runtime-only in official production Compose. | Publish webhook only through the TLS edge and retain signature verification. |
| `WORKER_OUTBOX_RELAY_BATCH_SIZE`, `WORKER_OUTBOX_RELAY_POLL_INTERVAL_MS`, `WORKER_TEAM_SIZE` | Worker | Runtime defaults are bounded; not mapped by official Compose. | Controls queue relay/consumer concurrency. | Runtime-only. | Scale only after observing PostgreSQL leases, provider budgets, and idempotency behavior. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_METRIC_EXPORT_INTERVAL_MS`, `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, `OTEL_SDK_DISABLED`, `OTEL_TRACE_SAMPLE_RATIO` | All runtime processes | Collector is disabled when endpoint is absent or SDK is explicitly disabled; metric interval defaults `30000`, trace ratio `0.05`. | Endpoint cannot contain credentials; service name/version and numeric bounds are validated. | Public config. | Send only redacted telemetry to a trusted collector; do not put collector credentials in the endpoint URL. |
| `OTEL_EXPORTER_OTLP_HEADERS` | OpenTelemetry exporter | Optional. | Parsed as bounded request headers. | Secret content when a collector needs authentication; runtime-only in official Compose. | Inject through an appropriate trusted secret mechanism, never a committed environment file. |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_ERROR_SAMPLE_RATIO`, `SENTRY_FLUSH_TIMEOUT_MS` | Optional Sentry diagnostic sink | Disabled when DSN is absent; error sampling defaults `1`; flush timeout defaults `1000`. | DSN is HTTPS and includes secret material; environment/release/ratios are validated. | `SENTRY_DSN` is secret content; remaining values are public config; all runtime-only in official Compose. | Keep diagnostic payloads redacted and do not publish the DSN in browser or docs artifacts. |
| `CASEWEAVER_TEST_DB_PORT`, `PG_BOSS_INTEGRATION` | Host integration tests | Test DB port defaults to `54329`; pg-boss flag is only for named test suites. | Controls disposable test infrastructure. | Local/test only. | Confirm the target database is disposable before a test run. |
| `CASEWEAVER_E2E_PORT`, `CASEWEAVER_E2E_KEEP_STACK`, `CASEWEAVER_E2E_OPENAI_COMPATIBLE_KEY`, `CASEWEAVER_E2E_PROVIDER_PORT` | Compose browser acceptance fixtures | UI port defaults to `18080`; fixture provider defaults are test-only. | Creates a unique disposable Compose acceptance topology. | Local/test only; fixture key is synthetic test content. | Never point these settings at a live provider or reuse them outside `pnpm test:e2e:compose`. |

## Variables intentionally not controlled by the Console

The Admin Console can register an **opaque reference** to a server-owned value, such as
an environment-backed reference, but it cannot inspect, edit, or list deployment
variables or their values. That distinction is deliberate:

- A deployment variable controls an infrastructure boundary, runtime identity, network,
  or secret supply path.
- An Admin configuration record selects an already-provisioned external reference and
  is workspace-scoped, authorized, immutable/versioned where needed, and audited.
- A secret-reference registration ID is metadata. It is not the locator value, a secret
  value, or a way to validate a host environment from the browser.

For the follow-up Console workflows, use the [Operator knowledge map](./operator-knowledge-map.md).
For the production topology and recovery sequence, return to
[Deployment reference](./deployment-reference.md).
