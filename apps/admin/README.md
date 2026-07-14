# CaseWeaver operator console

`@caseweaver/admin` is a static React-Admin control room. It presents audited,
permission-aware administration workflows; it is not an authorization, connector, AI,
queue, database, secret, or policy boundary. The browser only calls the CaseWeaver API
with cookie credentials.

## Runtime hosting contract

The built files are deployment-neutral. Before serving them, the container, reverse
proxy, or static-host initialization step **must** place this file at the web root:

```json
{
  "apiBaseUrl": "https://caseweaver.example.com",
  "uiTitle": "CaseWeaver Control Room"
}
```

Use [`public/runtime-config.example.json`](public/runtime-config.example.json) as the
template. It becomes `runtime-config.example.json` in `dist`; deployment must write or
mount `runtime-config.json` alongside it. The console fetches that asset before React
boots, with `no-store` caching. `apiBaseUrl` is an absolute credential-free HTTPS URL;
HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` development. No API URL,
OIDC configuration, credential, or secret is compiled into the bundle.

For local development, copy the example to `public/runtime-config.json`, substitute a
local API URL, and do not commit that file.

## Planned API dependencies

Live operation requires PBI-016 API work that is not yet implemented. The app therefore
shows an accessible unavailable state—never sample records—until these typed endpoints
exist:

- Session control: `GET /v1/auth/session`, `GET /v1/auth/login`,
  `POST /v1/auth/logout`, and `POST /v1/auth/session/workspace`.
- Descriptors: `GET /v1/admin/descriptors/connectors` and
  `GET /v1/admin/descriptors/ai-providers`.
- Resource-specific, cursor-paginated `GET /v1/admin/*` routes listed in
  `src/api/contracts.ts`, including integrations, AI, knowledge, publication,
  operations, access, and platform summaries.
- Draft configuration routes:
  `POST /v1/admin/connector-instances/drafts` and
  `POST /v1/admin/ai/provider-instances/drafts`.
- Guarded action routes: `POST /v1/admin/action-previews` and
  `POST /v1/admin/actions/execute`.

Responses must match the Zod-validated local boundary DTOs. Authenticated responses
provide effective permissions and a CSRF token; all mutations require that token and
the API remains responsible for authorization, idempotency, impact/cost calculation,
audit writes, and outcome reconciliation.

## Security and UX boundaries

- OAuth/OIDC is API-managed. Tokens are never persisted or inspected by this app.
- Requests include cookies, UI action/correlation IDs, idempotency headers for
  mutations, and an explicit passive-polling marker when used.
- Descriptor forms are schema-driven without connector/provider name conditionals.
  Secret slots are redacted notices, never credential inputs or returned values.
- Costly or destructive actions cannot be enabled until the server provides an
  expiring impact/cost preview. `outcome_unknown` is displayed as unresolved.
- The console intentionally provides read-only lists/shows for operational resources;
  it does not invent generic CRUD for workflows whose API contract is absent.

## Commands

```powershell
pnpm --filter @caseweaver/admin dev
pnpm --filter @caseweaver/admin typecheck
pnpm --filter @caseweaver/admin test
pnpm --filter @caseweaver/admin build
```

The live console remains blocked on the backend contracts above. Static build and
component/client tests do not pretend that OAuth, API auditing, descriptors, or
operations exist without that control-plane support.
