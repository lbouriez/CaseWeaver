# PBI-017: Docker-first self-hosting and delivery

## Outcome

Deliver a reproducible, secure, OCI-registry-neutral release and Docker Compose
installation for self-hosted CaseWeaver. An operator can install a digest-pinned release,
run the required migration deliberately, use either standalone or distributed topology,
serve the PBI-016 administration console over TLS, monitor readiness, upgrade safely,
and restore a tested backup without needing a cloud-vendor control plane.

This PBI depends on **PBI-013** and **PBI-016**. PBI-016 is not yet implemented: its
administration APIs, OIDC/session boundary, `apps/admin` artifact, and runtime public
configuration contract are prerequisites and are the largest delivery risk. PBI-017
must not invent substitute browser authorization, API, or configuration behavior.

## Goals

- Make Docker Compose the documented small-installation path, with a safe default
  topology and a supported standalone-to-distributed transition.
- Produce a non-root, reproducible runtime image and a separate static admin image from
  the same pinned source revision, with no build-time or browser-visible secrets.
- Publish OCI images to a registry selected by the deployer. GitHub Container Registry
  may be the first configured publisher, but neither image names, manifests, nor
  verification procedures may depend on it.
- Establish a gated GitHub Actions delivery pipeline from pull request verification
  through signed/attested OCI release publication.
- Define secure bootstrap configuration, secret-file handling, readiness, migrations,
  backups, upgrades, rollback limits, documentation, and operator support.
- Preserve the PBI-013 invariant that standalone and distributed modes use the same
  durable PostgreSQL queue, outbox, handlers, and leases.

## Non-goals

- No cloud hosting product, Kubernetes chart, Terraform module, or vendor-specific
  secret-manager integration is required in this PBI.
- No application feature, connector, provider, database policy, or authorization rule is
  reimplemented in Compose, the image, or a workflow.
- No secrets, sample passwords, access tokens, private registry credentials, or
  credential-like placeholders are committed to documentation, images, test fixtures, or
  workflow logs.
- The admin UI does not receive OIDC client secrets, API tokens, connector credentials,
  database URLs, or direct data-store access. It remains a static PBI-016 client of the
  authenticated CaseWeaver API.
- Multi-region HA, zero-downtime schema migrations, automatic database restoration, and
  arm64 release support are not promised by the initial release.

## Current-state audit

The implementation must start from these facts, not assumptions:

| Area | Current evidence | Delivery consequence |
|---|---|---|
| Release image | `deploy/docker/compose.production.yml` requires an externally supplied immutable `CASEWEAVER_IMAGE`, but the repository has no Dockerfile or image build assets. | Add a reproducible build contract before treating the Compose file as installable. |
| Runtime topology | The production Compose file has mutually exclusive `standalone` and `distributed` profiles, a one-shot `migrate` profile, PostgreSQL/pgvector, named database volume, and durable-mode warning in `deploy/docker/README.md`. | Retain profile semantics and persistent queue/database state; never run both runtime profiles together. |
| Networking | PostgreSQL is on an internal `caseweaver-data` network; every runtime service also shares `caseweaver-egress`; API and webhook bind host ports to loopback. | Separate ingress, application/data, and egress responsibilities more narrowly and add an explicit TLS edge boundary. |
| Secrets and entrypoint | `entrypoint.sh` requires `DATABASE_URL_FILE`, exports it only to the launched process, and the Compose file bind-mounts that script plus two local secret files. | Keep secret files, but bake a versioned entrypoint into the image; remove runtime executable bind mounts and split migration/runtime database privileges. |
| Health | PostgreSQL has a pgvector-aware healthcheck. `apps/api/src/health.routes.ts` already exposes `/health/live` and database-backed `/health/ready`; no runtime Compose service has a healthcheck. | Standardize authenticated-service-safe liveness/readiness endpoints and consume them in Compose, smoke tests, and the proxy. |
| Admin console | The tracked baseline at audit has no `apps/admin` path; `apps/web/README.md` says the web client is future work. PBI-016 requires `apps/admin`, typed admin APIs, cookie sessions, and deployment-injected public runtime configuration. | Do not package a fictitious SPA. Define the image/interface now, then build it only after PBI-016 delivers its artifact and API contract. |
| CI | `.github/workflows/ci.yml` is one Ubuntu job triggered by pull requests and `main`, with `contents: read`; it runs pnpm quality/build/tests and the database integration suite only. Its third-party actions are tag-pinned rather than immutable-SHA-pinned. | Preserve existing checks while adding staged Docker/release work, action pinning, least privilege, caches, concurrency, scans, attestations, and release rules. |
| Toolchain | `package.json` specifies pnpm 11.12.0 and Node >=22.12.0; CI currently uses Node 22.12.0. | The container build must use the lockfile, Corepack/pinned pnpm, and a Node 22.12-compatible digest-pinned base image. |

