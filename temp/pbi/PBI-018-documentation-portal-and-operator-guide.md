# PBI-018: Documentation portal and operator guide

## Outcome

Deliver a self-contained, accessible Docusaurus documentation website for CaseWeaver.
It gives an operator or contributor a short, accurate path from understanding the
system to installing it, configuring it, operating it, and validating it. It must
describe the code that is actually delivered, clearly label incomplete capabilities,
and provide a separate, non-promissory view of planned capabilities.

The site is a documentation product, not a second control plane, connector, AI
provider, or deployment mechanism. It is static content and never contains deployment
secrets, instance-specific browser credentials, or live configuration values. It may
identify the deliberate disposable-local password default, but must never show an
operator's overridden password or imply that the default is safe outside a private
local environment.

## State and dependencies

**In progress.** The portal foundation may be delivered independently, but this PBI
cannot be marked complete until the operator-console and release contracts it documents
are accepted. Cloudflare Pages publishing is tracked separately in PBI-019 so hosting
credentials and deployment controls do not expand the website foundation.

Depends on:

- **PBI-013** for the operational, queue, retention, diagnostic, and standalone/
  distributed-mode behavior.
- **PBI-016** for the accepted administration API, local-password/OIDC session model,
  and all configuration workflows exposed in the console.
- **PBI-017** for the production Docker image, TLS-edge, release, upgrade, backup, and
  restore contracts.

PBI-014 (MCP foundation) and PBI-015 (evidence-aware chat) remain deferred. This PBI
documents them only as upcoming capabilities; it must not add setup instructions or
imply that they are available.

## Delivery phases

### Phase 1: Portal foundation

This phase may start before PBI-013, PBI-016, and PBI-017 are complete. It delivers the
self-contained `website/` application, Rekindle-derived CaseWeaver-owned navigation and
footer components, locale scaffolding, local search, strict static build, translation
tooling skeleton, and concise status/architecture/contribution entry pages. It may
document only stable, verified facts and must label all operational instructions as
pending until their owners accept the relevant behavior.

**Phase 1 delivery status: complete in the repository.** The standalone portal, its
independent lockfile, bilingual English/French build, CaseWeaver-owned responsive navigation/footer,
local search, availability pages, and focused source checks are present. The French
locale contains reviewed counterparts of the current English pages, home page, and
navigation. Its CaseWeaver-owned status/manifest command records the exact English
revision after human approval and fails review checks when source material changes; it
does not read a provider credential or make a direct AI call. Phase 2 remains pending
the required accepted contracts.

PBI-019 separately publishes this static artifact to Cloudflare Pages. Phase 1 produces
the build output and repository documentation needed by that workflow, but does not own
Cloudflare credentials, project provisioning, or the production deployment decision.

### Phase 2: Verified operator and developer guide

After the accepted PBI-013, PBI-016, and PBI-017 contracts are available, complete the
task-oriented quick start, authentication, configuration, self-hosting, operations,
backup/recovery, testing, and troubleshooting pages. Repeat the current-state audit
before each claim and replace Phase-1 availability placeholders with verified guidance.

## Current-state audit and documentation rules

The implementer must repeat this audit against the delivery branch before writing a
claim. Current code, accepted feature specifications, and tests are authoritative in
that order for what can be run; an older PBI is context, not evidence that a feature is
complete. When they differ, correct the documentation source and record the resolved
decision in the delivery report.

