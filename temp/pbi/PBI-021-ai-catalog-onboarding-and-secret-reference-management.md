# PBI-021: AI catalog onboarding and shared secret-reference management

## Outcome

Deliver a complete, secure Admin path for configuring and validating a real AI provider
without PostgreSQL edits, CLI-only catalog setup, browser-held credentials, or
provider/model branches in shared UI code. An authorized operator can configure a
provider through its backend descriptor, refresh that provider's server-owned model
inventory, use LiteLLM only as trusted pricing enrichment, configure pricing and budget
policy, create and activate immutable bindings, and run a bounded metered test.

Deliver one clear, cross-cutting **Access & security** location for external secret
reference registration and lifecycle. Connector, provider, webhook, repository, and
other descriptor forms select only redacted reference metadata from that registry. They
do not become secret-management screens.

## State and dependencies

**Completed on 2026-07-30.** This repaired two operator-facing gaps discovered while attempting a local
OpenRouter configuration after PBI-016 and PBI-020:

1. Administration exposes catalog snapshot/model reads but no trusted catalog
   refresh/import command or first-run catalog state. A fresh local installation has no
   selectable models.
2. Binding options currently treat the global LiteLLM catalog as availability. That can
   show models that a configured endpoint does not expose (for example Azure routes for
   an OpenRouter endpoint), while omitting provider-owned models that LiteLLM does not
   list. Availability must come from the active provider version, not price provenance.

PBI-003 owns the model catalog and cost foundation. PBI-016 owns the administration
contracts and console. PBI-020 supplies the active source, analysis, and repository
authoring that consumes immutable bindings. This PBI composes those capabilities; it
does not duplicate their pricing, AI execution, connector, or secret-resolution policy.

## Product and architecture decisions

### Shared secret-reference home

- Reuse the existing **Access** primary navigation area and rename it **Access &
  security**. This avoids adding another top-level destination while giving the
  cross-cutting credential registry an unambiguous home beside workspaces, principals,
  and role assignments.
- Move the register-reference form and registry list to this screen. Remove the duplicate
  registration panels from AI and Integrations.
- Descriptor forms retain an opaque registration selector and a contextual **Manage
  secret references** link. Selecting a reference only supplies a configuration field;
  it cannot rotate, revoke, or delete anything.
- The registry returns safe identity, lifecycle, timestamps, dependency counts, and
  dependency resource labels only. It never returns a locator, a secret value, an
  environment-variable name, an external vault path, or a resolved credential.
- The UI calls the action **Revoke reference**, not delete. Immutable configurations,
  operations, and audit records retain the registration identity. A revoke must be
  blocked with a server-owned dependency/impact result while active configuration still
  relies on it; the operator must first disable or supersede that configuration.
- **Mark rotation required** remains a lifecycle marker, not an attempt by CaseWeaver to
  rotate the deployment's external secret. The UI must say that the operator rotates the
  value in the configured secret backend/environment, then reconciles the reference in
  CaseWeaver. No generic UI may claim it changed a secret value.
- Every registration, registry read, dependency inspection, rotation marker,
  reconciliation, and revocation is workspace-scoped, authorized, idempotent where
  mutating, and server-audited. Sensitive secret-management reads fail closed if their
  audit record cannot persist.

### Trusted catalog import

- The browser may request **Refresh trusted model catalog** but supplies no URL, raw
  bytes, credentials, model names, revision, or hash. A deployment-owned catalog-source
  contribution acquires a configured/pinned source or local release artifact server-side.
- The source adapter must use bounded bytes, HTTPS/host allowlisting when networked,
  cancellation/timeout, typed safe failures, and no credential/raw-catalog logging. It
  resolves the immutable upstream revision before downloading content and records source
  URL identity, commit/revision, fetch time, and SHA-256 through the existing PBI-003
  importer.
- Fetching occurs outside the database transaction. The existing catalog import use case
  atomically records the immutable snapshot, idempotency result, cache invalidation, and
  authoritative audit event. A same-content refresh is an explicit safe no-op rather
  than a duplicate snapshot.