The audit also confirms the initial database is PostgreSQL with pgvector
(`.features/20-persistence-and-database-guide.md` and
`deploy/docker/postgres-init/001-extensions.sql`), and that production migrations are
forward-only, explicit, and must precede runtime startup. `PBI-013` already defines the
operability and durable-mode requirements; this PBI hardens their packaging and delivery.

## Architecture and image design

### Image contract

Build and publish two OCI artifacts from one commit:

1. **Runtime image** — contains the built Node workspace, the six documented commands
   (`caseweaver-migrate`, `caseweaver-standalone`, `caseweaver-api`,
   `caseweaver-webhook`, `caseweaver-scheduler`, and `caseweaver-worker`), a
   versioned secret-file/startup validator, and no source checkout, package-manager
   cache, test files, or development dependencies.
2. **Admin static image** — after PBI-016, builds `apps/admin` with its public runtime
   configuration deliberately excluded from the bundled JavaScript. It serves only the
   static artifact and a generated, schema-validated public runtime-config response.
   A non-root static server is acceptable; it must not proxy privileged requests itself.

Use a multi-stage Dockerfile under `deploy/docker` with a strict `.dockerignore`:

- Pin every base image by digest, install dependencies with `pnpm install
  --frozen-lockfile`, enable the repository's pinned pnpm through Corepack, and run the
  existing build commands. Set deterministic build inputs such as source revision and
  `SOURCE_DATE_EPOCH`; do not embed a current time except in separately declared OCI
  metadata.
- Build runtime packages and the admin artifact in isolated stages, then copy only the
  required production output into minimal final stages. The exact workspace-output
  layout is an implementation detail to validate after PBI-016 exists.
- Run each final image as a fixed non-root UID/GID, use read-only root filesystems where
  the process permits, a narrowly mounted writable temporary directory, dropped Linux
  capabilities, and `no-new-privileges`. Document any service-specific exception,
  especially PostgreSQL data ownership.
- Do not use `ARG`, `ENV`, BuildKit secret mounts, private package tokens, or remote
  secret fetches for secrets during build. A build that requires a secret is a design
  failure. Exclude `.env*`, secret directories, Git metadata, generated coverage, and
  local dependency directories from the build context.
- Stamp standard OCI labels for source revision, source URL, version, and build inputs.
  A label is traceability metadata, not a trust decision.

Release references use a human-readable version/ref tag only as a convenience and a
content digest as the deployable identity. Compose and upgrade documentation must require
the digest form; no `latest` or branch tag may be a production input. Emit a machine- and
human-readable release record containing the runtime digest, admin digest, source
revision, supported schema range, SBOM references, provenance reference, and signature
verification identity.

### Platform decision

The first supported runtime platform is `linux/amd64`. CI must build, smoke-test, scan,
attest, and publish only that platform initially, and image metadata/docs must say so.
Before advertising arm64, an architect must record the base-image/native-dependency
decision; automation must build a real `linux/arm64` image on native or emulated runners,
run the same startup/migration/smoke suite on arm64 hardware, and prove PostgreSQL,
pgvector, Node dependencies, and the static admin server work. A multi-architecture
manifest is published only after both platform digests pass their tests.

