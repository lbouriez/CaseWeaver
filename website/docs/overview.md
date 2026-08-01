---
sidebar_position: 1
title: Welcome
---

# CaseWeaver, in one page

CaseWeaver helps a support team investigate a case with the company knowledge that
matters, then keep the evidence and operational decisions with the result. It is a
server-operated control plane, not a browser extension, shared password vault, or
generic chatbot.

```text
knowledge / cases / verified events
                |
         durable queued work
                |
  evidence, bounded AI work, governed result
                |
       review or internal publication
```

The browser is only the operator console. It receives a server-managed session and
redacted configuration records; it does not receive a database URL, connector token,
provider key, or OAuth token.

## Start in the right place

- New to the project: follow [Quick start](./quick-start.md).
- Signing in or registering a secret location: read [Access and secrets](./access-and-secrets.md).
- Connecting content: begin with the [connector matrix](./connectors.md).
- Installing a durable instance: read [Self-hosting](./self-hosting.md), not a
  development Compose file.

## Words used in this guide

| Term | Meaning |
| --- | --- |
| Connector instance | A tested, versioned connection to one external system. |
| Knowledge source | The selected content and filter policy drawn from a connector. |
| Collection | An immutable embedding-space identity that receives indexed knowledge. |
| Schedule | A separate, durable trigger for a source or case intake. |
| Analysis / publication profile | Versioned policy for producing a result / sending an approved result. |
| Secret reference | An opaque pointer to a value held by the deployment secret backend. |

## Availability labels

**Available** means the running API advertises a managed workflow. **Read-only** means
the console can show the server-owned record but cannot safely create or change it.
**Unavailable** means no documented browser workaround exists. Check
[Capability status](./capability-status.md) before treating a planned capability as an
operator task.
