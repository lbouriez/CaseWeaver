---
sidebar_position: 10
title: Self-hosting
---

# Self-hosting a production installation

**Availability:** supported with the release record's digest-pinned linux/amd64 images.
Use this guide for production; do not promote a local Compose image or development
password into a public deployment.

## Prepare and validate

The canonical, source-verified procedure is now [Deployment reference](./deployment-reference.md#self-hosted-production-composeproductionyml).
It defines the Compose profile boundary, public edge, durable data, operator-owned
environment file, exact helper commands, and backup/restore behavior. The full input
catalog is [Configuration reference](./configuration-reference.md).

Create an operator-owned directory outside the checkout. Copy
`deploy/docker/.env.production.example` to it, fill public configuration, and put every
secret in its own restrictive file. The environment file contains no password, token,
private key, or credential-bearing database URL. Application connector/provider values
live as safe-named files in `CASEWEAVER_APPLICATION_SECRETS_DIRECTORY`; they are mounted
only into processes that need server-side execution.

Use the release record's exact `image@sha256:...` identities for every image. Verify its
provenance and SPDX attestation, then use the helper:

```powershell
node deploy\docker\production-operations.mjs validate --env-file <operator-env-file>
node deploy\docker\production-operations.mjs migrate --env-file <operator-env-file> --mode standalone
node deploy\docker\production-operations.mjs start --env-file <operator-env-file> --mode standalone
```

Migration is explicit and forward-only. It runs Prisma and the queue migration before
runtime start, then grants the separate runtime role. Never give API/worker runtime
credentials DDL rights just to make readiness pass.

## Edge, authentication, and modes

Only the Nginx TLS edge publishes ports. It redirects HTTP to HTTPS, serves Admin
same-origin, and proxies the API/health/webhook routes. Set one exact public HTTPS
origin in `ADMIN_ALLOWED_ORIGINS`; keep certificate/private-key material in secret
files. `TRUSTED_PROXY_CIDRS` must name only the fixed internal edge subnet.

Production normally uses OIDC as described in [Access and secrets](./access-and-secrets.md).
Password login is a temporary, deliberate break-glass option with non-default file-based
credentials and restricted access.

Choose exactly one mode. `standalone` is the small default: API, webhook, scheduler,
worker, and relay share one backend process. The restricted attachment processor remains
a separate no-network Unix-socket sidecar in both modes. `distributed` separates the
backend modules while retaining the same PostgreSQL queue, data, and attachment sidecar.
To change mode: back up, stop the old mode, migrate the selected release, set the two
edge upstreams for the new mode, then start it. It is a controlled restart, not a
zero-downtime transition.

Check `https://<public-origin>/health/live` and `/health/ready` through the edge. Use
redacted service logs and the safe diagnostic export for investigation.

For a backend-only Docker Standalone deployment with an externally hosted Console, use
the separate [Portainer section](./deployment-reference.md#portainer-backend-with-an-externally-hosted-admin-composeportaineryml). It is not an alternative way to run the
embedded production Admin stack.