## Compose installation topology

### Deployment modes and migration sequence

Retain one project name and the existing logical PostgreSQL volume across profile
transitions. `standalone` runs API, webhook, scheduler, relay, and worker lifecycle in
one process; `distributed` runs API, webhook, scheduler, and worker separately. Both
must use the same database URL, queue schema/name, outbox, handler registrations, and
configuration. Compose validation and the operator helper must reject selecting both
profiles.

The only supported install/upgrade sequence is:

1. Verify the chosen release digest, provenance, signature (when enabled), platform, and
   compatibility notes before starting it.
2. Back up PostgreSQL and every configured durable object-storage backend; record the
   release and schema version with the backup.
3. Stop or drain old runtime services according to the release's compatibility window;
   retain the database volume and never remove it as part of a mode switch.
4. Run the explicit one-shot migration service with a migration-only database
   credential. It applies Prisma and the pinned pg-boss migration, records success, and
   exits. Runtime services never auto-migrate and their credential has no DDL privilege.
5. Start exactly one runtime profile, wait for every readiness check, and verify the
   versioned health/status endpoint through the TLS edge.

Startup must fail safely if a required secret file is unreadable, a required public URL
is malformed, the configured runtime profile is contradictory, the database/pgvector
check fails, or the runtime detects an unsupported schema version. Errors name the
configuration key and safe remediation only; they never print values, paths that reveal
secrets, connection strings, headers, or environment dumps.

### Services, ingress, and networks

The replacement production Compose design has these boundaries:

| Service role | Required connectivity | Notes |
|---|---|---|
| TLS edge proxy | Public ingress plus private application network | The only service publishing public ports. It terminates TLS, redirects cleartext HTTP when enabled, enforces request/body/time limits, and routes the configured admin, API, and webhook paths without forwarding untrusted identity headers. Operators may use their existing reverse proxy if it meets the documented contract. |
| Admin static service | Private application/edge network only | Serves the PBI-016 SPA and its public runtime config. It has no database, queue, provider, connector, object-store, or secret mount. |
| API | Private application/data networks; narrowly permitted egress for OIDC and telemetry | Receives the admin/API path from the edge. Cookie security, CORS, CSRF, allowed origins, trusted-proxy addresses, and OIDC callback URL remain PBI-016/API configuration, not proxy guesses. |
| Webhook | Private application/data networks | Receives only its declared public webhook path from the edge. It verifies raw payloads and enqueues work as defined by `apps/webhook/README.md`; it never receives browser admin traffic. |
| Scheduler | Data network | No public port and no connector/provider egress merely to evaluate schedules. |
| Worker | Data network and dedicated egress network | The only normal execution service with connector/provider/repository/object-store egress. Further isolated runners remain separate where PBI-010/PBI-008 require them. |
| Standalone | Private application/data plus dedicated egress networks | Replaces API/webhook/scheduler/worker services only in standalone mode; its readiness represents all co-located required lifecycles, not merely an open HTTP socket. |
| PostgreSQL | Internal data network only | Has no published port in production and retains its named data volume. |

Define an edge network, an internal application/data network, and an egress network.
Attach a service only to the networks it needs; do not retain the current blanket
runtime-to-egress attachment. Edge-to-service connections must use service DNS and
non-published ports. Default host bindings for diagnostic-only ports remain loopback and
off by default. The edge has the sole public listener and is the TLS/certificate
boundary; the application must receive a fixed, explicitly configured trusted-proxy
policy rather than trust arbitrary forwarding headers.

