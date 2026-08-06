---
sidebar_position: 1
title: Operator knowledge map
---

# Operator knowledge map

**Purpose:** this page is the safe starting point for a person or an AI assistant
that is helping configure CaseWeaver. It explains which document answers which
question and, just as importantly, which values must never be requested, inferred, or
stored in a browser.

CaseWeaver has two configuration planes:

| Plane | What belongs there | Where to start |
| --- | --- | --- |
| Deployment | Container images, database and secret files, public origins, OIDC bootstrap, TLS, mounts, storage, and process topology. | [Deployment reference](./deployment-reference.md) |
| Operator console | Workspace-scoped, server-audited configuration such as connectors, sources, AI provider instances, bindings, budgets, repository-analysis recipes, and publication policy. | [Operator-console reference](./operator-console-reference.md) |

Do not move a deployment setting into the browser because a Console field is not
visible. Do not move a Console setting into Compose because it is available in an
environment variable. These boundaries protect workspace isolation, immutable history,
auditing, and credential disclosure.

## Safe configuration protocol

Use this protocol before proposing a configuration change:

1. Identify the objective, target workspace, and whether it is an evaluation or a
   persistent installation.
2. Read the relevant task page and its **Prerequisites**. Check the running Console's
   server-provided descriptor or option list rather than assuming a connector, provider,
   model, binding, repository mount, or permission exists.
3. Classify every required input as one of: public setting, opaque identifier,
   deployment secret reference, or secret value. Only a deployment operator supplies a
   secret value to its secret backend or file. The Console receives only a redacted
   secret-reference registration ID after it is created.
4. Create a draft where the Console offers one. Validate or run the explicitly bounded
   test. Review the server-provided impact and cost information, then activate only the
   exact immutable version that was tested.
5. Verify the durable result in the named resource panel and use **Operations → Audit**
   to find the server-owned action outcome. Do not treat a browser click as proof of a
   completed background operation.

An assistant should present a proposed change in this compact form:

| Item | Required answer |
| --- | --- |
| Objective | What outcome the operator wants, without inventing a provider or connector. |
| Plane | Deployment or Console, with the specific page/screen. |
| Preconditions | Existing active records, permissions, mount/secret/backend capabilities, and budget requirements. |
| Inputs | Public values and opaque IDs only. State where a deployment operator must supply a secret without asking for it in chat. |
| Action | Draft, test/preview, activate, synchronize, or inspect—using the server-provided workflow. |
| Expected result | The durable state to find in the Console/API read model. |
| Evidence | The resource history, job/publication state, cost record, and server audit event to inspect. |
| Safe failure path | The exact guide or deployment check to use; never a workaround that weakens identity, CSRF, auditing, TLS, or isolation. |

## Non-negotiable safety rules

- Never request, repeat, log, put in a URL, or put in browser storage an API key,
  password, OAuth token, cookie, private key, database URL, or other credential value.
- Use an opaque external secret reference such as `env:CASEWEAVER_PROVIDER_KEY` only
  when the server deployment exposes that name through its configured secret backend.
  The name is metadata; its value is never a Console input or API response.
- Never fabricate a connector type, provider type, model identity, model price, model
  capability, source filter, repository mount, or permission. The backend descriptor,
  catalog, and option lists are authoritative for the running deployment.
- Treat unknown price as a blocked cost decision, not zero cost. Configure an explicit
  allowed price/budget policy before approving a metered test when the API requires it.
- Do not bypass a failed provider, connector, repository, OIDC, authorization, or audit
  check with direct database access, direct browser calls, a broader trusted origin, or
  a disabled security control.
- A disabled, unavailable, or read-only Console control is an explicit server state. It
  is not an invitation to construct an undocumented API request.

## Retrieval map

Use the most specific page first. Each page has stable, self-contained sections so it
can be indexed independently.

| Need | Primary reference | Supporting reference |
| --- | --- | --- |
| Learn every Console screen, its resources, workflow, and audit result | [Operator-console reference](./operator-console-reference.md) | [Access and secrets](./access-and-secrets.md) |
| Start a local evaluation or choose a Compose topology | [Deployment reference](./deployment-reference.md) | [Quick start](./quick-start.md) |
| Configure a Git/Markdown knowledge source | [Git / Markdown](./git-markdown.md) | [Connector capability matrix](./connectors.md) |
| Configure a Jitbit source/case/destination adapter | [Jitbit](./jitbit.md) | [Knowledge and analysis](./knowledge-analysis.md) |
| Configure an AI provider, model inventory, binding, pricing, or budget | [AI configuration and cost](./ai-and-cost.md) | [Operator-console reference](./operator-console-reference.md) |
| Configure a repository-assisted case-analysis flow | [Knowledge and analysis](./knowledge-analysis.md#repository-assisted-case-analysis) | [Operator-console reference](./operator-console-reference.md) |
| Recover a job, inspect costs, retention, privacy, diagnostics, or audit | [Operations](./operations.md) | [Troubleshooting](./troubleshooting.md) |
| Install, upgrade, recover, or verify an image release | [Self-hosting](./self-hosting.md) | [Persistence and recovery](./persistence-recovery.md) |

## Capability truth

The documentation explains the delivered operator path, but the deployment still decides
which safe descriptors and options are registered. A page can describe how a dynamic
provider or connector behaves without promising it appears in every installation.

For intentionally deferred capabilities, use [Capability status](./capability-status.md)
instead of creating a setup plan. For an error, begin with
[Troubleshooting](./troubleshooting.md) and preserve the server request/correlation ID
if one is shown; do not include sensitive request content in a support report.
