---
sidebar_position: 15
title: Capability status
---

# What is supported today

This page separates delivered instructions from planned work. The running control plane
remains the authority: it advertises whether a configuration surface is managed,
read-only, or unavailable for the signed-in workspace and role.

| Capability | Status | Operator path |
| --- | --- | --- |
| Static documentation portal | Available | This site; it has no runtime API or secret dependency. |
| Local evaluation stack | Available | `compose.local.yml`; loopback only and disposable. |
| Production self-hosting | Available | Digest-pinned production images and the operations helper. |
| Password and OIDC sessions | Available | Deployment-owned configuration; API-managed cookies. |
| Git/Markdown knowledge source | Available | Descriptor draft, bounded test, source, schedule, synchronize. |
| Jitbit knowledge/case/destination | Available where the server advertises the surface | See the descriptor and [Jitbit guide](./jitbit.md). |
| AI provider inventory, bindings, prices, budgets | Available | Server-owned provider refresh and guarded capability test. |
| Repository-assisted analysis | Available where the server advertises its managed workflows | Use the Console's Repository analysis / Knowledge & Analysis / Integrations areas. |
| MCP and evidence-aware chat | Deferred | No setup path is published. |

## Important limits

The console does not fabricate CRUD for a missing API contract. A source, collection,
schedule, analysis profile, publication profile, and destination are different records;
creating one never enables the others. Some operational records are intentionally
read-only. Any unavailable workflow must be enabled by a compatible backend release and
an authorized role, not by editing browser requests.

The release record, configuration surface metadata, and this guide are updated together
when a capability changes. Do not infer support from a backlog name or source file.