| Area | Current evidence to explain | Required documentation treatment |
|---|---|---|
| Core workflow | `apps/api`, `apps/webhook`, `apps/scheduler`, `apps/worker`, and `apps/standalone` implement the thin-ingress/durable-queue/worker model. PostgreSQL is the system of record, pgvector/full-text store, and initial queue backend. | Explain the path from a synchronization, webhook, or manual request through the outbox/queue/worker to durable results. Explain why standalone and distributed modes retain the same queue, leases, and handlers. |
| Sources and destinations | `connectors/git-markdown` is a Git/Markdown and Docusaurus-convention knowledge source. `connectors/jitbit` implements knowledge source, case source, and analysis destination capabilities. | Document only their validated settings and capability limits. Explain that a source, destination, schedule, analysis profile, and publication profile are separate configuration concepts. |
| AI | `packages/ai-config` owns immutable bindings/pricing, and `packages/ai-execution` is the exclusive metered/budgeted invocation path. The shipped descriptors cover OpenAI-compatible embedding/vision/analysis/chat and optional Copilot SDK BYOK repository-agent use. | Explain roles, immutable versions, cost/budget enforcement, secret references, and bounded tests. Do not promise a model, price catalog, provider, or repository-runtime setup that is not registered in the running deployment. |
| Administration authentication | `apps/admin`, `apps/api/src/modules/auth`, and `apps/api/src/modules/administration` provide a deployment-owned local login/password path plus optional API-managed OIDC/PKCE, cookie session, descriptor, secret-reference, draft, audit, and operational surfaces described by PBI-016. Some resource-specific management workflows remain incomplete. | Mark each UI task as available, read-only, draft-only, or unavailable according to the accepted PBI-016 implementation. Document password and OIDC choices as deployment configuration, not console configuration. The browser never receives a provider token, secret, database URL, or authorization decision. |
| Docker and persistence | `compose.test.yml` is a disposable PostgreSQL/pgvector test database. `compose.admin.yml` is a loopback-only local static-admin bridge. The tracked `compose.production.yml` preserves the production topology concept but PBI-017 has not yet delivered its release image, TLS edge, backup/restore, or release contract. | Before PBI-017 is accepted, present only the test database and local admin bridge as development aids; explicitly state that they are not a supported production installation. After acceptance, replace the provisional material with the PBI-017 operator path. |
| Deferred and future work | MCP, evidence-aware chat, remaining console workflows, and Docker-first release delivery have separate backlog records. | Maintain a dated capability-status/roadmap page. Use capability names in the public site, not PBI numbers, and never place non-existent CLI commands, routes, configuration keys, or screenshots in a how-to page. |

Every task page must state its availability, prerequisites, whether a value belongs to
deployment configuration or the console, the expected safe outcome, and the next place
to look when it fails. Keep the prose short and procedural; link to deeper reference
material instead of duplicating it.

## Scope

### 1. Docusaurus portal

Create a self-contained TypeScript Docusaurus site under `website/`. It has its own
`package.json`, pinned lockfile, `README.md`, `docs/`, `src/`, `static/`, `i18n/`, and
authoring scripts. The site is an independently buildable static artifact; it does not
import CaseWeaver runtime packages, connect to PostgreSQL, call the API at render time,
or require an application secret to build.

Use the repository's Node and pnpm baseline. The initial site commands must be explicit
and work from the repository root, for example `pnpm --dir website install`, `start`,
`typecheck`, `test`, and `build`. Do not add it to the root workspace, root scripts, or
CI registry without coordination with the PBI-001 owner, who owns root toolchain and
composition conventions. A later integration may choose to register those commands
after the standalone site contract is accepted.

Configure Docusaurus to:

- fail its production build on broken internal links, invalid anchors, or invalid MDX;
- use an explicit sidebar and a local, static documentation search index;
- produce a static `build/` directory suitable for any ordinary static host;
- expose a credential-free site URL/base URL through build configuration only;
- have no analytics, cookies, external identity provider, remote search dependency, or
  runtime environment endpoint by default; and
- include an English canonical site plus French locale scaffolding.

The portal's own deployment guide may explain how to serve the static `build/` output.
Cloudflare Pages publication is owned by PBI-019; adding a CaseWeaver release image or
coupling the site to an application deployment remains excluded from this PBI.

### 2. Rekindle design and translation reuse

Use `C:\GIT\ReKindle\Website` as the source reference for the Docusaurus presentation
and translation workflow. Reuse the implementation approach, not Rekindle branding,
application URLs, shared-package imports, credentials, content, or deployment
configuration.