The browser-facing admin API base URL must be a configured HTTPS public URL (with an
explicit localhost-only development exception), preferably same-origin behind the edge
to simplify secure cookie scope. The separately configured webhook public base URL
generates opaque PBI-016 endpoint URLs and may be a different HTTPS host. Neither is
silently inferred from `Host`, forwarded headers, container names, or the browser. The
proxy routes public traffic only; it never knows database, OIDC client, connector, or
AI credentials.

### Volumes, secrets, and probes

- Persist PostgreSQL in the existing named volume; preserve it on `down` and mode
  transition. Static assets, runtime code, logs, generated public config, and secrets
  are not persistent application volumes. Persist and back up object storage according
  to its selected adapter's contract; a database-only backup is not sufficient once
  attachment/object storage is configured.
- Mount local bootstrap secrets as Compose `secrets` from operator-owned, read-only
  files. Minimum separate references are PostgreSQL bootstrap password, migration
  database URL, runtime database URL, and PBI-016 server-side OIDC secret when enabled.
  Use least-privilege database roles and do not pass a migration credential to runtime
  containers.
- For an external secret manager, the portable Compose baseline accepts a file mounted
  by the operator/platform secret agent. A Compose `external` secret may be used only
  where that Compose implementation actually supports it; documentation must not imply
  that plain Docker Compose resolves a third-party secret reference. PBI-016's
  application-level secret references remain server-side metadata and are never an admin
  SPA input.
- Keep a committed, non-secret environment example with keys, descriptions, allowed
  values, and intentionally blank values. It contains image digest selection, profile,
  public HTTPS URLs, trusted proxy/CORS settings, ports, telemetry endpoint, and
  `*_FILE` paths only. It contains no secret values and cannot be copied as a usable
  credential file.
- Bake the entrypoint and validation code into the runtime image. It reads only named
  secret files, exports a secret only to the immediate process when unavoidable, clears
  file-path variables, and never logs values. It must not bind-mount the current
  `deploy/docker/entrypoint.sh` into production containers.
- Add service-specific liveness and readiness checks. Liveness checks process health;
  readiness checks bounded required dependencies (database, pgvector/schema
  compatibility, queue/worker lifecycle where applicable) without performing connector,
  AI, or expensive work. Health responses and proxy logs contain no secret/configuration
  detail. The migration job is successful only after its command exits successfully and
  is not treated as a long-running healthy service.

## GitHub Actions delivery design

Keep verification and publication distinct. Use reusable, explicitly scoped workflow
units only if they reduce duplication without widening trust boundaries.

| Stage | Trigger and result |
|---|---|
| Source quality | Pull requests, `main` pushes, release tags, and manual reruns: lockfile install, formatting, lint, dependency-boundary check, typecheck, build, unit/contract tests, and PostgreSQL integration tests already represented by `package.json`/`ci.yml`. |
| Dependency review | Pull requests only, using the merge-base dependency diff. Block newly introduced policy-violating dependencies; do not run with `pull_request_target` or repository secrets. |
| Docker integration | Pull requests and trusted refs: build local runtime/admin targets without push; start disposable Compose dependencies; run empty and prior-schema migration fixtures, API/standalone/distributed readiness checks, critical durable-queue mode-switch test, proxy/admin routing test, and teardown. Use deterministic fakes only. |
| Build and metadata | Trusted `main`/tag/manual-release refs after verification: reproducibly build amd64 OCI images, attach revision/version labels, generate SBOMs, provenance, and a release digest record. |
| Scan and gate | Scan final image filesystem, OS packages, Node dependencies, Docker configuration, and SBOM. Fail release publication for critical findings and policy-defined high findings unless a reviewed, time-bounded documented exception exists. Never silently suppress or downgrade a finding. |
| OCI publication | Only a verified trusted ref publishes. Registry host/repository are configuration, not workflow logic; GHCR is an optional initial target. Publish immutable revision/release tags and capture their digests. Never publish from a forked pull request. |
| Attest and sign | Attach GitHub provenance/SBOM attestations to the published digest. Optionally keylessly sign the same OCI digest with a documented issuer, repository identity, and identity policy; the verification procedure must work for any OCI registry. |
| Image smoke and release | Pull the published digests, verify attestations/signature according to policy, run non-root/health/admin runtime-config checks with generated ephemeral test secrets, then create a release record/notes only after success. A tag is not a successful release by itself. |

