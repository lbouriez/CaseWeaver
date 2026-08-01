---
sidebar_position: 14
title: Troubleshooting and terminology
---

# Troubleshooting

Start with a bounded, safe observation. Do not bypass OIDC, disable authorization, paste
a secret into diagnostics, delete a production volume, or run destructive SQL to make a
symptom disappear.

| Symptom | First safe check | Safe recovery |
| --- | --- | --- |
| Console cannot sign in | Check exact `ADMIN_ALLOWED_ORIGINS`, configured sign-in method, and edge health. | Correct deployment configuration; cookies/tokens are not a workaround. |
| OIDC callback fails | Compare public HTTPS origin, issuer client registration, callback, certificate hostname, and trusted proxy CIDR. | Fix the identity/deployment contract, then retry sign-in. |
| Connector test fails | Check descriptor settings, reference lifecycle, HTTPS endpoint, and runtime reachability. | Correct the configuration and rerun the bounded test. |
| Local Git source is rejected | Verify real/canonical paths, allowed root containment, read permission, and read-only overlay. | Correct the reviewed local overlay; do not widen roots. |
| Provider model is absent | Activate provider then refresh its provider-owned inventory. | Do not bind a global catalog model or manually submit an ID. |
| Capability test is blocked | Inspect binding role, price components, hard budget, and server preview. | Complete the missing safe configuration; unknown price is not zero. |
| Source or schedule cannot activate | Inspect the server-advertised surface and prerequisite collection/source state. | Create/enable the prerequisite or use an authorized compatible deployment. |
| Publication is uncertain | Check the retained receipt/status and destination marker. | Reconcile `outcome_unknown` before another write. |
| Production readiness fails | Check private PostgreSQL, explicit migration, runtime role grants, and selected mode's upstreams. | Preserve redacted logs; do not grant DDL to runtime. |
| Backup/restore fails | Keep runtime stopped and preserve dump/manifest. | Validate bucket/prefix/S3 access and PostgreSQL output; helper never deletes target objects. |

## More terms

**Immutable version** is the configuration snapshot a run selects. **Optimistic
concurrency** prevents an operator from overwriting a newer change. **Outbox** is the
database record that makes state and queued work commit together. **Lease** gives a
worker temporary ownership of a durable job. **Outcome unknown** means an external write
may have happened and must be reconciled, not blindly retried.

Every operator action has server-owned actor, workspace, permission, target, outcome,
and audit metadata. Audit records deliberately omit request secrets, prompt content,
URLs with credentials, provider responses, and storage locators.
