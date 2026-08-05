# PBI-023: AI-ready operator and deployment reference

## Outcome

Deliver a source-verified, retrieval-friendly technical reference for operating and
integrating CaseWeaver. It must let a human operator and a constrained documentation
assistant understand what the running product can do, where each setting belongs, how
to configure it safely, and how to diagnose a failed setup without inventing product
behavior or exposing credentials.

The documentation is static content. It is not a configuration API, a secret store, an
authorization boundary, or a source of deployment values. It must describe the current
delivery truth in the Admin API, Admin console, configuration validators, Compose
assets, and tested workflows.

## State and dependencies

**Completed.** The documentation portal now provides a source-verified entry map,
dedicated English/French Console and deployment references, a complete safe
configuration catalogue, and static drift checks against current Admin and Compose
contracts. It builds locally without a runtime, Docker daemon, provider call, or
credential.

Depends on completed PBI-016, PBI-017, PBI-018, PBI-020, PBI-021, and PBI-022.
PBI-019 is separately in progress for its protected Cloudflare Pages release evidence;
this PBI builds locally without requiring it.

## Scope

### 1. Operator-console reference

Add a dedicated Console reference that covers every current primary navigation area and
its practical workflows:

1. Overview
2. Integrations
3. AI configuration
4. Knowledge & Analysis
5. Repository analysis
6. Publication
7. Operations
8. Access & security
9. Platform

For each area, state its purpose, required permission/state, available actions,
important inputs in plain language, safe outcomes, immutable/draft lifecycle where
applicable, audit behavior, and the next place to inspect when it fails. Use actual UI
labels and API-owned descriptors; do not imply every descriptor is available in every
deployment.

Include task playbooks for at least:

- registering and managing an opaque external secret reference;
- creating/testing/activating a descriptor-driven connector;
- creating a collection, source, and schedule and synchronizing knowledge;
- onboarding an OpenAI-compatible provider, refreshing provider-owned model inventory,
  binding a model role, setting price/budget policy, and running a bounded test;
- configuring repository-assisted analysis, attachment processing, an analysis recipe,
  and a trigger; and
- finding the server audit history for an action.

### 2. Compose and environment reference

Add a dedicated deployment reference that covers every tracked Compose topology:

- `compose.local.yml`
- `compose.e2e.yml`
- `compose.test.yml`
- `compose.admin.yml`
- `compose.production.yml`
- `compose.portainer.yml`

For each one, identify audience, services, persistence, intended command, network/
exposure boundary, prerequisite artifact or secret-file setup, and whether it is an
evaluation, test, production, or externally hosted Admin topology.

Provide a searchable configuration catalog grouped by runtime, database, session/OIDC,
public origins/proxies, storage, repository analysis, telemetry, Admin artifact, image,
network, and secret-file settings. Each documented variable must give its consumer,
whether it is public/secret/conditional, valid shape/default where verified, supply
location, and failure-safe note. Do not render a real credential, a credential-like
placeholder, or an actual production connection string.

### 3. AI/retrieval-ready structure

Make the pages reliable ingestion units:

- use stable headings, one capability/workflow per section, short declarative tables,
  explicit prerequisites and outcomes, and cross-links instead of duplicated policy;
- distinguish deployment configuration from console configuration and safe metadata
  from secret values;
- describe unavailable/conditional options as such rather than adding speculative
  instructions; and
- link relevant current connector, AI, operations, authentication, and troubleshooting
  guides from the reference entry points.

Maintain equivalent French counterparts using the existing reviewed-translation
workflow. The documentation must remain usable with local static search; it must not
depend on a remote documentation service or an AI provider at build time.

### 4. Source-contract validation

Add focused static documentation tests that fail if the Console reference no longer
covers a registered primary screen or if the deployment reference no longer names the
tracked Compose topologies and their critical public/runtime boundaries. Tests must
avoid matching secret values and must not require Docker, a live provider, or a
credential.

## Non-goals