Workflow triggers and concurrency must be explicit:

- Pull requests run unprivileged verification and may cancel superseded runs for the same
  PR. `main`, release tags, manual releases, and publication jobs must not be cancelled
  after an artifact can have been published.
- Cache pnpm using the lockfile and Node version, and BuildKit layers using a key that
  includes Dockerfile/build context, platform, and lockfile. Treat cache hits as
  untrusted acceleration, not provenance; no PR cache may supply a release artifact
  without rebuilding and scanning it on a trusted ref.
- Use least-privilege job-level permissions: verification starts with `contents: read`;
  dependency review receives only pull-request read access; SARIF upload receives only
  `security-events: write`; OCI publication receives `packages: write` only in the
  publish job; release creation receives `contents: write` only in its final job.
  Artifact attestation and keyless signing receive `attestations: write` and
  `id-token: write` only in the jobs that use them.
- OIDC is prohibited by default. Enable GitHub OIDC only for GitHub attestations and/or
  optional keyless signing, with audience, issuer, repository/ref identity, and
  environment protection declared and verified. Registry login uses the registry's
  narrowly scoped publishing credential or OIDC federation only within the publish job;
  never expose it to PR jobs.
- Pin every action, container action, scanner, and reusable workflow to an immutable
  full commit SHA with a documented update/review process (for example, an automated
  dependency-update PR). Replace the current tag references in `ci.yml` as part of this
  work. Action provenance/reputation review is required before each pin update.

## Supply-chain policy

The release gate must produce and retain:

- SPDX or CycloneDX SBOMs for both final images and their application dependencies;
- SLSA-compatible provenance identifying the source revision, builder workflow, build
  inputs, platform, and resulting digest;
- vulnerability reports linked to the scanned immutable digest, remediation/exception
  history, and dependency-review result;
- verification instructions that validate a digest's provenance, SBOM attestation, and
  optional keyless signature before deployment;
- retention rules that keep release digests, attestations, SBOMs, and rollback digests
  together for the supported upgrade window.

No deployment policy may require GHCR-specific signing, metadata APIs, or identity.
Registry-neutral OCI distribution, digest verification, and optional standard keyless
signing are the compatibility baseline. The image must not contain repository credentials,
Git history, `.env` files, test defaults, private keys, or an embedded configuration
endpoint that can disclose server secrets.

## Security, upgrade, rollback, and backup operations

- Publish a threat model for build context, CI token exposure, dependency/action
  compromise, malicious registry tags, image tampering, TLS termination, proxy headers,
  secret files, runtime escape, admin static configuration, and backup theft.
- Require an operator to verify a digest and its approved attestations before first use
  and every upgrade. Images run as non-root; PostgreSQL has separate runtime and
  migration roles; containers get no Docker socket, host networking, privileged mode, or
  broad host mounts.
- Release notes declare image digest, schema compatibility, migration duration/locks,
  resource changes, required configuration keys, data transformations, rollback
  feasibility, and backup/restore requirements. Destructive or non-transactional
  migrations require an explicit reviewed rollout and maintenance procedure.
- Use expand/migrate/contract compatibility. New runtime code must tolerate the previous
  supported schema during rollout; removal occurs only in a later documented release.
  Existing jobs, durable envelopes, leases, immutable configuration versions, opaque
  webhook IDs, and PBI-016 sessions must retain their documented compatibility behavior.
- Application rollback means returning to a previously verified image digest only while
  the forward migration remains compatible. There is no automatic down migration. If a
  migration is incompatible or data is damaged, stop affected services and restore the
  tested backup using the documented recovery procedure rather than running ad hoc SQL.
