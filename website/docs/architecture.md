---
sidebar_position: 2
title: Architecture
---

# Architecture orientation

CaseWeaver keeps delivery concerns at the edge and business rules toward the center.
Applications receive requests and compose dependencies; feature and application layers
coordinate use cases; the domain remains independent of HTTP, databases, connectors,
and AI providers.

```text
Browser, API, scheduler, webhook apps
                |
     application and feature use cases
                |
              domain
```

Long-running work is designed to move through durable queue and worker boundaries rather
than execute directly in a scheduler or webhook request. External systems are integrated
through named connectors, providers, or infrastructure adapters. AI calls travel through
the metered execution boundary rather than a feature-specific provider shortcut.

These are architecture principles, not an operations runbook. Consult the capability
status page before relying on a particular deployment, connector, or administrative
workflow.