Start the CaseWeaver navbar and footer from these Rekindle sources, then copy and adapt
them into CaseWeaver-owned components and styles:

- `Website/src/theme/Navbar/index.tsx` and `styles.module.css`;
- `Website/src/theme/Footer/index.tsx` and `styles.module.css`;
- the responsive mobile-sidebar behavior used by the navbar; and
- `Website/src/components/LanguageBanner.tsx`, `src/utils/languageDetection.ts`, and
  `src/theme/Root.tsx` where the locale suggestion is retained.

The adapted components must be self-contained. Replace `@rekindle/shared` imports with
CaseWeaver-owned logo, palette, locale metadata, and configuration modules; replace
Rekindle's app, pricing, legal, status, and child-safety links with CaseWeaver links
that actually exist. The header must provide the CaseWeaver home/docs path, search,
locale chooser, and a repository link. The footer must provide documentation,
architecture, operations, roadmap/status, source repository, and license links. Keep
the responsive touch targets, keyboard navigation, accessible names, mobile sidebar,
and light/dark behavior intentional rather than inheriting unused CSS.

Adapt Rekindle's `scripts/translate-docs/`, `generate-translations.js`, and
`copy-docs-for-translation.js` workflow for CaseWeaver. Preserve its useful properties:

- Docusaurus i18n skeleton generation and canonical English source;
- Markdown/MDX and UI-JSON discovery;
- content hashes so unchanged source is not retranslated;
- preservation of front matter, code fences, inline code, URLs, anchors, HTML/MDX
  structure, and Docusaurus admonition directives; and
- dry-run, locale, file, force, content-type, and verbose authoring options.

Translation is an opt-in authoring operation, never part of `start`, `build`, tests, or
the browser. It must have no fallback API key, no access to another repository's `.env`,
and no direct Groq, OpenAI, or other provider SDK call. If AI translation is retained,
coordinate the smallest additive `documentationTranslation` binding/role contract with
the PBI-003 owner and send every invocation through `@caseweaver/ai-execution`, with a
known-price hard budget, usage ledger, timeout, redaction, and explicit opt-in secret
resolution. If that approved binding is absent, the command must fail with safe setup
instructions rather than silently calling a provider. Machine translations are review
candidates: a human must review each changed localized document before publication.

Only non-sensitive locale preference/dismissal state may be stored in browser storage.
Use CaseWeaver-specific storage keys and do not store identity, configuration, source
content, prompts, or credentials.

### 3. Documentation information architecture

Write the following concise, task-oriented pages in English, then create and maintain
their French counterparts through the translation workflow. Do not copy `.features` or
PBIs wholesale; translate their accepted behavior into operator-facing language and
link to the deeper specification where useful.

