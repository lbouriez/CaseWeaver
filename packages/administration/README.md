# Administration

Provider-neutral administration contracts for descriptor discovery, versioned
configuration lifecycle, cursor pagination, idempotency, and cache-invalidation
notifications.

PBI-016 also defines provider-neutral, bounded diagnostic-export request, artifact,
source, and lifecycle contracts. Export bytes must be produced from already-redacted
diagnostic events; status DTOs never expose object-storage locators or download URLs.
Requests are idempotent, freeze their cutoff/limits/expiry, and use leased generation
and deletion. Private artifact locators are server-only contract fields for adapters;
they must never enter HTTP DTOs, audit details, logs, or browser state.
The accepting adapter must use `DiagnosticExportRequestMutationStore` to commit the
request, its single opaque `diagnostics.export.generate.v1` outbox envelope, and the
server-owned success audit record atomically. Worker handlers receive only the
workspace and export IDs.

Configuration inspection/history contracts expose only immutable version metadata,
canonical-settings digests, descriptor identity, and redacted secret-reference counts.
They deliberately exclude canonical settings, secret-reference IDs, object locators,
and URLs. Composition registers each surface as managed, read-only, or unavailable;
only feature-owned use cases may advertise a mutation workflow.
The vocabulary distinguishes immutable draft/version workflows (`create_draft`,
`validate`, `activate`, `disable`) from singleton policy workflows (`create`,
`replace`); both remain composition-owned and require `inspect_history` on a managed
surface.
Operational commands (for example, source synchronization and publication approval)
are advertised separately from configuration workflows so a read-only surface cannot
accidentally become a generic mutation form.

Workspace role administration is a separate, provider-neutral membership use case.
`ReplaceWorkspacePrincipalRoles` accepts only the target principal and desired
code-owned role set from a command; its workspace, actor, audit origin, and correlation
metadata must come from validated server session state. The membership-set revision is
workspace-wide (starting at `0`) and supplies optimistic concurrency across all role
changes. A durable store must verify the actor's persisted `administrator` role, retain
at least one administrator, preserve a replay result for each idempotency identity, and
atomically persist immutable role history plus the authoritative
`admin.roleAssignment.replace` audit event. Role names and before/after hashes are safe
metadata; the contracts do not carry tokens, browser claims, or secret values.

`PreviewProviderCapabilityTest` and `RunProviderCapabilityTest` are the
provider-neutral, bounded capability-test use cases. Composition supplies an immutable
provider/binding test template and its persisted template digest, one-use server preview
confirmation, rate limiter, durable idempotency claim store, and the exclusive
`@caseweaver/ai-execution` gateway. The browser supplies neither a request/template digest
nor a budget choice. Preview derives pricing through the gateway's read-only preflight;
confirmation issuance and its server-owned preview audit commit through one atomic port.
Execution replaces all template budget controls with a hard, known-price,
budget-policy-required budget and an at-most-30-second deadline. An adapter must commit
the terminal redacted test result and its server-owned audit record atomically. The
contracts accept or return no secret, endpoint, model response, provider exception, or raw
idempotency key; missing policy and uncertain pricing are denied rather than represented
as zero.

This package depends inward on domain, security, and the exclusive AI-execution gateway
contract only. It owns neither HTTP/session authentication implementation, Prisma/PostgreSQL access,
connector/provider runtime clients, secret values, nor feature business policy. Feature
packages remain the authority for validating and executing their own configuration
behavior.

Descriptors are safe, immutable metadata for backend discovery and generic UI forms.
They contain schemas and secret *slot metadata*, never secret values, resolved clients,
or runtime exceptions. Configuration versions are immutable; adapters must enforce
workspace scope, expected-revision optimistic concurrency, idempotency, atomic audit,
and post-commit outbox publication. Trusted backend composition registers immutable,
workspace-neutral descriptor revisions; descriptor-backed configuration versions retain
only their descriptor identity, canonical settings, display metadata, and secret
reference identities.

Knowledge-source and schedule authoring compose this same lifecycle through
`ManageKnowledgeSourceConfiguration` and `ManageKnowledgeScheduleConfiguration`.
Their inputs carry a feature-validated, source-neutral projection plus opaque settings;
the administration package does not parse connector filters or schedule execution
policy. Creation makes an inert draft projection. Activation or disablement creates a
new immutable version and projects its exact version ID to the existing knowledge source
or schedule read model. The persistence port must validate workspace ownership, an active
`knowledgeSource` connector capability, selected immutable source version, and the
caller-provided audit transaction before committing the projection.

