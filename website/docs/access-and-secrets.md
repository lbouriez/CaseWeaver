---
sidebar_position: 3
title: Access and secrets
---

# Access, sessions, and secret references

**Availability:** deployment authentication and the Access & security registry are
available. The console never becomes a secret store.

## Sign-in is deployment configuration

The local development stack enables password sign-in with `admin` / `admin`. The API
does not return the password and the browser does not retain it after the sign-in request.
For production, password authentication is disabled unless the deployment deliberately
sets `ADMIN_ENABLE_PASSWORD_AUTHENTICATION=true` with non-default `ADMIN_LOGIN` and
`ADMIN_PASSWORD` secret files.

OIDC is an optional API-managed Authorization Code + PKCE sign-in method. All of
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CALLBACK_URL`,
`OIDC_EPHEMERAL_ENCRYPTION_KEY`, and `OIDC_EPHEMERAL_KEY_ID` must be present together.
Outside explicit localhost development, the callback is an HTTPS URL ending in
`/v1/auth/callback`. A fresh installation may pair `ADMIN_BOOTSTRAP_OIDC_SUBJECT` with
`ADMIN_BOOTSTRAP_DISPLAY_NAME` once to create its first administrator mapping; remove
those bootstrap values afterwards.

Complete OIDC adds an OIDC choice while password login remains available unless
`ADMIN_DISABLE_LOGIN_AUTHENTICATION=true` is deliberately set. That OIDC-only setting
is invalid without complete OIDC configuration. `ADMIN_ALLOWED_ORIGINS` is an exact
browser-origin allowlist. Forwarded headers are trusted only from the configured
`TRUSTED_PROXY_CIDRS`; a TLS edge does not make arbitrary proxy headers trustworthy.

The API owns `HttpOnly` cookie sessions, CSRF tokens, state, nonce, PKCE validation,
workspace switches, authorization, and login/logout/workspace-switch audit records.
There is no localStorage token fallback.

## External secret references

Go to **Access & security → Secret references** to register an opaque locator such as
`env:CASEWEAVER_OPENROUTER_KEY`. It names a value already available to the server's
configured secret backend; it is not the value itself. The console returns only a
generated registration ID and lifecycle/dependency metadata. It never displays the
locator or secret value after registration.

Select that redacted registration in a connector or AI provider form. Rotate the value
in the external backend first, then choose **Confirm rotation**. **Revoke** is guarded
and denied while active configuration depends on it. This shared registry is the only
place to manage lifecycle metadata; integration screens only select a registration.

Every read, request, draft, activation, test, rotation, revoke, sign-in, and workspace
switch is authorized, workspace-scoped, idempotent where needed, and server-audited.