- The screen shows only safe catalog freshness/status metadata: snapshot identity,
  revision, hash, imported time, model count, and a redacted typed failure state. It
  never serves raw upstream JSON to the browser.

### Provider-owned model inventory and trusted pricing

- Add a server-side provider-model-discovery contribution alongside provider runtime
  registrations. It receives an already-resolved credential only in trusted composition,
  calls the provider's metadata endpoint with bounded timeout/response rules, and
  returns only normalized model capability metadata. Shared administration/UI code does
  not branch on provider, model, endpoint, or catalog-source names.
- The OpenAI-compatible adapter implements the standard `/models` discovery protocol.
  When its immutable wire API is `embeddings`, it requests the documented
  `output_modalities=embeddings` inventory filter. This is an adapter protocol choice,
  not an `openrouter` branch in shared code. Other provider adapters may contribute
  their own discovery implementation without a console change.
- Persist a workspace-scoped immutable inventory snapshot tied to the exact active
  provider version. Its safe model projection is the only availability input to the
  typed binding-options query and binding write. A global LiteLLM catalog cannot make a
  model selectable.
- For each discovered canonical model, copy pricing only from an exact trusted LiteLLM
  canonical-name match. Never infer a route/provider equivalence or treat a miss as
  zero. Models without a match remain selectable but hard-budgeted execution is denied
  until an explicit trusted override exists.

## Scope

### 1. Administration contracts, API, and persistence

- Add provider-neutral contracts for catalog source status/refresh, compatible binding
  options, and secret-reference registry/dependency/lifecycle views.
- Add typed, CSRF-protected, idempotent endpoints for trusted catalog refresh, active
  provider inventory refresh, provider-scoped binding options, secret-reference
  dependency inspection, rotation reconciliation, and guarded revocation. Keep existing
  list/detail routes compatible.
- Extend PostgreSQL administration persistence with safe catalog refresh idempotency and
  no-op handling, reference dependency checks, optimistic concurrency where applicable,
  transactional audit writes, and cache invalidation. Add a forward-only migration only
  if durable new state is genuinely required.
- Compose existing `ImportAiCatalogSnapshot`, `CreateAiModelBindingDraft`, pricing,
  budget, and provider-capability-test use cases. Do not implement a second catalog,
  price calculator, budget reservation, or direct provider call in administration code.

### 2. Provider and catalog-source adapters

- Implement a deployment-owned trusted LiteLLM catalog source/artifact adapter and its
  configuration contract. It must be usable by the disposable local Docker deployment
  without browser or database seeding, while production can explicitly select a pinned
  trusted source/artifact.
- Add adapter-owned provider model discovery and enforce the durable provider-version
  inventory mapping before immutable binding persistence. The current OpenAI-compatible
  provider must support a real OpenRouter endpoint through this contribution, not a
  shared `openrouter` conditional.
- Preserve unknown-pricing semantics. A refresh never silently converts unavailable or
  incomplete price information to zero; a hard-budgeted model test remains denied until
  applicable pricing and an active budget are configured.

### 3. Admin experience and operator guidance

- Rename the current **Access** route/menu to **Access & security**, retain its current
  permissions, and make it visible to an authorized credential manager even when that
  operator cannot manage workspace membership.
- Provide a dedicated secret-reference registry with registration, status, safe
  dependency inspection, clear empty/loading/denied/unavailable states, guarded revoke,
  and rotation/reconciliation guidance. Make reference selection status clear in every
  descriptor form and link back to the canonical registry.
- Add a catalog onboarding panel to AI configuration: current status, refresh action,
  safe error/retry state, and a clear ordered setup guide. It must explain why a provider
  test is unavailable until active compatible binding, known pricing, and an applicable
  budget policy exist.
- Filter binding snapshot/model selectors from the active provider's server-provided
  inventory. Explain that a trusted catalog enriches prices but never determines
  endpoint availability; do not expose raw provider/upstream JSON, implementation
  terminology, or a manual model-name text box.
- Keep no-token/no-secret browser guarantees. The frontend stores neither secret
  locators/values nor catalog download data in browser storage, URLs, logs, or errors.

