---
sidebar_position: 1
title: Overview
---

# CaseWeaver documentation

CaseWeaver is being built as a durable, evidence-aware case-operations system. Its
documentation must distinguish between a delivered capability, work that is available
only for development evaluation, and planned work.

This first portal release provides the shared vocabulary, architecture orientation, and
capability-status boundary. It does **not** yet replace the verified operator guides
that depend on the accepted runtime, administration, and self-hosting contracts.

## Read this first

1. Review [architecture](./architecture.md) for the durable processing and security
   principles.
2. Check [capability status](./capability-status.md) before treating any setup path as
   supported.
3. Read [operations status](./operations.md) before planning a self-hosted deployment.

## Documentation principles

- Browser clients never receive operational secrets, provider tokens, or database
  credentials.
- Case data, evidence, configuration versions, and durable work must retain explicit
  ownership and audit boundaries.
- Public instructions state prerequisites, expected safe outcomes, and the point at
  which a capability is not yet supported.