- Define RPO/RTO assumptions, encrypted backup ownership/retention, PostgreSQL logical
  and/or physical backup method, object-store consistency method, and restore validation.
  Exercise restore into an isolated Compose project at least once per release cadence,
  then run migration/readiness and a bounded durable-work recovery check. Backups and
  their logs may not contain plaintext deployment/application secrets.

## Documentation and operator quickstart

Update `deploy/docker/README.md` and the repository/deployment documentation as part of
implementation. The quickstart must be runnable without a cloud account and must cover:

1. supported Docker/Compose, host OS, disk/RAM, amd64, DNS, and TLS prerequisites;
2. obtaining and verifying a release digest, SBOM/provenance, and optional signature;
3. creating operator-owned secret files with restrictive permissions, configuring the
   intentionally blank public environment example, and validating rendered Compose
   configuration without printing secrets;
4. first install, explicit migration, standalone startup, TLS proxy routing, readiness
   verification, and PBI-016 OIDC/public-origin checks;
5. distributed startup, worker scaling, and the safe standalone/distributed transition;
6. backup, restore drill, upgrade preflight, compatible rollback, failure recovery, logs,
   health endpoints, and support bundle/redaction guidance;
7. registry-neutral image mirroring/air-gapped import guidance, including retention of
   digests and attestations.

Document an explicit operator checklist and troubleshooting table. It must distinguish
public configuration from secret files, state that runtime config is not a place for
browser secrets, and avoid credential-like examples.

## Planned integration changes (future implementation only)

| Surface | Required change and owner boundary |
|---|---|
| `apps/admin` | **PBI-016-owned artifact.** Establish the Vite/static output and runtime public-config schema consumed by the admin image; validate API base URL before rendering; ensure build output contains no secret. PBI-017 owns only the Docker packaging contract after PBI-016 has delivered it. |
| `apps/api` | Preserve `/health/live` and `/health/ready` from `apps/api/src/health.routes.ts`; extend readiness/version/config validation only through API-owned composition. Add PBI-016 admin API/OIDC CORS, CSRF, cookies, allowed-origin, and trusted-proxy behavior before proxy exposure. Do not put these policies in static assets or Docker labels. |
| `apps/standalone` | Supply a process entrypoint and aggregated readiness/shutdown behavior for its API, webhook, scheduler, queue, relay, and worker lifecycles. Preserve the current `createStandaloneRuntime` no-direct-dispatch invariant in `apps/standalone/src/index.ts`. |
| `deploy/docker` | Add the multi-stage Dockerfile, `.dockerignore`, immutable baked entrypoints, static-admin target, production Compose redesign, migration/runtime secret separation, proxy configuration/interface, non-secret environment example, operator helper/tests, and revised quickstart. Keep the disposable test database composition separate from production. |
| `.github/workflows` | Refactor `ci.yml` into least-privilege quality/integration stages or call scoped reusable workflows; add delivery/release workflow(s), action SHA pins, cache/concurrency policy, Docker test, scans, SBOM/provenance, optional signing, OCI publish, published-image smoke test, and release gating. |
| Tests and release records | Add deployment-focused Compose tests and fixtures under a dedicated test-owned path, no live provider calls, plus release metadata/verification documentation. Do not alter root package scripts/manifests unless a separately approved integration owner establishes the needed contract. |

## Module partition and agent workflow

Follow the sequential Architect -> Senior Developer -> Automation Developer pipeline in
`.features/23-implementation-workflow.md`. One module's three roles never overlap, and
the PBI integration owner alone changes shared Compose, workflow, registry, and release
files.