### 4. Documentation and local validation

- Update the main operator runbook and Admin documentation with a first-run provider
  setup: deployment environment variable, `env:UPPERCASE_NAME` locator, secret-reference
  selection, trusted catalog refresh, provider activation, binding, price, budget,
  capability test, collection, and source synchronization.
- Document that PowerShell `$env:NAME` syntax is only for setting a host environment
  variable; `env:NAME` is the CaseWeaver external-secret locator.
- Update every modified folder README to describe the new boundary and source of truth.

## Explicit non-goals

- No browser entry, display, download, rotation, or storage of secret values.
- No direct browser calls to OpenRouter, LiteLLM, a secret backend, PostgreSQL, or an AI
  provider.
- No arbitrary browser-supplied catalog URL, raw JSON, commit, provider label, endpoint,
  or model-name bypass.
- No automatic catalog refresh during model execution and no silent price fallback.
- No physical deletion of immutable secret-reference history or audit records.
- No change to PBI-017 production TLS, backup/restore, scanning, attestation, or OCI
  delivery scope.

## Acceptance criteria

1. On a fresh local Compose database, an authorized administrator can refresh the
   deployment-trusted catalog through Admin and see a bounded safe snapshot/model list.
2. The raw catalog, source credentials, and external secret locators never appear in an
   API response, browser state, URL, log, trace, diagnostic, audit record, or error.
3. An OpenAI-compatible provider configured with the OpenRouter HTTPS base endpoint and
   a registered `env:CASEWEAVER_OPENROUTER_KEY` reference can refresh and select its
   own available models without a shared OpenRouter/model-name branch.
4. A binding can be created and activated only after server-side active-provider-version,
   inventory, wire-API, and role validation. A global-price-catalog model is absent from
   options and is rejected if submitted directly.
5. The existing provider test remains metered, known-price/budget gated, rate-limited,
   timed out, idempotent, and audited; a successful test never returns a credential,
   prompt, or provider response.
6. **Access & security** is the only registration/lifecycle home for secret references.
   Integrations and AI forms can select redacted references and link to that home but do
   not duplicate management controls.
7. Secret-reference selection does not perform a lifecycle action. The dedicated registry
   offers only server-authorized, guarded actions with clear dependency impact.
8. Revocation cannot break active dependent configuration silently. Historical immutable
   configuration and append-only audit identity remain preserved after revocation.
9. All new UI reads, refreshes, selections, mutations, tests, dependency inspections,
   and denied/invalid attempts have server-owned, workspace-scoped audit events.
10. Focused unit, adapter-contract, PostgreSQL integration, API integration, Admin
    component, and critical Compose/Chromium tests cover success, empty catalog,
    incompatible model, malformed/missing environment reference, unknown-price denial,
    cross-workspace access, audit failure, reference dependencies, and browser redaction.

## Delivery modules and mandatory workflow

1. **Architecture/contracts:** Architect reviews existing PBI-003 catalog and PBI-016
   administration contracts, defines catalog-source/compatibility and secret-registry
   interfaces, transaction/audit rules, owned paths, and test matrix. Senior Developer
   implements only approved inward contracts. Automation Developer adds contract and
   negative-path coverage.
2. **Trusted source and persistence:** Architect defines source trust, no-op identity,
   storage, migration, and failure rules. Senior Developer implements the adapter and
   PostgreSQL behavior. Automation Developer validates real PostgreSQL transaction,
   no-op, workspace, and audit behavior with deterministic source fakes.
3. **API and Admin onboarding:** Architect defines typed endpoint/DTO/UI state and
   accessibility behavior. Senior Developer implements API composition and the Admin
   screens. Automation Developer adds API/component/Compose browser coverage, including
   no browser secret/catalog leakage.

The parent/integration agent owns shared registries, API bootstrap, migrations, package
manifests, root documentation, and final validation. Each module follows the mandatory
Architect -> Senior Developer -> Automation Developer sequence in
`START_CODING_PROMPT.md`.

## Definition of done