- Replacing generated API contracts with copied route documentation.
- Publishing a live configuration inventory or secret values.
- Starting deferred MCP/chat work or PBI-019 owner configuration.
- Claiming connector/provider availability that is not discovered from the backend at
  runtime.
- Building or calling a documentation embedding service.

## Architecture decisions

1. The Console reference documents the server-authoritative operator workflow. The
   browser remains a cookie-session client and never receives a provider credential,
   database URL, or authorization decision.
2. Deployment documents distinguish one normal local three-container topology from
   test overlays, the Admin-only bridge, production Compose, and the backend-only
   Portainer topology. They must not reduce production protections to local defaults.
3. A static source-contract test watches stable capabilities/topology names, not every
   prose sentence, so documentation has an early drift signal without turning it into
   generated configuration.

## Delivery modules and workflow

### Module A: Console reference

Architect:

- Inspect actual Admin navigation, authoring forms, API contracts, and existing docs.
- Define source-verified screen/task coverage and documentation invariants.

Senior Developer:

- Implement the English/French Console reference and its links using exclusively
  assigned documentation files.

Automation Developer:

- Add focused static coverage checks for navigation and workflow anchors; independently
  verify build/link/translation status.

### Module B: Deployment and variable reference

Architect:

- Inspect Compose assets, runtime validators, examples, and existing deployment docs.
- Define a safe, complete topology/variable catalog and documentation invariants.

Senior Developer:

- Implement the English/French deployment reference using exclusively assigned
  documentation files.

Automation Developer:

- Add focused source-contract validation for Compose and critical configuration
  boundaries; independently verify build/link/translation status.

The parent owns the PBI, shared sidebar navigation, root documentation links,
translation-manifest integration, and final validation.

## Acceptance criteria

1. An operator can find every current primary Console screen, its purpose, available
   workflows, security/audit boundary, and relevant deeper guide from one reference.
2. The reference provides end-to-end, safe task paths for connector, source/schedule,
   provider/model/binding/budget, repository-analysis, and audit workflows.
3. Every tracked Compose topology is accurately classified and has a safe start or
   inspection path.
4. The configuration catalog distinguishes public, secret, optional, local-only, and
   production/Portainer settings without revealing a secret value.
5. The page structure is stable, concise, cross-linked, and useful as embedding input;
   it never treats examples as credentials or unverified behavior as fact.
6. English and French builds, translation status, focused source-contract checks, and
   existing website tests pass.

## Translation review record

PBI-018 records the repository owner's explicit authorization to use AI validation for
the French documentation delivery. This PBI uses the same repository-owned, local
review workflow: no translation provider, API key, or documentation content is sent to
an external service. The English/French counterparts listed in this PBI were reviewed
against their source contracts before their hashes are recorded in the translation
manifest.

## Delivery evidence

- `website/docs/operator-knowledge-map.md` gives humans and constrained assistants a
  safe decision protocol, retrieval map, input classification, and non-negotiable
  browser/secret rules.
- `website/docs/operator-console-reference.md` and its French counterpart map all nine
  primary Console screens, their current resources and workflows, server-owned
  security/audit behavior, lifecycle semantics, task playbooks, and error/availability
  states to the source of truth.
- `website/docs/deployment-reference.md`, the expanded configuration reference, and
  their French counterparts classify all tracked Compose topologies, distinguish local
  evaluation/test/production/Portainer contracts, and group every operator-facing
  environment input with its validation, supply boundary, and safe automation rule.
- Focused website source-contract tests derive current navigation paths and Compose/
  published deployment inputs, detect coverage drift, and reject credential-bearing
  documentation patterns.
- Final validation passed:
  - `pnpm --dir website test` (25 passing)
  - `pnpm --dir website typecheck`
  - `pnpm --dir website build` (English and French)
  - `pnpm --dir website translations:status`
  - `git diff --check`

## Remaining work

None for PBI-023. PBI-019 remains separately in progress for live protected
publish/cleanup verification and custom-domain association.