| Section | Required pages and content |
|---|---|
| Welcome | What CaseWeaver is and is not; support-case investigation lifecycle; terminology; component/topology diagram; security, evidence, cost, and vendor-neutrality principles; capability-status legend. |
| Quick start and local development | Prerequisites (Node, Corepack, pnpm, Docker/Compose); clone/install; disposable PostgreSQL/pgvector startup; migration; API and admin bridge start; health check; cleanup. Document the deliberately low-assurance local password sign-in and how to override it before sharing a private UI. Clearly label OIDC-dependent actions and use no real secret values. |
| Administration authentication | Document the default deployment-owned local login/password path: `ADMIN_LOGIN` and `ADMIN_PASSWORD` default to `admin` / `admin`, are overridable through deployment/Compose environment only, and must be changed before the UI is exposed beyond its private local edge. Explain that the password is never returned by the API, retained by the browser, or configured through a console form. Document optional OIDC prerequisites—standards-compliant client, callback URL, trusted HTTPS origin/proxy, issuer/client/session/bootstrap configuration—and first OIDC administrator bootstrap/removal. Explain that complete OIDC configuration adds an OIDC choice without disabling password login; `ADMIN_DISABLE_LOGIN_AUTHENTICATION=true` is valid only with complete OIDC configuration and forces OIDC-only access. Cover login, logout, workspace selection, roles, cookie/CSRF behavior, and common safe failure messages. OIDC is deployment-owned and is never configured with a browser token or through a generic UI form. |
| Sources, knowledge, destinations, and schedules | Conceptual distinction between connector instance, external secret reference, knowledge collection, source, source version, schedule, analysis profile, publication profile, and destination. Include a capability matrix and a short setup page for every connector registered on the delivery branch. The initial pages cover Git/Markdown as a knowledge/attachment source and Jitbit as a knowledge, case, attachment, and analysis-destination connector. They include the verified Git/Markdown remote and mounted-repository examples, and the Jitbit source-to-internal-note-publication example defined below. Explain safe refs, roots, filters, Docusaurus mapping, registered token references, ingestion settings, delta/overlap behavior, and internal-note publication semantics. Include the source synchronization, analysis, evidence-review, approval, and publication flows. Mark unavailable UI workflows until PBI-016 delivers them. |
| AI configuration and cost | Register redacted secret-reference metadata; configure the OpenAI-compatible or optional Copilot SDK BYOK descriptor using only supported HTTPS endpoints; explain provider/model/binding/profile separation, model-role selection, immutable activation/history, catalog/pricing, unknown-price behavior, budgets, capability tests, usage/cost queries, and repository-agent restrictions. State that the UI does not expose an API key and no feature calls a provider outside `ai-execution`. |
| Operations and self-hosting | Docker-first installation after PBI-017: digest verification, secret-file setup, explicit migration, TLS edge/public origins, local-password and OIDC UI paths, standalone versus distributed mode, readiness/liveness, logs/diagnostics, worker scaling, and mode transition. Include a distinct development-only page for `compose.test.yml` and `compose.admin.yml`; it must not be confused with a production deployment. |
| Configuration reference | A single searchable variable/reference table generated or manually verified from final configuration validators, Compose files, and entrypoints. For each key state purpose, consumer, required/default/conditional status, valid form, public-versus-secret classification, and where it is supplied. Cover local admin authentication (`ADMIN_LOGIN`, `ADMIN_PASSWORD`, and `ADMIN_DISABLE_LOGIN_AUTHENTICATION`), API/OIDC, CLI, OpenTelemetry, production Compose/release, PostgreSQL, local admin bridge, test/integration flags, and each port/image/secret-file variable. Explain that the first two are deployment secrets when overridden, and that disabling password login requires complete OIDC configuration. Never show a secret, production connection string, copied token, or credential-like placeholder. |
| Data persistence, backup, upgrade, and recovery | Explain the PostgreSQL/pgvector system of record, durable queue/outbox/lease state, named database volume retention, optional object-storage relationship, what is and is not safe to delete, PBI-017 backup/restore drill, forward-only migrations, compatible rollback limits, and the supported recovery path. Explicitly distinguish the disposable test volume from production state. |
| Testing and contribution | Map unit, contract, PostgreSQL integration, and critical browser/E2E layers to the real root commands; show prerequisites/environment for integration and E2E tests; explain deterministic fakes, opt-in budget-limited live AI tests, and cleanup. Include format, lint, dependency-boundary, typecheck, build, test, contract, integration, and E2E commands only after verifying them against `package.json`. |
| Reference and troubleshooting | Architecture/package responsibilities; connector/provider extension boundaries; health/readiness, errors, safe diagnostic export, privacy/retention, glossary, FAQs, and a troubleshooting table that never advises bypassing OIDC, disabling authorization, deleting a production volume, running ad hoc destructive SQL, or placing secrets in logs/environment examples. |
| Roadmap | A named capability-status page for deferred MCP, evidence-aware chat, remaining administration workflows, Docker-first delivery, and other future work. It must say what users can do today, what is planned, and where to follow progress without treating a backlog item as a committed public API. |

Pages that describe the console must use the final server-rendered resource and action
names, permission states, and availability behavior. A screenshot or click path is not
an authority: verify it against the corresponding API route, DTO, descriptor, and
browser test before publishing it.

