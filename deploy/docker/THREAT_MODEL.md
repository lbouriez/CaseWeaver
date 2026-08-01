# Production Compose threat model

`compose.production.yml` is the small-installation production boundary for
CaseWeaver. It protects the control plane and its durable data; it does not turn Docker
Compose into a cloud identity, secret-management, DDoS, or multi-region availability
service. Operators remain responsible for the host, firewall, registry access, backup
retention, and the identity provider.

## Assets and trust boundaries

| Asset | Boundary | Protection | Operator responsibility |
| --- | --- | --- | --- |
| Operator browser session | Public TLS edge to API | Same-origin HTTPS, server-managed `HttpOnly` cookie, CSRF checks, server authorization/audit | Publish only the edge ports; use a real public DNS name and trusted certificate. |
| OIDC and password secrets | Docker secret files | Read only by the API/standalone process through the entrypoint; never browser/runtime-config values | Create restrictive host files, rotate them, and remove bootstrap password login when OIDC is ready. |
| Connector/provider/repository secrets | Read-only application-secret directory | Loaded only by API/worker/standalone process; no Compose interpolation or command arguments | Allow only safe environment-variable filenames, restrictive directory permissions, and a host secret manager when available. |
| Database schema and queue | Migration role vs runtime role | Explicit forward-only migration job; runtime role receives DML-only grants | Keep the migration URL separate, never give a runtime service migration credentials, and run the helper before an upgrade. |
| PostgreSQL data | Private data network + named volume | No host port; only migration/runtime services join the data network | Encrypt/protect the Docker host and volume, retain tested backups, and monitor disk capacity. |
| Attachment/object data | Worker/standalone to S3-compatible store | Encrypted S3 configuration, opaque keys, no browser storage URLs; no-network attachment processor | Use a least-privilege bucket identity, versioning/retention, and a separately protected backup bucket. |
| TLS private key | Isolated `tls-material` holder | Root/no-network holder copies file-secret material to a private tmpfs volume; edge runs non-root and has no direct host key mount | Renew source certificate/key files and deliberately recreate `tls-material` plus edge after renewal. |
| Release identity | OCI digest and GitHub attestations | Digest-only Compose validation, image/SBOM scan gate, provenance/SBOM verification | Verify the digest and attestation before changing production; do not substitute a tag or `latest`. |

## Threats and controls

| Threat | Design response | Residual risk / response |
| --- | --- | --- |
| Direct database or backend access | Only `edge` publishes ports; data/application networks are internal. | A Docker-host administrator can still inspect containers. Limit host administration and monitor Docker access. |
| Header spoofing or TLS termination confusion | Edge replaces forwarded headers; API trusts only the configured fixed edge CIDR. | Do not add another proxy without updating trusted-proxy configuration and test it through the production runner. |
| Session/token leakage to browser storage | Static Admin owns no secret; API manages cookie session; acceptance test checks browser storage. | Browser compromise/XSS remains a client risk; keep dependencies patched and use short, server-controlled session policy. |
| Secret in image, logs, or Compose config | Builds reject secret inputs; runtime uses files; entrypoints issue redacted failure messages. | Secret files and Docker inspect access are host-sensitive. Keep files outside the repository and CI logs. |
| A runtime service changes schema | Dedicated migration/queue/grant jobs use the migration role; runtime role cannot create tables. | A migration credential compromise is high impact. Store it separately and use only during controlled maintenance. |
| Unsafe attachment archive reaches host tools | Attachment processor has no network, database, Git, provider, or Docker socket; it shares only bounded UDS/jobs state. | Parser vulnerabilities still require image patching. The image scan gate and resource ceilings reduce, not eliminate, this risk. |
| Provider/object-store exfiltration | Only worker/standalone joins egress and receives object credentials; `object-store-operations` is explicit profile only. | Egress is intentionally required for connectors/providers. Restrict host/network egress where the installation permits it. |
| Supply-chain substitution | Deployment helper rejects mutable images; release verifies scan reports plus provenance and SBOM attestations by digest. | Trust still includes GitHub Actions, registry, and operator verification. Mirror images plus attestations for disconnected environments. |
| Failed backup/restore when needed | Backup captures PostgreSQL plus the configured object prefix and manifest; CI performs an isolated restore drill. | The drill uses small data. Schedule organization-specific recovery drills and measure their real RPO/RTO. |

## Explicit non-goals

- This topology does not provide high availability, multi-region replication, automatic
  failover, or zero-downtime schema migration.
- Docker secrets here are file mounts, not a replacement for a managed secret manager.
- The TLS holder is a practical Compose isolation measure, not a hardware root of trust.
- Registry attestation confirms build identity and integrity; it does not certify an
  application is free of all vulnerabilities or suitable for every deployment.

## Security operations

1. Allow inbound traffic only to the edge HTTP/HTTPS bindings; redirect HTTP to HTTPS.
2. Keep `ADMIN_ALLOWED_ORIGINS`, `OIDC_CALLBACK_URL`, and the public certificate DNS
   name aligned. Never use a private Docker hostname as an OIDC callback.
3. Treat the migration database URL, runtime database URL, S3 identity, OIDC secret,
   TLS key, and application-secret directory as independent secret rotations.
4. Before an upgrade, verify every digest and attestation, run a backup, migrate, then
   start exactly one runtime mode. Roll back an image only if the schema remains
   compatible; otherwise restore the tested backup.
5. Investigate a failed `/health/ready` response, database-role denial, audit failure,
   or backup manifest mismatch as a deployment failure rather than bypassing it.