| Module | Architect handoff | Senior Developer owned implementation | Automation Developer validation |
|---|---|---|---|
| A. Release image | Docker build graph, final-file allowlist, user/filesystem policy, metadata/reproducibility invariants, amd64 decision | Dockerfile, `.dockerignore`, command wrappers, image labels, non-root final stages | Rebuild determinism, final-image inventory, non-root/read-only behavior, command and health smoke tests |
| B. Compose and operations | Service/network/volume/secret/proxy model, migration roles, public URL/TLS/trusted-proxy contract, upgrade/restore risks | Production Compose, entrypoint validation, proxy interface, non-secret env example, quickstart, backup/upgrade helpers | Rendered-config checks, secret-redaction tests, standalone/distributed/migration/profile-negative tests, backup/restore drill |
| C. Admin delivery bridge | PBI-016 artifact/runtime-config boundary, same-origin/cookie model, no-browser-secret proof | Admin static image target and Compose service after PBI-016 acceptance | Inspect bundle/config, proxy route/cookie/CORS E2E, no-secret regression checks |
| D. CI and supply chain | Trust boundaries, triggers, permissions, SHA-pinning/update policy, registry-neutral attestation/signing decision, vulnerability policy | Workflows, caches/concurrency, scan/SBOM/provenance/publish/release record implementation | Fork/PR privilege tests, action-pin audit, artifact/digest verification, scan-gate and published-image smoke tests |

The integration owner must resolve PBI-016 API/UI packaging changes before Modules C and
B are finalized, coordinate migration ordering with PBI-002/PBI-016, and report changed
contracts and blocked compatibility decisions. Any architecture-changing decision,
including arm64 publication or a signing policy, receives the durable decision record
required by `.features/11-engineering-standards.md`.

## Acceptance tests

At minimum, automation must add and run these targeted tests using synthetic data and
ephemeral, non-production secrets:

1. Build runtime and admin targets twice from the same revision and verify expected
   deterministic artifacts/labels; inspect final layers for excluded files and confirm
   both images run non-root.
2. Start a fresh Compose deployment, run the migration job once, and prove all services
   reach liveness/readiness through the TLS edge. Verify runtime services cannot start
   against an incompatible/missing schema.
3. Exercise standalone then distributed mode against the retained PostgreSQL volume,
   proving queued envelopes/leases retain PBI-013 semantics and Compose rejects both
   profiles at once.
4. Assert PostgreSQL has no public listener, admin has no database/secret mount, only
   the edge publishes public ports, worker-only egress rules hold, and proxy headers
   cannot forge trusted identity.
5. Test unreadable/malformed/missing secret files, invalid public URLs, contradictory
   profiles, and unavailable dependencies. Assert logs, health responses, and generated
   diagnostics never disclose a secret value.
6. After PBI-016, load the admin SPA through the proxy, validate its public runtime
   config, inspect its build output for no credentials, and execute a cookie/CSRF/CORS/
   trusted-proxy operator smoke journey against the real administration API.
7. Run the existing pnpm quality, unit/contract, and PostgreSQL integration suites plus
   deployment Compose integration tests in CI; retain the existing deterministic-fake
   policy from `.features/22-testing-strategy.md`.
8. On a trusted release candidate, prove the published digest has a valid SBOM,
   provenance, vulnerability gate result, and optional signature; pull that exact digest
   in a clean job and repeat the smoke test. Prove forked PRs cannot publish or access
   release credentials.
9. Restore a backup to an isolated Compose project, migrate/start the documented release,
   verify readiness and a bounded durable-work recovery path, and record the result.

## Acceptance criteria

- [ ] PBI-016 is accepted, including its backend administration APIs, secure session
  model, and documented static artifact/runtime public-config contract; its unresolved
  delivery risks are either closed or explicitly block release.
- [ ] A fresh amd64 Docker build is multi-stage, lockfile-based, reproducible within
  documented tolerances, non-root at runtime, free of build secrets, and labeled with
  source/version metadata.
- [ ] Runtime and admin images are OCI-registry-neutral, published and deployed by
  digest, and do not depend on `latest`, a branch tag, GHCR-specific behavior, or a
  cloud-vendor runtime.
- [ ] The final images contain no source checkout, package cache, test data, secret
  files, credential-like defaults, or browser secret; static admin configuration is
  public, runtime-validated, and separately generated.