### 4. Connector setup guides and worked examples

The connector section must begin with a capability matrix. For every connector registered
on the delivery branch, it identifies its supported source and destination capabilities,
what each capability is used for, its required settings and secret references, and links
to its setup, test, synchronization, and troubleshooting pages. A destination must not
be described as a source, or vice versa: a connector instance, knowledge source, case
source, source-version filter, schedule, analysis profile, publication profile, and
destination are separately created and selected configuration records.

Every connector guide must give a short, end-to-end procedure: prerequisites; where the
value is supplied (deployment or console); configuration values and their safe forms;
a connection test; creation of the applicable source or destination; the expected safe
outcome; and the bounded recovery path. Examples may use `*.example.test` URLs and
non-secret names only. They must never contain a token, a credential-bearing URL, a real
operator's filesystem layout, a browser-computer path, or a command that changes an
external system merely to demonstrate the setup. Generic runtime paths are permitted
only where a mounted-repository example needs them.

The initial Git/Markdown and Jitbit pages must contain these reviewed worked examples.
The prose stays task-oriented, but the settings snippets must be complete enough for an
operator to recognize the final descriptor fields and their relationship.

#### Git/Markdown knowledge and attachment source

- Explain that Git/Markdown is a knowledge and attachment source only; it is not a case
  source or an analysis-publication destination. A Git clone URL is not the source-link
  base URL, and an optional `browserUrl` supplies only links back to source content.
- Include a **remote HTTPS repository** example. It configures a credential-free
  `repository` such as `{"kind":"remote","url":"https://github.com/example/support-docs.git"}`,
  an empty `allowedLocalRoots`, a safe `ref` such as
  `{"kind":"branch","name":"main"}`, relative POSIX `paths.include` and
  `paths.exclude` patterns, and a bounded document-character limit. It shows a
  registered external `gitTokenReference` only as an optional selection for a private
  repository, never as part of the URL or example value. The guide explains that the
  URL is HTTPS-only and cannot contain a username, password, query, or fragment, and
  that each synchronization records the immutable commit reached by a moving branch or
  tag.
- Include a **mounted local Git working tree** example. It first shows, using the final
  PBI-017 Compose or deployment contract, a read-only mount of a host directory that
  contains a complete Git working tree (including its `.git` metadata) into every
  runtime process that opens the source. It then configures the *container/runtime*
  paths, for example an `allowedLocalRoots` entry of
  `/srv/caseweaver/repositories` and a local repository path of
  `/srv/caseweaver/repositories/support-docs`; it must not show the operator's browser
  path. The final rendered sample must use the exact service names and mount syntax
  accepted by PBI-017. Explain that both paths must already exist, resolve
  canonically, and keep the repository inside the allowed root (including after symlink
  resolution); local repositories cannot use a Git token reference. State whether the
  final standalone and distributed deployment profiles require the same mount in the
  worker, API, or both, based on accepted runtime composition.
- In each Git example, show how the operator creates the knowledge source and schedule
  after the connector instance passes its non-destructive test, and the expected result:
  only selected Markdown/MDX is indexed, provenance links identify repository, exact
  commit, relative path, and heading, and unchanged blobs avoid repeat processing.
  Include a Docusaurus variant that clearly separates `siteUrl`, `baseUrl`,
  `routeBasePath`, and `docsPath`, and only enables it for a Docusaurus repository.
- Include focused failure guidance for an unreachable HTTPS repository, missing or
  out-of-root mount, unsafe ref/path pattern, missing private-repository secret
  reference, and a Git directory whose runtime user cannot read. It must recommend
  correcting the descriptor or deployment mount and rerunning the bounded connector
  test, not broadening allowed roots or placing credentials in configuration.

#### Jitbit knowledge, case, attachment, and analysis destination

- Explain, with a capability diagram or ordered flow, that the same Jitbit connector
  instance can support a resolved-case knowledge source, a live case source and its
  attachments, and an analysis destination, but configuring one does not automatically
  create or enable the others.