The PBI is complete only after the real local Docker stack supports the documented
first-run OpenRouter configuration through Admin, a metered model test succeeds under an
explicit small budget, a local Git/Markdown source can use the resulting embedding
binding, and all acceptance validation passes without revealing a secret or requiring a
manual database change.

## Delivery and remaining work

The implementation includes focused provider-discovery adapter, trusted-composition,
application, PostgreSQL transaction, API route, and Admin-component coverage. A
provider inventory is persisted atomically with idempotency, audit, and cache
invalidation, and binding writes independently reject a catalog model that is not in
that exact active provider-version inventory. The disposable stack has successfully
imported the current trusted LiteLLM catalog through the Admin UI, and the local
documentation repository is mounted read-only only in the API and worker containers.

`pnpm test:e2e:compose` now gives this slice a reproducible, isolated Chromium
acceptance journey without any external AI credential. It layers a test-only Compose
fixture over the real local topology, generates an ephemeral private HTTPS certificate,
seeds a small local Git repository, and drives the Admin console through secret-reference
registration, provider activation, provider-owned inventory refresh, immutable
embedding binding/default, explicit pricing and hard budget, metered capability test,
collection, Git connector test, source activation, and manual synchronization. A
read-only test assertion then confirms the durable source run created an active knowledge
document and embedding allocation. The fixture credential and certificate are disposable
test data; neither is an OpenRouter credential or browser-visible secret.

Inactive connector/provider drafts now have a guarded **Remove draft** control. It
creates a terminal immutable `discarded` successor, appends the server-owned audit and
cache-invalidation evidence atomically, suppresses the draft from ordinary lists and
selectors, and never physically deletes configuration history. This deliberately does
not turn every durable operational resource into generic CRUD: active configurations,
secret registrations, collections, jobs, analysis records, and retention/audit evidence
retain their own guarded disable, revoke, retention, or privacy lifecycle because they
may be referenced by immutable work.

The final live acceptance has completed against a deployment-owned OpenRouter key,
without making the key available to Playwright or the browser. It used both immutable
OpenAI-compatible provider modes: chat capability validation and embedding inventory
refresh through the documented embedding-output filter. The browser then selected
provider-owned models, configured non-zero pricing and a hard budget, activated exact
binding versions and role defaults, mounted a real Git/Markdown repository, and
synchronized a single real documentation file. The runner made a read-only PostgreSQL
assertion that the source completed and persisted an active document/revision with an
embedding cache entry and cost allocation. No manual database change was required.

The reusable `pnpm test:e2e:openrouter:local` runner deliberately removes
`CASEWEAVER_OPENROUTER_KEY` from its child environment. Only the already-running API
and worker containers receive the deployment-owned value; test output, browser state,
and the PostgreSQL assertion contain no credential material. The broader documentation
glob is documented as a full import (about 1,600 files), so it can correctly exceed a
small hard budget; the live smoke test uses one real document rather than weakening the
budget policy.

Completed validation:

1. Focused OpenAI-compatible provider discovery and Git trusted-root adapter tests.
2. Full `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm deps:check`, and `pnpm build`.
3. PostgreSQL migrations plus `pnpm test:integration` (136 integration assertions).
4. Isolated `pnpm test:e2e:compose` Chromium acceptance and the real
   `pnpm test:e2e:openrouter:local` provider-and-knowledge journey.

`pnpm run ci` still stops at its initial formatting check because the already-dirty
working tree contains unrelated formatting drift outside this PBI. Its subsequent
typecheck, test, dependency, build, database, and browser validation stages were run
individually and passed as listed above. Remaining PBI-021 work: **none**.

## References

- `AGENTS.md`
- `.features/05-ai-models-and-pricing.md`
- `.features/10-api-mcp-and-future-ui.md`
- `.features/16-ai-execution-guide.md`
- `.features/20-persistence-and-database-guide.md`
- `.features/22-testing-strategy.md`
- `.features/23-implementation-workflow.md`
- `.features/25-admin-console-guide.md`
- `temp/pbi/PBI-003-ai-model-catalog.md`
- `temp/pbi/PBI-016-react-admin-operator-console.md`
- `temp/pbi/PBI-020-repository-assisted-case-analysis.md`
