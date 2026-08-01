---
sidebar_position: 9
title: Configuration reference
---

# Configuration reference

All values below are deployment inputs, not Admin form fields. Supply production secrets
through the corresponding `*_FILE` path in the operator environment; never copy their
contents into the environment file, a URL, browser storage, or this guide.

| Key / group | Consumer, required/default rule, and valid form | Classification and supply point |
| --- | --- | --- |
| `NODE_ENV`, `HOST`, `PORT`, `DATABASE_READINESS_TIMEOUT_MS` | API runtime. `HOST` defaults to `0.0.0.0`; API `PORT` and readiness timeout are required. Production Compose fixes the internal API port. | Public runtime/deployment configuration. |
| `DATABASE_URL` | API, CLI, and runtime database connection. Required PostgreSQL URL; in production it is loaded only from the matching file. | Secret; `CASEWEAVER_RUNTIME_DATABASE_URL_FILE` for runtime and `CASEWEAVER_MIGRATION_DATABASE_URL_FILE` for migration. |
| `API_WORKSPACE_ID`, `API_PRINCIPAL_ID`, `CLI_WORKSPACE_ID`, `CLI_PRINCIPAL_ID` | Required authorized local/API or CLI execution identity. Values are identifiers, not credentials. | Public deployment or CLI environment. |
| `ADMIN_ALLOWED_ORIGINS` | Required comma-separated exact browser origins. HTTPS is required except explicit development loopback. | Public deployment configuration. |
| `ADMIN_ENABLE_PASSWORD_AUTHENTICATION` | Production password sign-in is off by default. Set it to `true` only for deliberate break-glass access with unique credentials. It cannot be enabled with OIDC-only mode. | Public production configuration. |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD` | Development/test default is `admin` / `admin`. Production requires both non-default values only when password sign-in is deliberately enabled. | Secrets; `CASEWEAVER_ADMIN_LOGIN_FILE` and `CASEWEAVER_ADMIN_PASSWORD_FILE` in production. |
| `ADMIN_DISABLE_LOGIN_AUTHENTICATION` | Defaults to `false` in the API and `true` in the production Compose example. `true` makes access OIDC-only and requires complete OIDC configuration. | Public deployment configuration. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CALLBACK_URL`, `OIDC_EPHEMERAL_KEY_ID` | API-managed Authorization Code + PKCE. These four public values and the encryption key must be supplied together. The callback is HTTPS outside localhost and ends in `/v1/auth/callback`. | Public deployment configuration. |
| `OIDC_CLIENT_SECRET`, `OIDC_EPHEMERAL_ENCRYPTION_KEY` | Optional OIDC secret material; the latter is a valid 32-byte base64url/base64 encryption key when OIDC is enabled. | Secrets; `CASEWEAVER_OIDC_CLIENT_SECRET_FILE` and `CASEWEAVER_OIDC_EPHEMERAL_ENCRYPTION_KEY_FILE` in production. |
| `ADMIN_BOOTSTRAP_OIDC_SUBJECT`, `ADMIN_BOOTSTRAP_DISPLAY_NAME` | Paired, one-time first-administrator mapping. Remove both after the mapping exists. | Public deployment configuration. |
| `TRUSTED_PROXY_CIDRS` | Exact comma-separated trusted proxy CIDRs only; all other forwarded headers are ignored. | Public deployment configuration. |
| `WEBHOOK_HOST`, `WEBHOOK_PORT`, `WEBHOOK_MAXIMUM_BODY_BYTES` | Webhook bind/body limits. In production only the edge publishes the webhook route. | Public runtime/deployment configuration. |
| `POSTGRES_DB`, `POSTGRES_USER`, `CASEWEAVER_RUNTIME_DATABASE_ROLE` | Private PostgreSQL database, migration-role, and runtime-role names. The runtime role has no DDL. | Public production configuration. |
| `CASEWEAVER_RELEASE_VERSION`, `CASEWEAVER_POSTGRES_IMAGE`, `CASEWEAVER_MIGRATION_IMAGE`, `CASEWEAVER_API_IMAGE`, `CASEWEAVER_ADMIN_IMAGE`, `CASEWEAVER_WORKER_IMAGE`, `CASEWEAVER_SCHEDULER_IMAGE`, `CASEWEAVER_WEBHOOK_IMAGE`, `CASEWEAVER_STANDALONE_IMAGE`, `CASEWEAVER_ATTACHMENT_PROCESSOR_IMAGE`, `CASEWEAVER_EDGE_IMAGE`, `CASEWEAVER_S3_OPERATIONS_IMAGE` | Production release/version and every image identity. All images are required digest-pinned references; a tag is discovery, not an installation input. | Public operator environment. |
| `CASEWEAVER_APPLICATION_SUBNET`, `CASEWEAVER_EGRESS_SUBNET`, `CASEWEAVER_EDGE_HTTP_BINDING`, `CASEWEAVER_EDGE_HTTPS_BINDING`, `CASEWEAVER_EDGE_PUBLIC_HTTPS_PORT`, `CASEWEAVER_EDGE_API_UPSTREAM`, `CASEWEAVER_EDGE_WEBHOOK_UPSTREAM` | Private network boundaries, sole public TLS edge bindings, and mode-specific upstreams. The helper rejects a missing or mismatched selected mode. | Public production configuration. |
| `CASEWEAVER_POSTGRES_PASSWORD_FILE`, `CASEWEAVER_RUNTIME_DATABASE_PASSWORD_FILE`, `CASEWEAVER_MIGRATION_DATABASE_URL_FILE`, `CASEWEAVER_RUNTIME_DATABASE_URL_FILE` | Required PostgreSQL owner/runtime credentials and migration/runtime connection URLs. | Restrictive operator-owned secret-file paths. |
| `CASEWEAVER_OIDC_CLIENT_SECRET_FILE`, `CASEWEAVER_OIDC_EPHEMERAL_ENCRYPTION_KEY_FILE`, `CASEWEAVER_ADMIN_LOGIN_FILE`, `CASEWEAVER_ADMIN_PASSWORD_FILE` | OIDC and optional password-login secrets. Disabled optional capabilities still use the required empty file in the fixed Compose secret contract. | Restrictive operator-owned secret-file paths. |
| `CASEWEAVER_OBJECT_STORAGE_KEY_DERIVATION_SECRET_FILE`, `CASEWEAVER_OBJECT_STORAGE_S3_ACCESS_KEY_ID_FILE`, `CASEWEAVER_OBJECT_STORAGE_S3_SECRET_ACCESS_KEY_FILE`, `CASEWEAVER_TRUSTED_CA_FILE`, `CASEWEAVER_TLS_CERTIFICATE_FILE`, `CASEWEAVER_TLS_PRIVATE_KEY_FILE` | Storage, private CA, and TLS material. Required production storage/TLS files must be non-empty. | Restrictive operator-owned secret-file paths. |
| `CASEWEAVER_APPLICATION_SECRETS_DIRECTORY` | Read-only directory of safe-named files containing server-private connector/provider values. It is loaded only by server-side processes. | Operator-owned secret directory. |
| `OBJECT_STORAGE_KIND`, `OBJECT_STORAGE_BACKEND_ID`, `OBJECT_STORAGE_KEY_PREFIX`, `OBJECT_STORAGE_S3_ENDPOINT`, `OBJECT_STORAGE_S3_REGION`, `OBJECT_STORAGE_S3_BUCKET`, `OBJECT_STORAGE_S3_BACKUP_BUCKET`, `OBJECT_STORAGE_S3_BACKUP_PREFIX`, `OBJECT_STORAGE_S3_FORCE_PATH_STYLE`, `OBJECT_STORAGE_S3_ENCRYPTION`, `OBJECT_STORAGE_S3_KMS_KEY_ID` | Production encrypted S3-compatible storage and independent backup prefix/bucket policy. | Public configuration; credentials are the storage secret files above. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_METRIC_EXPORT_INTERVAL_MS`, `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, `OTEL_SDK_DISABLED` | OpenTelemetry endpoint, cadence, service identity/release version, and explicit disablement. | Public deployment configuration; endpoint must not contain credentials. |
| `AI_CATALOG_LITELLM_COMMIT_SHA` | Optional 40-character trusted catalog-source pin. | Public deployment configuration. |
| `CASEWEAVER_LOCAL_PORT`, `CASEWEAVER_ADMIN_PORT`, `CASEWEAVER_TEST_DB_PORT`, `CASEWEAVER_E2E_PORT`, `CASEWEAVER_BACKEND_IMAGE`, `CASEWEAVER_FRONTEND_IMAGE`, `CASEWEAVER_IMAGE_VERSION`, `CASEWEAVER_IMAGE_REVISION`, `CASEWEAVER_IMAGE_SOURCE`, `CASEWEAVER_IMAGE_CREATED` | Local bridge, static-Admin bridge, disposable test/E2E ports, and locally built image metadata. They are not production installation settings. | Development/test only. |
| `CASEWEAVER_DOCUMENTATION_REPOSITORY`, `CASEWEAVER_OPENROUTER_KEY` | Optional local Docusaurus worktree mount and server-only provider value used only in the local evaluation overlay. The Admin UI receives at most the opaque `env:` reference. | Development host environment; never browser configuration. |
| `PG_BOSS_INTEGRATION` | Test-only integration prerequisite where a named test explicitly requires it. | Disposable test environment. |

The production Compose example is the verified complete reference for port bindings,
release images, secret-file names, modes, and storage variables. Run its `validate`
helper before Docker renders configuration. The local `compose.local.yml` and test
`compose.test.yml` are deliberately different contracts and must not be mixed with
production secrets or data.
