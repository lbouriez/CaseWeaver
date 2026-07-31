---
title: Deterministic support runbook
---

# Service start failures

When a service fails to start, first confirm that its configuration has been
validated and that the dependency health check has completed. Do not retry an
unknown configuration change repeatedly: inspect its typed error and apply one
reviewed correction.

## Evidence to collect

- The bounded service error code and timestamp.
- The dependency readiness result.
- The immutable configuration revision used for the failed run.
