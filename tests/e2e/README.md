# End-to-end tests

**PBIs:** 013, 016

Docker-based workflows from source synchronization through analysis and destination
publication, plus webhook, scheduler, failure recovery, and security-boundary scenarios.

`admin-auth-browser.spec.ts` builds and serves the static admin console and composes it
with a live Fastify `/v1/auth/*` route surface in deterministic Chromium. Its test-only
OIDC/persistence/audit fixture composes the real API route tree and session service; it
neither enables a production fake-auth mode nor calls a real identity provider. It
verifies browser cookie handling, callback return to the trusted console origin,
CSRF-protected workspace rotation, logout, and server-owned audit actions.

Set `CASEWEAVER_E2E_ADMIN_ORIGIN` to a running static host to run the same journey
through it. PBI-016 validates `http://127.0.0.1:8082` after building the admin artifact
and starting `deploy/docker/compose.admin.yml`; the test fixture remains the API/OIDC
boundary and the container receives only public runtime configuration.
