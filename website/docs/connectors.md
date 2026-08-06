---
sidebar_position: 4
title: Connector capability matrix
---

# Connector capability matrix

**Availability:** the registry is dynamic. A connector appears only when the backend
registers its descriptor, and its form exposes only server-supplied fields and safe
examples.

| Connector | Knowledge source | Case source | Attachment source | Analysis destination | Secret reference | Guide |
| --- | --- | --- | --- | --- | --- | --- |
| Git / Markdown | Yes | No | Yes | No | Optional Git token for a remote private repository | [Guide](./git-markdown.md) |
| Jitbit | Yes | Yes | Yes | Yes, approved internal note only | Required API-token registration | [Guide](./jitbit.md) |

## The configuration chain

1. Register a secret reference, if the descriptor requires one.
2. Create a connector draft from its descriptor and run its bounded, non-destructive
   test. The preview/result does not return a remote response, URL, secret, or exception.
3. Review and activate the immutable connector version.
4. Create a **collection**, then a **knowledge source** and its optional **schedule**.
   Source filters are source-version policy, not global connector settings.
5. For case analysis, separately create the case intake, analysis recipe/profile, and
   publication profile/destination where the API advertises those managed workflows.

A successful connection test does not synchronize content, create an analysis policy,
or grant permission to publish. Conversely, a source cannot make a destination usable.
The server reloads records for each lifecycle action with optimistic concurrency and
retains history; edit through a successor configuration rather than altering a past run.

If a surface says unavailable or read-only, do not craft an API call from the browser.
Use a deployment with the required registered composition and a role that has the
required permission.
