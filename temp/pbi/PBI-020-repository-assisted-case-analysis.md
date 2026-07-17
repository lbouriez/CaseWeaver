# PBI-020: Repository-assisted case analysis and attachment intelligence

## Outcome

Deliver a complete, provider-neutral automated support-analysis workflow. An
administrator can configure a case source, resolved-case knowledge ingestion, a single
code repository for an analysis recipe, attachment handling, retrieval, an analysis
binding, a publication profile, and a polling or verified-webhook trigger. CaseWeaver
then captures an immutable case snapshot, reuses processed attachment derivatives,
retrieves knowledge, investigates one exact repository commit through a replaceable
repository-agent runtime, stores the governed analysis record, and immediately posts an
internal result to the configured destination.

GitHub Copilot SDK BYOK is the first `RepositoryAgentProvider`, not a product or core
dependency. A different agent runtime must be substitutable behind the same port
without changing analysis orchestration, configuration semantics, or the administration
console.

## State and dependencies

**Completed.** This PBI delivers the repository-analysis and live-attachment vertical
slice. It incorporates and validates the remaining production acceptance work of
PBI-010, while composing rather than duplicating the established PBI-011/PBI-012/PBI-013
use cases.

Depends on the established contracts from PBI-003, PBI-006, PBI-008, PBI-009,
PBI-011, PBI-012, PBI-013, and PBI-016. Its pinned-checkout, sandbox, and provider
acceptance criteria are validated end to end by this delivery.

## Product decisions

- Phase one supports **one code repository per analysis recipe**. The repository-agent
  interface remains provider-neutral so a future runtime can add another policy without
  making the core or UI Copilot-specific.
- Analysis publication defaults to immediate internal publication. The durable
  publication receipt stores a connector-neutral `externalPublicationId`; Jitbit maps
  that value to its `commentId`. Other future destinations need not have comments.
- Retained analysis records store the exact immutable profile/binding/snapshot/evidence
  identities, rendered prompt/context and output under governed workspace retention,
  and the publication receipt. Raw prompts, source content, attachment bytes, tool
  transcripts, and result text never enter logs, traces, diagnostics, URLs, browser
  storage, or audit payloads; authorized inspection follows data-retention policy.
- The same content-addressed attachment pipeline serves knowledge ingestion and case
  analysis. An image with the same content and derivative identity is visioned once
  per workspace/access policy, then its persisted derivative is reused by embedding and
  analysis.
- Jitbit resolved-case knowledge ingestion must expose a connector-owned
  `resolvedOrClosedOnly` filter, defaulting to enabled. Open cases are not embedded as
  historical knowledge unless an administrator deliberately changes that connector
  filter.
- Markdown and case content may reference repository-relative files or public web
  images. Public web fetches are non-blocking: failures become visible typed warnings.
  They remain server-side, bounded, HTTPS-only, redirect-limited, DNS/IP screened,
  credential-free, and protected against private-network/metadata-service access.
- A repository can be deployment-mounted or CaseWeaver-managed from a credential-free
  HTTPS Git URL plus an external secret reference. Deployment-mounted paths are selected
  from deployment-approved aliases; the browser never sends a server path. Remote
  fetches resolve the chosen ref on every run to a full commit SHA using a bounded
  server-side mirror/cache, then materialize an isolated read-only worktree.
- CaseWeaver retains the existing structured Pino/OpenTelemetry boundary. Sentry is an
  optional production error/trace sink configured from deployment, with conservative
  sampling and explicit event scrubbing. It is not a second application logger and
  never receives raw prompts, model responses, attachment content, credentials,
  cookies, authorization headers, URLs, local paths, or external-secret locators.

## Scope

### Repository Analysis administration and execution

- Add a **Repository Analysis** navigation area with `Code repositories` and
  `Execution policies`/`repository runtime profiles`; use human-facing labels rather
  than exposing implementation-only runtime terminology as the primary UI concept.
- Author immutable, workspace-scoped code-repository and execution-policy versions.
  Configuration includes repository mode, display metadata, allowed ref policy,
  external checkout-secret-reference registration when required, checkout limits, tool
  allowlist, sandbox image/policy identity, and run/cost limits. No secret value,
  locator, server path, remote URL, source tree, or checkout error reaches a public
  read model.
