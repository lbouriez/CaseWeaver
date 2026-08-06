---
sidebar_position: 6
title: Jitbit source to publication
---

# Jitbit source to internal publication

**Availability:** Jitbit provides knowledge source, case source, attachment source, and
analysis destination capabilities. They are independently configured; one connector
instance does not enable the others.

```text
Jitbit connector
  ├─ resolved-case knowledge source → collection → schedule
  ├─ case source + attachments → analysis recipe / intake trigger
  └─ analysis destination ← publication profile ← approved result
```

## Configure and test the connector

1. In **Access & security**, register the external Jitbit API-token locator. Do not
   enter the token itself.
2. In **Integrations**, create a Jitbit draft. Use the HTTPS installation base address,
   not a ticket page and never a credential-bearing URL. Select the redacted token
   registration, request timeout, discovery page size, and ticket-character bound.
3. Optionally set `initialUpdatedFrom` for the first import. Set
   `updatedFromOverlapDays` (one day is the conservative default) to protect Jitbit's
   date-granular updates.
4. Run the bounded connection test, review its safe terminal status, and activate the
   immutable connector version.

The resolved-case knowledge source defaults to a terminal-only filter. It accepts the
adapter's recognized closed/resolved statuses; this is a source-version policy, not a
connector-wide switch. After a completed synchronization the durable cursor takes over;
the initial date is no longer the incremental boundary.

Create a collection, the resolved-case knowledge source, and its schedule. Start with a
bounded date/window, synchronize, and verify provenance before widening a successor
configuration. If old cases are absent, review the first-import boundary and source
filter; do not delete cursor/audit history to force a retry.

## Case analysis and publication

Where the server advertises the managed repository-analysis workflows, create the
separate Jitbit case source, attachment policy, analysis recipe/profile, and intake
trigger or schedule. Create a publication profile that selects the Jitbit analysis
destination and apply the deployment's approval policy.

CaseWeaver publishes only an **approved internal** Jitbit comment with a stable marker.
It does not create a customer-visible reply, choose approval on an operator's behalf, or
re-run analysis. A timeout after a possible write is `outcome_unknown`: reconcile the
target case/marker before another publication attempt.

## Safe recovery

Correct a non-HTTPS or credential-bearing base URL, missing token registration, or
failed bounded test before activation. Preserve immutable configuration and audit
history. Do not paste a token in the URL, logs, console, or a retry command. A request
for customer-visible publication is unsupported; use a connector/destination that
explicitly supports that policy rather than bypassing the internal-note safeguard.
