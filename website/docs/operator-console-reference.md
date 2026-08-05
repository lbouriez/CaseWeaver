---
sidebar_position: 2
title: Operator console reference
---

# Operator console reference

Use this source-verified reference to operate the current CaseWeaver Admin
Console or to help an operator prepare a change. It describes the
server-authorized UI, not a generic REST client and not a promise that every
connector, provider, or workflow is installed in every deployment.

The Console is a cookie-session client of the CaseWeaver API. It does not hold
an OAuth token, secret value, connector/provider client, database connection,
repository checkout, or authorization policy. A missing, unavailable, or
read-only control means the API has not advertised a safe workflow for this
deployment, workspace, or permission set. Do not replace it with a
browser-crafted API request.

For runtime prerequisites, Compose topology, and variables, read the
[deployment reference](./deployment-reference.md). For a concise assistant-safe
workflow, start with the [operator knowledge map](./operator-knowledge-map.md).

## How the console works

### Server-owned security and audit boundary

The API, not the browser, resolves the operator, active workspace, effective
permissions, CSRF token, idempotency, optimistic concurrency, configuration
versions, price/budget decision, and audit outcome. A successful mutation and
its audit event commit atomically. Sensitive reads/downloads fail closed when
their required audit event cannot persist.

Every authenticated UI read, query, command, mutation, test, export, download,
login, logout, and workspace switch is workspace-scoped and server-audited. A
browser correlation value never chooses the actor, permission, action code,
target, or result. Never put a password, API key, OAuth token, database URL,
checkout credential, session cookie, or secret value in a Console field, URL,
diagnostic report, or support conversation.

### Draft, immutable version, and guarded action lifecycle

Durable configuration normally follows this sequence:

1. Create a server-validated **draft**.
2. Run an optional explicit bounded test if the UI offers one.
3. Review the server-provided impact, expiry, and cost information.
4. Activate the exact configuration version.
5. Inspect the resource, its version history, durable work record, and audit event.

Activation and disablement create a successor immutable version; they do not
rewrite configuration captured by existing work. Before a lifecycle action, the
UI reads the current server revision so a concurrent change is rejected rather
than overwritten. **Remove draft** discards an inactive draft from ordinary
lists/selectors. It preserves immutable history and audit evidence, and the
discarded draft cannot be reactivated.

Costly or destructive actions require a server preview and confirmation. The
API calculates impact and may return an estimate, expiry, or denial.
`outcome_unknown` means completion cannot safely be claimed: inspect the target,
job, publication, cost, and audit record before retrying.

### Dynamic descriptors and options

**Registered type** is not an operator-defined text value. Connector and AI
provider packages register safe descriptors with the backend. The Console reads
each descriptor's display metadata, settings schema, field help, examples,
capabilities, supported test operations, and redacted secret-reference slots at
runtime. A new registered type can appear without frontend code changes; an
absent type is not available in that deployment.

Selectors are also server-owned. A model selector contains only the inventory
for its active provider, a source selector contains workspace-scoped records,
and a mounted repository selector contains deployment-approved aliases. Do not
infer a model, connector capability, price, mount, or permission from a label.

## Sign in, workspaces, and navigation

### Sign in and session availability

`#/login` checks the API-managed session cookie first. A deployment may offer
password sign-in, **Continue with configured identity provider**, or both.
Password sign-in sends the password only for the terminal request. OAuth/OIDC
uses API-managed Authorization Code + PKCE; the browser never receives or stores
an OAuth token.

**Console unavailable** with **Retry session check** means the session API could
not be reached. Check API health, allowed UI origin, TLS/cookie configuration,
and any request/correlation ID; it does not prove a password is wrong. If the
page advertises no sign-in method, deployment authentication must be corrected.

### Active workspace

The app bar shows **Active workspace** only when the session has more than one
server-authorized membership. Selecting one calls the CSRF-protected switch
endpoint and refreshes records. It does not grant a role or expose another
workspace's data. **Sign out** ends the server-managed session.

### Primary screen map

Navigation is permission-aware. A screen may be hidden when the user lacks all
its navigation permissions. A visible resource may still be unavailable or
read-only when its server configuration surface is not managed.