- Support a bounded, non-destructive repository connection/ref-resolution test with
  server-issued confirmation, idempotency, known cost policy where applicable, and
  atomic audit records.
- Implement remote HTTPS checkout brokering in the repository infrastructure. It must
  fetch through a private bare cache, use credentials only through ephemeral AskPass or
  equivalent process-private input, resolve an exact full commit, remove Git remote/
  credential state from the prepared tree, and fail closed on symlinks, submodules,
  non-regular blobs, oversized/non-text files, untrusted paths, cancellation, or
  unavailable sandbox attestation.
- Keep deployment-owned sandbox host/root mapping read-only in the console. The worker
  creates one disposable, read-only, networkless sandbox per repository-agent run and
  validates paths, line ranges, and excerpt hashes against the exact prepared commit.
  The agent/provider receives an opaque pinned runtime and bounded read-only tool
  gateway only: it never receives a remote URL, checkout locator, credential reference,
  prepared-tree path, or filesystem handle. The runtime—not model output—calculates
  deterministic evidence IDs and exact normalized excerpt hashes.

### Analysis recipes and durable result/publishing records

- Add immutable **Analysis recipe** authoring to Knowledge & Analysis. A recipe selects
  retrieval/collection policy, prompt profile, attachment policy, analysis and optional
  repository-agent bindings, exactly one repository execution policy, budgets, output
  schema, and publication profile.
- Add API, administration contracts, PostgreSQL persistence, optimistic concurrency,
  history, lifecycle, permission, cache invalidation, and descriptor/read-model support
  for code repositories, execution policies, analysis recipes, and case-analysis
  triggers. Existing jobs must retain exact immutable references.
- Extend the existing analysis/publication persistence contract to retain governed
  prompt/context identity and content, structured result, analysis/evidence links, and
  an idempotent publication receipt. The receipt is connector-neutral and includes
  Jitbit's remote comment ID when Jitbit publishes.
- Make the repository investigation output usable by the final structured analysis:
  validated file/line evidence and bounded safe findings are fed to prompt assembly;
  untrusted tool/model content remains delimited evidence, never instructions. The
  final model output remains structured data, while publication owns destination HTML.

### Unified attachment intelligence

- Extend connector contracts and the Jitbit adapter with `AttachmentSource` byte
  streaming. Discover attachments from ticket bodies, comments, and attachment metadata
  without connector-specific branches in core packages. Validate vendor response shapes,
  cancellation, retry hints, and bounded generic errors.
- Add connector-owned extraction of inline references from Jitbit case bodies/comments
  and Git/Markdown source documents. Preserve the original immutable source/case
  content; create normalized derived text that contains typed references to processed
  evidence rather than destructively mutating the source.
- Route every source/case image through the existing streaming, MIME-validation,
  hash-addressed attachment/derivative pipeline and metered `vision` binding. Persist
  source/evidence provenance, use the derivative cache before an AI call, and expose
  success, cache hit, skipped, and failed states without exposing protected content.
- Treat each attachment **occurrence** as the immutable evidence unit. A binary may
  occur more than once in a source document, case description, or comment; occurrences
  retain their distinct owner, ordinal, relation, requiredness, and safe identity even
  when their bytes safely reuse one derivative-cache entry. The encrypted reopen locator
  is private implementation data, never an API/audit/log/trace/Sentry value.
- Preparation starts from a stable logical source-document or case-capture subject, not
  from a knowledge revision or finalized case snapshot that does not exist yet. A
  fenced durable attempt atomically records immutable per-occurrence terminal evidence
  and the later revision/snapshot pins that evidence. Retryable terminal outcomes create
  a new immutable attempt identity; prior evidence is never reopened or changed.
- Download text and supported archives through a source capability only. Process them
  in the existing isolated attachment runtime with strict byte, MIME, recursion,
  file-count, compression, symlink, path, CPU, memory, output, and timeout limits.
  Attachments become selected, read-only evidence/sandbox files; no unbounded host
  temporary directory is described to the model.
- Treat attachment failure as a typed non-blocking warning unless the immutable
  analysis/source attachment policy marks that evidence required. Retries reuse durable
  completed derivatives and safely clean temporary artifacts.

### Source filters, automation, and publication