- [ ] Production Compose supports exactly one of standalone/distributed mode, an
  explicit successful migration step, a retained database volume, and durable-mode
  behavior compatible with PBI-013.
- [ ] PostgreSQL is isolated from public ingress; the TLS edge is the only public
  listener; admin/API/webhook routes, secure cookies, CORS/CSRF, public URLs, and
  trusted proxy settings are explicit and validated.
- [ ] Network attachments follow least privilege, and connector/provider/repository
  egress is not granted to static admin, scheduler, or webhook by default.
- [ ] Bootstrap secrets use read-only files or supported platform-mounted equivalents;
  migration and runtime database credentials are distinct; no secret is placed in an
  environment example, image layer, command line, browser configuration, log, trace,
  health response, or release artifact.
- [ ] Every long-running service has bounded liveness/readiness semantics appropriate to
  its role; the migration job and proxy fail safely; operators can observe failure
  without sensitive diagnostics.
- [ ] Documentation covers an easy secure install, verification, TLS, admin UI, both
  deployment modes, upgrades, rollback limits, backup/restore, air-gapped mirroring,
  troubleshooting, and amd64 support.
- [ ] GitHub Actions runs quality, test, Docker integration, image build, scan, SBOM,
  provenance, OCI publication, published-image smoke, and release stages with explicit
  triggers, lockfile/build caches, safe concurrency, and minimal job permissions.
- [ ] All actions and reusable workflows are immutable-SHA-pinned; dependency review,
  vulnerability gating, attestation, and optional registry-neutral keyless signing are
  enforced according to documented policy, with OIDC granted only where needed.
- [ ] A release verifies from the published digest and rejects an unverified,
  vulnerable, incorrectly attested, wrong-platform, or unsigned-when-required image.
- [ ] Upgrade compatibility, forward-only migration constraints, rollback limits, and a
  tested backup/restore procedure are documented and exercised.
- [ ] Targeted unit, contract, PostgreSQL integration, Compose deployment, admin
  packaging/E2E, and delivery-workflow tests pass without live AI calls or production
  credentials.

## Migration and compatibility plan

1. Keep the current `compose.production.yml` interfaces temporarily compatible where
   safe: preserve the project/volume identity, `migrate`/`standalone`/`distributed`
   concepts, and documented commands while deprecating the runtime entrypoint bind
   mount. Publish a clear conversion checklist before changing variable names.
2. Introduce image build, command wrappers, readiness, secret-file separation, and
   non-secret environment validation before changing proxy exposure or the admin path.
   Test the new image against an existing initialized PBI-013 database as well as an
   empty database.
3. Land PBI-016's API and SPA contract before adding the admin service. First expose it
   through a same-origin TLS proxy test; only then document a separate admin host, if
   supported, with explicit cookie/CORS settings.
4. Use expand/migrate/contract database releases. Never couple an application image
   rollback to an assumed schema downgrade; retain previous verified image digests and
   take a restore-capable backup before migration.
5. Migrate CI in a non-publishing verification phase first, then enable trusted-registry
   publication, attestations, optional signing, and release gating. Historical image
   tags remain untrusted until rebuilt or explicitly marked outside the new policy.

## References

- `AGENTS.md`
- `.features/03-architecture.md`
- `.features/11-engineering-standards.md`
- `.features/20-persistence-and-database-guide.md`
- `.features/22-testing-strategy.md`
- `.features/23-implementation-workflow.md`
- `.features/25-admin-console-guide.md`
- `temp/pbi/PBI-013-production-operations.md`
- `temp/pbi/PBI-016-react-admin-operator-console.md`
- `deploy/docker/compose.production.yml`
- `deploy/docker/compose.test.yml`
- `deploy/docker/entrypoint.sh`
- `deploy/docker/README.md`
- `apps/api/src/health.routes.ts`
- `apps/standalone/src/index.ts`
- `.github/workflows/ci.yml`
- `package.json`