AI configuration authoring uses named provider-neutral commands for pinned LiteLLM
catalog imports, immutable model-binding drafts/versions, activation/disablement,
workspace role defaults, pricing overrides, and budget-policy replacement. Commands
receive a server-derived trusted context and hashed idempotency identity; actor,
workspace, action, permission, and audit outcome are never browser authority.
Bindings are validated through `@caseweaver/ai-config` against their immutable catalog
model, and pricing overrides are rejected whenever the shared resolver finds an
incomplete condition or currency. These contracts keep endpoint and opaque secret
reference values write-only: summaries and audits contain no resolved secret material.

Publication-profile authoring composes the generic lifecycle through
`ManagePublicationProfileConfiguration`. The browser supplies PBI-012 definition
fields but never the immutable profile ID or version: administration derives them
from the aggregate and successor revision. A draft is inert; activation delegates
definition parsing and active `analysisDestination` validation to the feature-owned
publication adapter, which creates a PBI-012 immutable profile version without
rewriting existing publication intents. Disabling a profile only stops future
selection and retains already referenced versions.

Publication previews use `PreviewPublicationProfileConfiguration`: the browser can
identify only a profile and analysis result. Composition selects the active immutable
profile/version, renders with PBI-012's existing renderer, bounds the response, and
persists the sensitive-read audit before returning content. It never creates an intent
or invokes a destination.

Webhook endpoint authoring uses the same lifecycle but keeps a draft endpoint
non-routable. Its opaque endpoint ID, connector ID, bounded verified event types,
body/rate limits, optional server trigger, and already-resolved opaque secret
locators are the only projection inputs. The use case never receives webhook
bodies/headers or calls an adapter; persistence must activate an endpoint only
after validating the configured connector capability and descriptor event types.
`WebhookEndpointConfigurationReadPort` and `WebhookEndpointRateLimiter` are separate
trusted-ingress ports: the active-only route lookup and admission check deliberately
return neither settings nor secret-reference identities, and a denied admission must
not invoke an adapter or create a delivery record.
An active endpoint with an analysis trigger additionally requires the server-owned
activation principal on its internal transition command. The retained principal is
available only to trusted ingress composition for attributable automated work; it is
not part of the endpoint projection or an administration HTTP DTO.

`ManagePlatformLinkConfiguration` persists workspace API and webhook public bases
under the `platform-links` resource type. It accepts HTTPS URLs only, except that
deployment composition may explicitly allow loopback HTTP for development. Public
webhook URLs are derived from this persisted base plus an opaque endpoint ID, never
from an untrusted request Host header. OIDC/trusted-proxy/runtime status remains
deployment-owned and read-only.

## Private runtime configuration resolution

`RuntimeConnectorConfigurationResolver` is a server-private composition port for
background webhook and worker capability factories. It resolves only an active,
workspace-scoped connector aggregate and an immutable descriptor-backed version,
including server-only opaque secret-locator metadata. It is not an HTTP/API read model:
settings, locator metadata, and resolved secret values must never enter browser state,
DTOs, audit data, logs, traces, or errors. AI binding resolution remains exclusively in
`@caseweaver/ai-execution` and is deliberately not duplicated by this connector port.

`ConnectorDraftTestStore` is the provider-neutral contract for a bounded,
unpersisted connector configuration test. Composition validates settings with
the owning connector and supplies only a descriptor identity plus a candidate
SHA-256 digest to the store. A short-lived, session-bound confirmation is
one-use; an execution idempotency claim and bounded terminal outcome are
durable. Implementations must atomically append the preview/result audit with
the corresponding safe state and must never accept or retain settings, secret
registration IDs/locators, credential values, remote URLs, responses, or errors.

## Repository analysis authoring

`ManageRepositoryAnalysisConfiguration` composes the same immutable lifecycle for
`code-repositories`, `repository-execution-policies`, `attachment-policies`,
`analysis-recipes`, `case-analysis-triggers`, and `case-analysis-schedules`. It keeps
repository URLs/refs, deployment paths/aliases, checkout locators, credentials, source
trees, raw settings, and test output in feature/adapter-private write-only settings.
Projections, audits, and public summaries retain only safe identities, bounded policy
limits, lifecycle state, and booleans/counts. A remote repository can retain at most one
secret-reference identity; a deployment-mounted repository retains none.

`TrustedRepositoryAnalysisConfigurationContext` is constructed from server session and
request state, separately from every browser command. The durable adapter must apply
workspace ownership, authorization, optimistic concurrency, idempotency, immutable
version insertion, feature projection, and `RepositoryAnalysisConfigurationAuditPort`
in one transaction. Replays never rewrite projections. The manager supports both an
initial inert draft and an inert successor draft revision. Each successor receives fresh
write-only settings; generic inspection/history never returns the prior settings.

