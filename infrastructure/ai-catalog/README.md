# Trusted AI catalog source

This infrastructure adapter obtains a LiteLLM model catalog from a fixed,
deployment-owned GitHub source. It first resolves an immutable commit, then downloads
the catalog at that exact revision over HTTPS, enforces a byte limit and timeout, and
returns only verified bytes to `@caseweaver/administration`'s trusted catalog-refresh
port. It never provides a browser-controlled URL, raw catalog response, or credential
path.

`apps/api` owns selection and composition. This package owns no HTTP routes, database
transactions, audit records, model-policy decisions, secret resolution, or AI calls.