- Include a **Jitbit source-to-publication** example: register an external API-token
  reference; create a connector instance with an HTTPS installation `baseUrl` (not a
  ticket URL and never credentials), the selected token reference, request timeout,
  discovery page size, and document/ticket bound; run the bounded connection test; then
  create a resolved-case knowledge source and its schedule. The example documents the
  optional first-import `initialUpdatedFrom` date, the default one-day
  `updatedFromOverlapDays` protection for date-granular updates, and the default
  resolved/closed-only source filter. It must make clear that the durable cursor takes
  over after a completed synchronization and that the filter is source-version policy,
  not a connector-wide setting.
- Continue the same example through creation of the Jitbit case source, an analysis
  profile, a publication profile selecting the Jitbit analysis destination, and the
  applicable approval policy. State the expected result precisely: CaseWeaver publishes
  only an approved **internal** Jitbit comment with its stable marker; it does not
  publish a customer-visible reply, choose an approval policy, or rerun analysis. A
  timeout after a possible write becomes an outcome requiring reconciliation before
  another write.
- Include focused failure guidance for a non-HTTPS or credential-bearing base URL,
  absent/unresolvable token reference, failed connector test, an initial-date import
  that omits expected older cases, and an unsupported customer-visible publication
  request. The recovery steps must preserve the immutable configuration and audit trail;
  they must never advise pasting a token into the console, URL, or logs.

When an accepted connector adds, removes, or materially changes a capability or
descriptor field, update its matrix row, example, configuration reference, and French
counterpart in the same documentation change. A new connector cannot be shown as
operator-configurable until its equivalent guide and non-destructive validation path
exist.

### 5. Deployment, OAuth, configuration, and persistence accuracy

The documentation must make these boundaries unmistakable:

- Deployment configuration supplies API host/port/database, local password login
  (`ADMIN_LOGIN` and `ADMIN_PASSWORD`), the local-login disable switch
  (`ADMIN_DISABLE_LOGIN_AUTHENTICATION`), OIDC issuer/client/callback, ephemeral
  session-encryption key, allowed admin origins, trusted proxies, first-admin bootstrap,
  release image/digest, Compose ports, telemetry, and secret-file locations. The final
  variable table must verify exact names, defaults, conditional rules, and the required
  `ADMIN_ALLOWED_ORIGINS` boundary against `apps/api/src/config.ts`,
  `apps/cli/src/config.ts`, final PBI-017 Compose/entrypoint files, and runtime
  validation tests.
- The console supplies only authorized, audited, workspace-scoped feature configuration.
  It registers opaque external secret references and selects their redacted
  registrations; it never accepts or returns database passwords, OIDC client secrets,
  connector tokens, or provider keys.
- OIDC setup instructions must require an HTTPS callback ending in `/v1/auth/callback`
  outside explicit localhost development, an allowlisted UI origin, and a stable
  subject for the one-time bootstrap. They must explain that a TLS proxy terminates TLS
  for the current local API process and that forwarding headers are honored only from
  configured trusted CIDRs. They must also explain that all required OIDC variables
  must be present together; otherwise only the local password path is available. When
  OIDC is complete it is an additional option unless
  `ADMIN_DISABLE_LOGIN_AUTHENTICATION=true` is deliberately set.
- The production Docker guide must require explicit forward migration before runtime
  startup, a retained PostgreSQL volume across standalone/distributed transitions, and
  a backup before an upgrade. It must never prescribe `docker compose down -v` or test
  database credentials for production data.
- Test instructions must make `DATABASE_URL` and `PG_BOSS_INTEGRATION=1` test-only
  prerequisites where applicable, use the disposable database URL only for databases
  whose name is clearly test-scoped, and clean up test state explicitly.

Where PBI-017 changes an existing variable or Compose interface, replace outdated
material in one documentation change and publish an upgrade note. Do not leave two
apparently supported setup paths with contradictory security requirements.

## Ownership and integration boundaries