An execution policy is provider-neutral and must declare `networkDisabled: true`, a
non-empty `listFiles`/`readFile`/`searchFiles` read-only allowlist, and bounded time,
turn, tool, CPU, memory, and output limits. A phase-one recipe has a repository and
attachment stage. A non-disabled repository stage requires exactly one immutable code
repository/version plus execution-policy/version pair; a disabled stage requires none.
A non-disabled attachment stage likewise requires exactly one immutable attachment-policy
version. An analysis recipe has its own `recipeId` aggregate and merely selects an
`analysisProfileId`/version, so several recipes can safely reuse an analysis profile.
Trigger and schedule projections pin that independent recipe identity/version alongside
their source, connector, and publication inputs; existing trigger/scheduler use cases
own verification, leases, occurrence identity, and durable enqueue.

`RepositoryConfigurationTestPort` is the server-only seam for a bounded candidate
connection/ref-resolution test. The HTTP/application layer retains the validated
candidate privately and passes only an opaque candidate ID/digest, session-bound expiring
confirmation, and idempotency digest. It accepts no raw candidate setting and returns
only a safe accepted/in-progress or terminal state—never URLs, refs, paths, credentials,
locators, remote output, or error text. An accepted/in-progress state is non-terminal
and cannot satisfy repository activation.

`PreviewRepositoryDraftTest` and `RunRepositoryDraftTest` are the replacement
provider-neutral candidate-test contracts for code repositories. A trusted adapter
selects an existing inert candidate version and computes its SHA-256 digest from
canonical private settings, normalized secret-registration IDs, and the safe repository
projection. The browser never sends that digest or any candidate value. Preview stores
an expiring, session-bound confirmation and its audit record; execution atomically
consumes that one-use confirmation with its idempotency claim before it invokes a
server-private non-destructive runner. Replays return the durable redacted terminal
state without another runner invocation. A duplicate while its claim lease remains live
returns the distinct safe `accepted`/`inProgress` execution state and must never invoke
the runner, finalize an outcome, or fabricate `outcome_unknown`. The durable store alone
uses its database transaction time to decide a lease has expired and may then reclaim it
under its configured policy. Store implementations must fail closed for a session,
expiry, candidate-digest, or audit mismatch. They may retain only IDs, digests,
confirmation state, `inProgress`, and `completed`/`failed`/`outcome_unknown`; they must
never retain or return repository URLs/refs, mount paths, secret locators/values, output,
or external errors.

`RepositoryDraftTestExecutionCandidateResolver` is a second, server-private resolver
used only after that confirmation/idempotency claim. It may recover an exact remote URL,
deployment mount alias, authored full ref, and registered external secret locator, but
must verify the same draft/version/digest identity. Its result is never an API DTO,
browser value, audit payload, log field, or configuration-inspection response.

Code-repository activation has an injected
`RepositoryConfigurationActivationGuard`. On a new active successor only, the manager
computes the private candidate digest and requires a completed exact candidate test
after the lifecycle successor has been inserted but before its feature projection is
written. The enclosing administration transaction must roll back on guard failure. A
replayed mutation neither reconsumes a confirmation nor validates a prior candidate;
non-repository transitions never use this guard. Production composition must inject the
durable draft-test guard—there is deliberately no permissive production fallback.

`ListRepositoryAnalysisOptions` is the safe authoring catalog for repository-analysis
forms. It exposes only opaque IDs/version IDs, labels, lifecycle, and explicit draft or
activation eligibility for repositories, policies, profiles, bindings, source/connector
pin pairs, webhook endpoints, and checkout-secret registrations. Deployment registries
provide only opaque mounted-repository, sandbox-policy, and attachment-processor-policy
aliases. The presentation layer allowlists those fields, so a path, remote URL, image,
locator, or other adapter-private field is not accidentally passed through to an API or
browser. Webhook draft eligibility is intentionally separate from activation eligibility.

`RepositoryAnalysisTransitionSnapshotStore` is a separate server-private read port.
It reconstructs the exact current immutable settings, opaque credential-registration
IDs, and feature projection needed to append an active/disabled successor. It is never
a configuration-inspection DTO and cannot return an alternate/current-default version;
the API must map a missing snapshot to a not-found result without exposing why it was
missing.
`analysisBindings`, `analysisRecipes`, and `caseAnalysisTriggers` are distinct
active/current arrays for recipe, trigger, and schedule authoring. Each is limited to
200 server-validated immutable choices and is explicitly copied through the same safe
allowlist; it never contains AI provider/model metadata, configuration settings, source
details, URLs, paths, or secret material.