- Extend descriptor-driven knowledge-source authoring so Jitbit resolved-case ingestion
  clearly presents its closed/resolved filter and documents why open cases are excluded
  by default. Retain that connector-owned filter in the immutable source version.
- Add Administration authoring for case discovery/polling schedules and trigger-to-
  analysis-recipe mappings. Schedules persist exact source, connector, recipe, and
  publication pins and only enqueue durable commands. Where a connector supports a
  signed webhook, verified ingress produces the equivalent pinned command identity.
- Compose the existing PBI-011 analysis and PBI-012 immediate internal publication
  flows. Duplicate discovery, webhook delivery, worker retry, and uncertain remote
  writes must retain existing idempotency/reconciliation semantics and cannot create
  duplicate destination comments.

### Administration UX, observability, and documentation

- Add accessible descriptor-driven forms, human explanations, safe examples, empty,
  unavailable, denied, validation, conflict, warning, and terminal-failure states for
  the new repository, attachment-policy, analysis-recipe, and case-trigger workflows.
  The browser remains a cookie-session API client only and has no direct repository,
  provider, connector, database, queue, filesystem, object-storage, or secret access.
- Add structured lifecycle logs and OpenTelemetry spans/metrics for attachment cache
  outcome, checkout/attestation outcome, repository-agent bounded execution, trigger,
  analysis, and publication receipt. Add an optional deployment-configured Sentry sink
  behind the observability redaction boundary; validate that all prohibited sensitive
  fields are removed before event export.
- Update affected feature specifications, folder READMEs, administration/operator
  documentation, and the main runbook for repository mounting, remote checkout,
  attachment limits, image-fetch restrictions, required Sentry configuration, and
  operational failure/recovery behaviour.

## Acceptance criteria

- [x] An administrator can create, test, version, inspect, enable, and disable a code
      repository and its execution policy without exposing a secret, locator, local
      path, remote URL, source-tree content, or credential in API/UI/audit/log output.
- [x] A phase-one analysis recipe selects one repository at most and only through a
      provider-neutral repository-agent binding/runtime contract.
- [x] Each enabled repository run resolves a full immutable commit, runs in a disposable
      attested read-only networkless sandbox with no inherited credentials, and rejects
      invalid repository evidence.
- [x] Repository-agent output contains bounded findings cited by locations only; the
      runtime independently verifies every excerpt/hash against the prepared pinned tree
      before findings become clearly delimited analysis evidence. A provider never sees
      checkout credentials, remote URL, prepared-tree path, or a filesystem handle.
- [x] GitHub Copilot SDK BYOK can be one configured repository-agent provider, while a
      synthetic provider proves no analysis or UI code branches on Copilot/provider/
      model/runtime names.
- [x] A Jitbit attachment is streamed, MIME-checked, content-addressed, processed under
      limits, attributed to its source/case, and reused without another vision call when
      its full derivative identity matches.
- [x] Two occurrences of the same binary remain distinct frozen knowledge/case evidence
      while safely sharing the same derivative cache; encrypted reopen locators never
      appear in generic occurrence reads, protected analysis records, audit data,
      logs, traces, diagnostics, or Sentry exports.
- [x] Attachment preparation is fence-safe and immutable: a stale worker cannot
      finalize after lease expiry/reclaim, required unavailable evidence blocks the
      corresponding revision/request, optional evidence becomes a typed retryable
      warning, and a retry creates a new immutable preparation attempt.
- [x] Inline image references in Git/Markdown sources and Jitbit ticket/comment content
      produce persisted vision derivatives and normalized searchable/analysis text;
      a permitted public-image fetch failure is recorded as a warning and does not block
      unrelated source/case processing.
- [x] ZIP extraction rejects path traversal, symlinks, encrypted/deep/oversized/archive-
      bomb inputs and never exposes arbitrary host filesystem paths to the agent.
- [x] Jitbit resolved/closed-only knowledge ingestion is operator-configurable, defaults
      to excluding open cases, and remains a connector-owned immutable filter.
- [x] A polling or verified webhook trigger produces one exact-pinned analysis request;
      duplicate delivery/retry cannot create duplicate analysis or Jitbit comment.
- [x] A successful automatic Jitbit publication stores a durable connector-neutral
      receipt containing the external publication ID/comment ID. The retained analysis
      record contains governed prompt/context, output/result, immutable evidence/profile
      pins, and typed stage warnings/failures.
