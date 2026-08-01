---
sidebar_position: 7
title: Collections, sources, schedules, and analysis
---

# Knowledge and analysis configuration

**Availability:** collection, source, schedule, retrieval/prompt policy, and
repository-analysis authoring appear only when the API advertises each managed surface.

## Build knowledge deliberately

1. In **Knowledge & Analysis**, create a workspace-scoped collection with an active
   embedding binding, compatibility profile, and vector dimension. The collection pins
   that binding version; an AI-model change does not silently change existing vectors.
2. In **Integrations**, create a connector, then a source that selects the collection
   and its immutable source/filter configuration.
3. Create a schedule if you want durable automatic synchronization, or use the guarded
   **Synchronize** action for a bounded manual run. A schedule pins a source version and
   cannot follow later source edits invisibly.
4. Use retrieval and prompt profiles where their server surface is managed. These are
   secret-free, versioned policy documents, not a place to select a connector or key.

Images and eligible attachments follow the same bounded preparation path for knowledge
and case analysis: an occurrence is identified, cached derivative evidence is reused
when possible, and a vision binding is selected through immutable policy. Downloads,
archives, and model calls stay server-side; the browser receives safe status/evidence
metadata only.

## Repository-assisted case analysis

This workflow is split by purpose in the console:

- **Repository analysis**: code repository and execution-policy drafts/tests.
- **Knowledge & Analysis**: attachment policy and analysis recipe.
- **Integrations**: pinned case-analysis trigger and intake schedule.

An analysis recipe chooses the immutable analysis/retrieval/prompt/publication versions
and optional repository/attachment stages. It is not the analysis profile itself. A
case intake pins the recipe so a retry keeps its selected repository commit, attachment
evidence, prompt/context, and model-binding versions. Sensitive prompt/context/result
reads are authorized, workspace-scoped, and audited before protected content is opened.

If a particular form is absent, the deployment has not composed that managed workflow;
there is no generic JSON fallback or direct provider/repository call in Admin.
