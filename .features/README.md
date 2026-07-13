# CaseWeaver feature specifications

This directory defines the behavior and architectural boundaries that implementations
must preserve. It is written for both maintainers and coding agents.

## Reading order

Read files `01` through `12` before making cross-cutting changes. For a focused change,
read the target file plus all documents it links to.

## Normative language

- **Must** is required for correctness, portability, security, or compatibility.
- **Should** is the expected default and requires a documented reason to diverge.
- **May** is optional.

## Change rules

1. Do not couple the core to Jitbit, Odoo, Copilot SDK, OpenAI, Azure, or another vendor.
2. Do not add a new model call without usage capture, pricing behavior, and a budget
   decision.
3. Do not expose untrusted case data to repository tools without the sandbox controls
   defined in `07-attachments-and-security.md`.
4. Do not add connector-specific fields to core domain records. Store them as typed
   external references or connector metadata.
5. Update the relevant specification and acceptance tests when behavior changes.
6. Prefer explicit failures over silent fallback. Unknown price is not zero cost.

The temporary PBI files describe delivery slices. These feature files remain
authoritative after the PBIs are moved to an issue tracker.