| Surface | Ownership for this PBI |
|---|---|
| `website/` | PBI-018 owns the Docusaurus application, content, self-contained branding, locale resources, translation tooling, site tests, and authoring README. |
| Root `README.md` and documentation links | PBI-018 may replace duplicated how-to material with concise accurate entry points to the portal, while retaining a short repository overview and developer bootstrap. |
| PBI-003 AI contracts | Coordinate before adding an AI-backed translation binding. PBI-018 does not add a direct provider client, pricing shortcut, or secret path. |
| `apps/admin`, `apps/api`, configuration DTOs, descriptors | PBI-016 owns behavior. PBI-018 reads the accepted implementation and documents it; it does not add a UI/API shortcut merely to make a guide possible. |
| `deploy/docker`, release workflows, deployment contracts | PBI-017 owns application behavior. PBI-018 documents the accepted operator contract and reports any missing documentation contract rather than modifying Docker behavior. |
| Cloudflare Pages publication | PBI-019 owns the vendor-specific static-site publishing workflow and its setup guide. PBI-018 produces a standalone static artifact but does not handle Cloudflare credentials, project provisioning, or deployment approval. |
| Root workspace, root scripts, CI registration | PBI-001/integration owner owns toolchain and registries. Coordinate a proposed change after the independent `website/` build contract passes. |

Do not create a `common`, `shared`, or `utils` dumping ground. Website-specific helpers
remain in capability-named folders such as `website/src/localization` or
`website/scripts/translate-docs`. The site must not become a production runtime
dependency of applications or packages.

## Validation and acceptance criteria

- [ ] A new contributor can follow the English quick start from a clean checkout to a
  disposable migrated database, API/admin development path, and documented cleanup,
  without a cloud account or an unstated prerequisite.
- [ ] The Docusaurus site builds as a standalone static artifact with strict TypeScript,
  no broken links/anchors/MDX, local search, an explicit sidebar, and no required
  runtime secret or API connection.
- [ ] The CaseWeaver header, footer, mobile navigation, search, locale selector, and
  locale-suggestion behavior are self-contained adaptations of the specified Rekindle
  components, correctly branded and keyboard/mobile accessible, with no Rekindle
  source import, URL, storage key, credential, or design-only link remaining.
- [ ] English and French locale scaffolding is present.
  Translation tooling preserves code, URLs, anchors, front matter, MDX/HTML, and
  admonitions; hash/no-change, dry-run, failure, and locale-selection behavior have
  focused deterministic tests. Normal site CI never invokes a live model.
- [ ] Any AI-backed translation call uses an approved immutable CaseWeaver binding via
  `@caseweaver/ai-execution`, with explicit opt-in, known-price budget enforcement,
  usage capture, redaction, timeout, and human review. No direct provider SDK/API key
  path, foreign `.env` fallback, or browser translation call exists.
- [ ] The architecture and workflow pages accurately explain connector-neutral input,
  durable queue/outbox processing, worker execution, evidence, publication,
  PostgreSQL/pgvector, object storage, and standalone/distributed behavior without
  vendor-specific core claims.
- [ ] Authentication documentation separates deployment bootstrap from console use and
  correctly explains the local `admin` / `admin` development default, `ADMIN_LOGIN`,
  `ADMIN_PASSWORD`, `ADMIN_DISABLE_LOGIN_AUTHENTICATION`, OAuth/OIDC callback/origin/
  proxy/session/CSRF/first-administrator behavior, and the condition for OAuth-only
  mode. It requires replacing the local default before any non-private use and never
  recommends storing an overridden password, token, client secret, or connector/
  provider secret in the browser, a URL, an environment example, or a documentation
  file.
- [ ] The connector capability matrix and a short setup/test/recovery guide exist for
  every connector registered on the delivery branch. They match final descriptors,
  schemas, API behavior, and permission states; incomplete workflows are visibly
  unavailable rather than represented by invented instructions.