| Route | Screen | Purpose | Detailed guide |
| --- | --- | --- | --- |
| `#/` | **Overview** | Read-only system pulse for bounded health, work, budget, and audit signals. It never invokes a connector or model. | [Operations](./operations.md) |
| `#/integrations` | **Integrations** | Connector drafts, sources, schedules, webhooks, and case-intake automation. | [Connectors](./connectors.md) |
| `#/ai` | **AI configuration** | Dynamic providers, provider inventory, bindings, pricing, budgets, and metered tests. | [AI configuration and cost](./ai-and-cost.md) |
| `#/knowledge-analysis` | **Knowledge & Analysis** | Collections, retrieval/prompt policy, attachment policy, analysis recipes, and analyses. | [Knowledge and analysis](./knowledge-analysis.md) |
| `#/repository-analysis` | **Repository analysis** | Code repository and bounded execution-policy versions for case investigation. | [Knowledge and analysis](./knowledge-analysis.md#repository-assisted-case-analysis) |
| `#/publication` | **Publication** | Publication policy and durable state, including approval only where offered. | [Operations](./operations.md) |
| `#/operations` | **Operations** | Jobs, recovery, cost, retention, privacy, diagnostics, and audit evidence. | [Troubleshooting](./troubleshooting.md) |
| `#/access` | **Access & security** | Canonical secret-reference registry, identities, workspaces, and role assignments. | [Access and secrets](./access-and-secrets.md) |
| `#/platform` | **Platform** | Safe runtime capability/readiness posture and workspace public links. | [Deployment reference](./deployment-reference.md) |

## Overview

**Route:** `#/`
**Access:** always shown; individual server signals remain permission- and
workspace-scoped.

**System pulse** is a compact read-only summary. It must not start
synchronization, a model call, a repository lookup, or a connector test. Use it
as a diagnostic entry point: open the relevant **Jobs**, **Costs**, or **Audit**
resource in **Operations** for durable evidence. A missing signal is not a
healthy signal; follow its explicit unavailable state and
[troubleshooting](./troubleshooting.md).

## Integrations

**Route:** `#/integrations`
**Navigation permission:** `configuration.read`; every command receives its own
server authorization.

The configuration-surface registry determines whether each resource offers
authoring, lifecycle controls, guarded operations, or only list/show views.

### Connector instances

In **Connector configuration drafts**, select a server-provided **Registered
type**, give it an instance display name, complete only its descriptor fields,
and choose a redacted active secret registration for each secret slot. Never put
a credential in JSON or an endpoint URL.

When the descriptor offers **Test**, first request its bounded preview and then
confirm execution. The result is status only: it contains no remote response,
endpoint, secret, or adapter exception. A passing test does not ingest content,
create a case trigger, or authorize publication. Review and activate the exact
draft afterward. Connector inspection exposes only safe immutable history,
lifecycle, revision, settings digest, and secret-reference count.

### Knowledge sources and schedules

**Create an inert source draft** does not contact a connector, schedule work, or
ingest content. It selects an active connector and existing **Knowledge
collection**, profile identities/versions, embedding batch size, active hard
embedding budget, attachment behavior, synchronization policy, and deletion
behavior.

The source version pins those selections. Attachment handling is disabled,
optional (warnings may be recorded), or required (activation work stops if
required evidence cannot reach a terminal prepared state). The synchronization
policy is bounded feature JSON; connector-specific filters remain in the
connector configuration. **Tombstone deleted documents** keeps an auditable
deletion state; **Retain deleted documents** leaves indexed documents in place.

Activate only when connector, collection, policy, and budget are ready.
**Synchronize** requests bounded incremental work; **Full rescan** explicitly
requests controlled re-evaluation. Workers execute the operation, never the
browser.

**Create a source-version-pinned draft** creates a schedule tied to one
immutable source version. It cannot silently follow later source edits. Choose
**Synchronize changes** or **Full rescan**, an interval or server-validated cron
expression/IANA timezone, overlap policy, and first UTC run. **Skip overlapping
execution** avoids concurrent work; **Queue overlapping execution** keeps due
work for controlled workers. Activate or disable it with its lifecycle control.

### Webhook endpoints and case-intake automation

**Create a webhook endpoint draft** selects an active connector and only
server-recognized event types. It configures bounded body size/rate, an optional
opaque analysis-trigger identity, safe JSON settings, and redacted secret
registrations. The UI never enters a webhook secret/header/body/endpoint URL or
connector client configuration. Activation validates the configuration before
future requests can use it.

**Case analysis automation** controls how cases enter CaseWeaver:

- **Create a case analysis trigger draft** maps a server-provided case source,
  immutable analysis recipe, and publication profile. Choose **Polling** for
  connector scans or **Verified webhook endpoint** for connector-validated
  inbound work.
- **Create a case intake schedule draft** pins a case trigger and uses an
  interval or five-field cron/timezone schedule. The server calculates due time,
  leases, and overlap enforcement.

Creating a draft does not process existing tickets. Activate it and inspect
**Jobs**, **Analyses**, **Publications**, and **Audit** for durable evidence.

## AI configuration

**Route:** `#/ai`
**Navigation permission:** `configuration.read`; creation, activation, pricing,
budget, and testing remain separately authorized.

This screen keeps three facts separate: a configured provider instance, models
that provider reports as available, and optional trusted catalog/pricing
enrichment.

### Provider activation and provider-owned inventory

In **Configure an AI provider**, choose a registered provider descriptor, enter
**Instance display name**, and complete its dynamic fields. An OpenAI-compatible
descriptor requires an explicit API mode (such as embeddings or chat) because
CaseWeaver never silently switches protocol. Select an opaque secret reference;
never paste an API key.

Saving creates an inert server-validated draft. **Review and activate provider**
is a separate guarded step. Only active providers can enter binding selectors.
An inactive provider draft may expose **Remove draft**, a terminal discard that
keeps audit/history.

After activation, select the provider and choose **Refresh models available
from provider**. The server calls the provider and stores a bounded,
workspace-scoped inventory tied to that provider version. The browser does not
call the provider or receive its endpoint, credential, raw response, or account
metadata.

### Catalog, bindings, defaults, price, and budget

**Refresh trusted model catalog** is optional pricing/capability enrichment. It
does not make every catalog model executable. The executable set is the selected
provider's refreshed inventory. Exact canonical price matches may enrich it; an
unmatched model has unknown price, never zero.

**Create a model binding draft** selects an active provider, a model from its
returned inventory, a CaseWeaver role, and optional token limits. It is an
immutable binding, not a manual model-name or credential field. Revise through a
successor version, then use **Set workspace role default** for the active
binding version chosen as that role's default.

**Create pricing override** applies only to a selected provider-inventory model;
it does not enable an unrelated catalog model. Cover every required usage unit:
input tokens for embeddings/reranking, input and output tokens for generated
responses, and image units for vision. Unknown remains unknown.

**Replace budget policy** creates/replaces a versioned scoped limit. A hard
budget may prevent metered work before it starts. The UI uses the server-read
policy revision so a stale form cannot overwrite another operator's change.

### Bounded capability test

The test panel asks the server for a compatible active binding, known/complete
price decision, and required hard budget. It then previews and confirms once.
The server reserves budget, rate-limits, times out, attributes cost, and uses
the AI execution gateway. Failed, denied, and `outcome_unknown` outcomes are
durable operation results, not a reason for a browser-side provider retry.

See [AI configuration and cost](./ai-and-cost.md) for the full flow.

## Knowledge & Analysis

**Route:** `#/knowledge-analysis`
**Navigation permission:** `analysis.read`; authoring appears only for managed
server surfaces.

### Collections and profiles

**Create a collection** creates a permanent workspace-scoped vector space. It
requires a durable collection ID, active **embedding** binding, that binding's
documented compatibility/profile version, and exact vector dimension. The API
pins the binding version so later AI changes cannot change existing vectors.
Use a separate collection when embedding representation, dimensions, or
compatibility boundary must differ. A collection is not a connector, source, or
schedule.

**Create retrieval profile draft** and **Create prompt profile draft** appear
only when advertised. Their JSON is bounded and rejects credential-shaped keys.
They describe evidence selection and prompt constraints; they do not select a
provider, connector, model, or secret.

**Analysis profiles** and **Analyses** can intentionally be list/show only. An
analysis recipe selects an existing analysis profile; it is not an alternative
analysis-profile editor.

### Attachment intelligence and analysis recipes

**Attachment intelligence and analysis recipes** configures the shared
preparation path for knowledge sources and cases. **Create an attachment
handling policy draft** selects a deployment-approved processor security policy
and active vision binding, then limits attachment count/bytes, archive entries,
expanded archive bytes, and nesting depth. The server downloads, performs
MIME/archive checks, reuses cached derivatives, calls vision, and persists
evidence. The browser receives safe status/evidence metadata only.

**Create an analysis recipe draft** composes immutable analysis profile/binding,
retrieval profile, prompt profile, and publication profile versions. Repository
investigation and attachment preparation can be optional or required. Required
evidence stops the run when unavailable; optional evidence records a warning.
The API validates relations such as the repository-agent binding pinned by the
execution policy before activation.

The recipe is the versioned plan for a case run. It captures repository,
attachment, retrieval, prompt, model, and publication decisions so a retry does
not silently use newer configuration.

## Repository analysis

**Route:** `#/repository-analysis`
**Navigation permission:** `configuration.read`.

This screen owns code evidence, not Git/Markdown knowledge-source content. It
creates repository and execution-policy versions for an analysis recipe. The
server reads, checks out, and tests repositories; the Console never reads a
worktree.

### Code repository draft

**Create a code repository draft** supports two location modes:

- **Server-managed HTTPS repository** accepts a credential-free HTTPS remote
  URL. It must contain no token, password, query string, or fragment. The URL is
  transient authoring input: the form clears it after the request and it is not
  shown in lists, audit data, or later lifecycle controls. A private remote may
  select an opaque **Registered repository access** reference.
- **Deployment-approved repository mount** selects a server-provided mount alias.
  Deployment owns the path behind the alias; host paths never enter the browser.

Choose allowed branch/tag/full-commit-SHA forms and a configured checkout
reference. Branches/tags resolve to an exact commit at run time; a full SHA is
already immutable. `HEAD`, refspecs, shortened SHAs, and unsafe names are
rejected. Use the repository draft test/activation controls when offered.

### Repository execution policy

**Create a repository execution policy draft** selects an active
repository-agent binding and deployment-owned sandbox-policy alias. It chooses
bounded investigation tools, requires network-disabled mode, and sets
server-validated size/time/process limits. The alias is not a host path,
container image, or browser-controlled sandbox. The exact policy/binding
relation is selected by the analysis recipe.

See [Knowledge and analysis](./knowledge-analysis.md#repository-assisted-case-analysis) for the full flow.

## Publication

**Route:** `#/publication`
**Navigation permission:** `analysis.read`.

**Create a publication profile draft** defines a versioned destination policy
with bounded credential-free JSON. The API validates destination/policy and the
form rejects credential-shaped fields. Activate/disable through the lifecycle
control. **Publication state** lists intents, approvals, attempts, receipts, and
reconciliation state; it is not a generic direct-post screen.

When the server exposes an awaiting-approval operation, use **Approve
publication** through its preview/confirmation flow. For a failure or unresolved
state, inspect the durable publication, related job/dead letter, and audit event
instead of manually posting a duplicate.

## Operations

**Route:** `#/operations`
**Visible with any of:** `operations.inspect`, `cost.read`, `audit.read`, or
`retention.run`; individual records/actions still require their own permission.

Operations is for evidence and controlled recovery, not direct connector or
provider SDK work.

| Resource | What it shows or permits |
| --- | --- |
| **Jobs** | Leased durable work and recovery state. Guarded actions may request cancellation or recovery. |
| **Dead letters** | Failed work requiring controlled inspection/retry. **Retry** is server-previewed, not a copy of original input. |
| **Costs** | Attributed cost and explicit unknown-price states. Unknown is not zero. |
| **Retention** | Server-owned retention state. **Request retention preview** must finish before reap confirmation is enabled. |
| **Privacy** | Tombstoned records and controlled deletion. **Purge** requires server preview/confirmation. |
| **Diagnostics** | Redacted server posture. **Audited diagnostics export** returns durable status; download appears only when worker-ready. |
| **Audit** | Append-only administrative activity with server-owned action outcome and target. |

The UI never polls an export automatically, retains export bytes, or constructs
storage links. Request an expired/unavailable export again through its audited
flow. Read [Operations](./operations.md), [persistence and recovery](./persistence-recovery.md),
and [troubleshooting](./troubleshooting.md) for recovery procedures.

## Access & security

**Route:** `#/access`
**Visible with any of:** `workspace.manage`, `identity.manage`, or
`credential.manage`.

This is the canonical shared secret-reference registry. Integration and AI forms
can select a redacted registration but do not own its lifecycle.

### External secret reference lifecycle

Use **Register where a secret lives** only after a deployment operator has put
the actual value in the server-side secret backend/environment. The bundled
open-source resolver accepts an opaque locator shaped as `env:UPPERCASE_NAME`,
for example `env:CASEWEAVER_PROVIDER_KEY`. That string names where the server
resolves a value; it is not a password, token, or key.

After **Register reference**, the form clears its transient locator. Later
screens show only generated registration identity, lifecycle, timestamps, and
active-configuration dependency count. Descriptors select the registration, not
its locator or value.

Rotate the actual value outside CaseWeaver first, then use **Mark rotation
required** and **Confirm rotation**. **Revoke** is guarded and blocked while
active configuration depends on the reference. Inspect dependencies and replace
or disable dependent configuration first. Audit events contain the reference
identity, never its value.

### Workspaces, principals, and roles

**Workspaces** and **Principals** are server-resolved read-only views. The UI
cannot manufacture a membership or identity. **Replace an operator's role set**
chooses a server-listed principal and code-defined role set for the active
workspace. It reads the membership revision before replacement; final
administrator protection, effective permissions, workspace scope, history, and
audit attribution remain server-owned.

Do not confuse a role assignment with an OIDC mapping or a trusted origin;
identity bootstrap/origin/proxy policy are deployment configuration.

## Platform

**Route:** `#/platform`
**Navigation permission:** `configuration.read`.

Platform reports safe runtime capability, readiness, authentication posture, and
deployment-owned state without disclosing secret values or trusted proxy/OIDC
configuration. **Public links** may be editable only when its surface is
managed. It configures the workspace public API and webhook bases; the API
normalizes URLs and derives only fixed opaque webhook routes.

Use HTTPS unless deployment policy explicitly permits loopback HTTP. This form
cannot configure OIDC issuer/client settings, trusted proxies, CORS origins,
database, or TLS. See the [deployment reference](./deployment-reference.md).

## Operator playbooks

### Register and use a secret reference

**Prerequisites:** a deployment operator has provisioned the secret value in its
backend, and your role can manage credentials.

1. Open **Access & security** and enter only an opaque **External secret
   reference**. The bundled resolver uses `env:UPPERCASE_NAME`.
2. Select **Register reference** and record the generated registration identity,
   not a secret value or locator.
3. In the appropriate descriptor form, select the redacted registration.
4. Rotate the backing value outside CaseWeaver, then confirm rotation in the
   registry.
5. Before revoke, inspect dependencies; a dependency block is an expected safe
   outcome. Replace/disable dependent configuration first.

**Expected result:** a selectable active registration with no value/locator in
browser state, resource detail, audit data, or logs.

### Connect and synchronize knowledge

**Prerequisites:** active embedding binding and hard embedding budget; registered
connector descriptor; active connector after its optional bounded test.

1. In **AI configuration**, activate an embedding-capable provider, refresh its
   inventory, create/activate an `embedding` binding, set required price, and
   replace the hard budget.
2. In **Knowledge & Analysis**, create the immutable collection with exact
   compatibility profile and vector dimension.
3. In **Integrations**, create/test/activate the connector through its dynamic
   descriptor; use its help, not fields assumed from another connector.
4. Create the source draft with collection, profiles/versions, batch size,
   budget, attachment behavior, synchronization policy, and deletion behavior.
   Activate it.
5. Run **Synchronize** or create/activate the pinned schedule. Use **Full
   rescan** only for a deliberate controlled re-evaluation.
6. Inspect source state, **Jobs**, **Costs**, and **Audit**. A browser message
   accepts a command; durable resource state proves completed work.

**Expected result:** collection binding remains pinned and source/schedule never
silently follow a later configuration version.

### Onboard a provider and run a bounded test

**Prerequisites:** registered provider descriptor; secret registration if
required; known/enriched or complete overridden price; compatible hard budget
when the test requires it.

1. Register the credential's opaque reference in **Access & security**.
2. In **AI configuration**, select the server-provided **Registered type**,
   complete only its dynamic fields, and create the draft.
3. Choose **Review and activate provider**. A saved draft is not executable.
4. Select the active provider and **Refresh models available from provider**.
5. Create/activate a binding from its returned inventory, select the CaseWeaver
   role and safe limits, and set a workspace role default if appropriate.
6. Refresh the trusted catalog only for enrichment. It does not authorize a
   model absent from provider inventory. Add a complete override only for that
   provider-owned model when required.
7. Set/replace the budget, request the test preview, review cost/impact/expiry,
   and confirm once.

**Expected result:** a durable operation result, attributed cost when available,
and audit evidence without a credential or raw provider response.

### Configure repository-assisted case analysis

**Prerequisites:** eligible case source; active analysis/retrieval/prompt/
publication versions; required AI bindings/budgets; and, when used,
repository-agent binding plus deployment-approved sandbox policy.

1. In **Repository analysis**, create/test/activate the code repository and
   execution policy. Use a credential-free transient remote URL or deployment
   mount alias, never a host path or embedded credential.
2. In **Knowledge & Analysis**, create/activate attachment policy if needed,
   then create/activate the analysis recipe. Choose optional/required repository
   and attachment evidence deliberately.
3. In **Integrations**, create/activate a case trigger that pins recipe and
   publication profile. Choose polling or connector-verified webhook.
4. For polling, create/activate the case intake schedule; for webhooks, use the
   verified endpoint. Both enqueue durable work with the same pinned identity.
5. Inspect **Analyses**, **Publications**, **Jobs**, **Costs**, and **Audit**.

**Expected result:** each case run captures its immutable recipe, repository
commit/evidence policy, attachment evidence, prompt/context path, model binding,
and publication policy. A retry cannot silently use newer configuration.

### Find audit evidence

1. Stay in the workspace where the action ran.
2. Open **Operations → Audit** and use safe identity/time/request/correlation
   metadata exposed by the API to inspect the target/action.
3. Open target resource history. For accepted background work, also inspect its
   job, analysis, publication, cost, or export record.
4. Treat denial, validation failure, and `outcome_unknown` as auditable outcomes.
   Do not replay a mutation until durable state is known.

The server owns actor, workspace, action code, target, permission, and outcome.
Audit details intentionally exclude secret values/tokens, raw request bodies,
remote responses, and protected prompt/context content.

## Availability and error semantics

| UI state | Meaning | Safe next action |
| --- | --- | --- |
| Loading | The Console awaits a bounded API response. | Wait or use visible retry; do not duplicate a mutation. |
| Empty | No workspace-scoped records exist. | Complete the stated prerequisite or create the offered draft. |
| Denied/hidden | Effective permission is absent. | Ask an authorized workspace administrator; do not construct an undocumented browser request. |
| Unavailable/read-only | Runtime has not registered a managed workflow or a dependency is unavailable. | Check deployment composition, server descriptors/options, and Platform/Operations evidence. |
| Validation failure | API rejected the authoring input or state. | Correct only the stated safe value; never add a credential to JSON/URL. |
| Concurrency conflict | Another change made the displayed revision stale. | Reload, review current state, then create a deliberate successor. |
| Test/action failed | A bounded server operation reached terminal failure. | Inspect resource, job/cost records, and audit outcome; repair at the proper plane. |
| `outcome_unknown` | Completion cannot be asserted safely. | Inspect durable evidence before retrying; prevent duplicate external work. |

## Resource visibility and lifecycle map

| Area | Resource panels | Normal Console behavior |
| --- | --- | --- |
| Integrations | Connector instances, knowledge sources, schedules, webhooks | Descriptor drafts and resource lifecycle only when advertised; otherwise safe list/show. |
| AI | Provider instances, model bindings, catalog snapshots, role defaults, pricing, budgets | Dynamic provider configuration plus server-owned inventory/binding/price/budget workflows when managed. |
| Knowledge | Collections, retrieval profiles, prompt profiles, analysis profiles, analyses | Collection/policy authoring when managed; analysis views may be intentionally read-only. |
| Repository/case | Code repositories, execution policies, attachment policies, analysis recipes, case triggers/schedules | Dedicated typed drafts, immutable versions, optional tests, and activation. |
| Publication | Publication profiles, publications | Policy lifecycle when managed; durable state/approval only where offered. |
| Operations | Jobs, dead letters, costs, retention, privacy, diagnostics, audit events | Inspection plus narrowly guarded recovery, purge, retention, and export. |
| Access | Secret references, workspaces, principals, role assignments | Canonical secret lifecycle, server-resolved authority, guarded role replacement. |
| Platform | Runtime capability and public links | Safe posture/readiness; public-base authoring only when managed. |

For deployment-time prerequisites and public/secret boundaries, continue to the
[deployment reference](./deployment-reference.md). For an assistant-safe
starting protocol, return to the [operator knowledge map](./operator-knowledge-map.md).
