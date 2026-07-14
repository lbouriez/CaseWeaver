# PBI-016: React-Admin operator console

## Outcome

Provide a lightweight, authorized operations UI over CaseWeaver's existing API. The UI
must expose configuration, job status, cost, retrieval, publication, and recovery
workflows without duplicating domain policy in the browser.

## Existing implementation reference

Review `C:\GIT\ReKindle\App\admin` before implementation. It is a Vite/React
administrative application and provides practical reference for project layout, build
configuration, authentication shell, resource navigation, and API integration.

Use it as behavioral and structural reference material only. CaseWeaver must not copy
its credentials, branding, backend assumptions, or business logic.

## Scope

- Vite + TypeScript + React-Admin application in `apps/admin`.
- Authenticated API client and `dataProvider` that uses CaseWeaver's authorized,
  workspace-scoped API only.
- Read resources for connector/source synchronization, knowledge collections, AI
  bindings/catalog prices, budgets/cost operations, retrieval snapshots, analyses,
  publication intents/attempts, queue/dead letters, and audit events.
- Operator actions: trigger analysis, approve/reject publication, retry/cancel eligible
  jobs, inspect failed work, and export redacted diagnostics.
- Forms for permitted configuration management through explicit API endpoints.
- Status dashboard with queue, synchronization, publication, budget, and failure
  signals; server remains the source of truth.
- Accessible loading, error, empty, and authorization-denied states.

## Rules

- The browser never receives connector, provider, checkout, webhook, or database
  secrets. It never directly calls a connector, model provider, database, queue, or
  object store.
- Do not recreate authorization, budgets, publication policy, markdown/HTML rendering,
  or idempotency in the UI. Submit explicit commands to the API and render server
  results.
- All mutation screens require server authorization and display auditable operation
  identities/statuses. Hide unavailable actions for usability, but treat the API as the
  enforcement boundary.
- Keep chat and MCP out of this PBI. PBI-014/PBI-015 remain deferred.
- Use resource-specific DTOs; do not expose Prisma/domain/internal connector records
  directly as a generic admin data model.

## Acceptance criteria

- An authorized operator can view operational state and safely execute each supported
  operational command without using a CLI.
- Unauthorized workspace/resource access is rejected by the API and rendered as an
  actionable UI error without leaking protected metadata.
- Trigger, approval, retry, cancellation, and diagnostic-export UX preserves the
  server-generated idempotency/audit correlation identifiers.
- No secret appears in browser bundles, network payloads, local storage, errors, or
  diagnostics.
- The frontend builds independently and has focused component/API-client tests for
  permission states and mutation outcomes.

## Excluded

- End-user support chat, MCP configuration, visual workflow editing, and embedded
  connector/provider credentials.