- [x] Every AI operation uses `@caseweaver/ai-execution`, records usage/cost attribution,
      obeys hard/soft budget policy, and never treats unknown price as zero.
- [x] Every UI/API/worker action is authorized, workspace-isolated, idempotent where
      applicable, and append-only audited without user-controlled actor/action/target
      authority or sensitive request data.
- [x] Logs, traces, diagnostics, and optional Sentry exports are structurally redacted;
      focused tests prove prompts, results, attachments, repository paths/URLs, tokens,
      cookies, headers, secret locators, and credentials cannot escape.
- [x] Focused unit, connector/provider contract, PostgreSQL integration, API integration,
      Admin component, and critical Docker Compose/browser end-to-end tests pass without
      live AI calls.

## Delivery record and remaining work

None for this PBI. The delivery includes eight ordered PBI-020 PostgreSQL migrations,
the provider-neutral repository and attachment contracts, descriptor-driven operator
authoring, exact-pinned worker composition, Sentry-compatible redaction, and the
no-network attachment processor sidecar. Validation passed `pnpm ci`,
`pnpm test:integration` (132 PostgreSQL and one pg-boss test), `pnpm test:e2e`, and a
clean `docker compose -f deploy/docker/compose.local.yml up --build --wait` followed by
the real Compose browser journey. It intentionally does not complete PBI-017's
production TLS, backup/restore, vulnerability, or attestation-verification work.

## Excluded

- Multi-repository investigation and general-purpose coding-agent workflows.
- Repository write, commit, push, pull-request, issue-tracker, or unrestricted shell/
  network tools.
- Customer-visible automatic replies.
- Browser-native Git/filesystem access, browser-stored secrets/tokens, and direct
  browser access to infrastructure or external providers.
- Arbitrary Internet fetching, arbitrary host-path mounts, arbitrary archive formats,
  or unbounded attachment/model processing.

## Delivery modules

1. **Architecture/contracts:** provider-neutral repository, attachment-reference,
   analysis-recipe, trigger, persistence, retention, authorization, audit, and
   observability contracts. Parent owns shared administration exports, migration order,
   worker/API/scheduler registries, and production composition.
2. **Repository runtime:** remote checkout broker, prepared-tree storage, attested
   sandbox contribution, and repository-agent provider composition. This completes the
   remaining PBI-010 runtime slice.
3. **Attachment-capable connectors and ingestion:** Jitbit `AttachmentSource`,
   Git/Markdown and Jitbit inline-reference extraction, resolved-case filter, and
   connector contract tests.
4. **Attachment/case orchestration:** immutable source/case attachment references,
   derivative preparation/cache reuse, safe archive evidence handoff, repository
   findings, analysis-result retention, and publication receipt composition.
5. **Administration/API and console:** repository/execution-policy/analysis-recipe/
   case-trigger resources and forms, guarded tests, protected inspection, and user
   guidance.
6. **Observability and end-to-end validation:** redacted Sentry-compatible sink,
   metrics/traces, PostgreSQL/API/Compose workflow coverage, documentation, and final
   migration/operational validation.

## References

- `AGENTS.md`
- `.features/01-product-and-scope.md` through `.features/12-roadmap.md`
- `.features/14-knowledge-sources-guide.md`
- `.features/15-connectors-and-destinations-guide.md`
- `.features/16-ai-execution-guide.md`
- `.features/17-analysis-and-prompts-guide.md`
- `.features/18-attachments-guide.md`
- `.features/19-scheduler-and-webhook-guide.md`
- `.features/20-persistence-and-database-guide.md`
- `.features/22-testing-strategy.md`
- `.features/23-implementation-workflow.md`
- `.features/25-admin-console-guide.md`
- `temp/pbi/PBI-010-repository-agent.md`
- `temp/pbi/PBI-011-analysis-orchestration.md`
- `temp/pbi/PBI-012-destinations-triggers.md`
- `temp/pbi/PBI-016-react-admin-operator-console.md`
- `C:\GIT\Nectari\AzureDevopsPipelines\Knowledge\SupportAgentAnalysis.yml`
- `C:\GIT\Nectari\Scripts\Cloud\Modules\HelpDeskHelper.psm1`
