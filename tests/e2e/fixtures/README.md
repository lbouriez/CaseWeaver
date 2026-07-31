# E2E fixtures

This folder contains only deterministic inputs for the Docker/Chromium acceptance
journey. It is not imported by application packages or copied into deployable images.

`Dockerfile` provides Git and OpenSSL for short-lived fixture services. Compose creates a
private CA and server certificate in a disposable Docker volume at test time, rather
than committing a key or certificate. `openai-compatible-provider.mjs` exposes one
bounded HTTPS embedding endpoint and verifies a deterministic test credential without
logging it. `knowledge/` is copied into a disposable volume and committed as a local Git
repository before API and worker start. The fixture then hands the volume to the
backend's unprivileged `node` account, preserving Git safe-directory protection.
Its isolated reseeding job has only the capabilities needed to clear and re-own
that disposable node-owned Docker volume on a later Compose reconciliation; it
has neither network access nor a host mount.

Do not add real credentials, real support content, a provider SDK, or behavior that
duplicates a CaseWeaver adapter here. A fixture change must retain bounded responses and
be exercised by the corresponding browser test.