- [ ] The Git/Markdown guide contains reviewed, runnable remote-HTTPS and read-only
  mounted-local-working-tree examples. The latter shows the verified deployment mount
  and the matching runtime `allowedLocalRoots` and repository paths; both examples
  cover safe ref/path filtering, optional external token selection, creation of the
  knowledge source/schedule, expected provenance, and bounded failure recovery.
- [ ] The Jitbit guide contains a reviewed source-to-publication example that separately
  creates and tests the connector, resolved knowledge source/schedule, case source,
  analysis profile, publication profile, and Jitbit destination. It documents cursor/
  overlap and source-filter behavior and proves that publication is approval-gated,
  internal-only, marker-idempotent, and reconciled after an uncertain write.
- [ ] Connector examples contain only safe illustrative values and registered secret
  references, never secret values, credential-bearing URLs, operator workstation paths,
  or unverified service/mount syntax.
- [ ] The deployment guide accurately distinguishes the disposable test database and
  local static-admin bridge from the accepted PBI-017 production installation. The
  production guide covers digest verification, secret files, migration, TLS, local
  password versus OAuth-only access, readiness, both runtime modes, persistence,
  backup/restore, upgrade, rollback limits, and troubleshooting.
- [ ] The variable reference is complete and traceable to final validators/Compose/
  entrypoint code. It has been reviewed against automated configuration tests and
  contains no secret value, production credential-like example, or unsafe command.
- [ ] The testing guide maps to real commands for formatting, linting, dependency
  boundaries, typecheck, build, unit/contract tests, PostgreSQL integration, and
  browser/E2E tests, including their safe database and deterministic-fake prerequisites.
- [ ] The roadmap/status page describes deferred and planned capability names separately
  from supported instructions and is reviewed whenever a referenced delivery item
  changes state.
- [ ] Targeted site/component/translation tests, site typecheck, and production build
  pass. Existing CaseWeaver quality, contract, integration, and E2E checks continue to
  pass without live AI calls or production credentials.

## Excluded

- Implementing PBI-014, PBI-015, remaining PBI-016 workflows, or PBI-017 release/Docker
  behavior as a documentation shortcut.
- A website login, server-side rendering service, direct access to CaseWeaver data,
  documentation chatbot, analytics platform, or runtime configuration API.
- Cloudflare Pages project provisioning or deployment execution; PBI-019 owns the
  publishing workflow and the repository configuration contract.
- A GitHub Pages or other vendor-specific hosting choice outside the PBI-019 Cloudflare
  Pages path.
- Publishing machine translations without review, translating secrets/configuration
  values, or using a live AI provider in normal documentation tests.

## References

- `AGENTS.md`
- `.features/01-product-and-scope.md` through `.features/12-roadmap.md`
- `.features/16-ai-execution-guide.md`
- `.features/20-persistence-and-database-guide.md`
- `.features/22-testing-strategy.md`
- `.features/23-implementation-workflow.md`
- `.features/25-admin-console-guide.md`
- `README.md`
- `apps/admin/README.md`, `apps/api/README.md`, `apps/standalone/README.md`
- `connectors/git-markdown/README.md`, `connectors/jitbit/README.md`
- `providers/openai-compatible/README.md`, `providers/copilot-sdk-agent/README.md`
- `packages/ai-config/README.md`, `packages/ai-execution/README.md`,
  `packages/administration/README.md`
- `infrastructure/postgres/README.md`, `infrastructure/queue-postgres/README.md`
- `deploy/docker/README.md`, `deploy/docker/compose.test.yml`, and final PBI-017
  deployment assets
- `temp/pbi/PBI-013-production-operations.md`
- `temp/pbi/PBI-016-react-admin-operator-console.md`
- `temp/pbi/PBI-017-docker-first-self-hosting-and-delivery.md`
- `C:\GIT\ReKindle\Website\docusaurus.config.ts`
- `C:\GIT\ReKindle\Website\src\theme\Navbar\`
- `C:\GIT\ReKindle\Website\src\theme\Footer\`
- `C:\GIT\ReKindle\Website\scripts\translate-docs\README.md`
