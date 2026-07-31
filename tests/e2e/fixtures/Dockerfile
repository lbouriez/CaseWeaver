# A purpose-built deterministic fixture image. It is used only by
# compose.e2e.yml, never by a CaseWeaver runtime image or production topology.
FROM node:22.13.1-bookworm-slim@sha256:83fdfa2a4de32d7f8d79829ea259bd6a4821f8b2d123204ac467fbe3966450fc

RUN apt-get update \
    && apt-get install --yes --no-install-recommends git openssl \
    && rm -rf /var/lib/apt/lists/*
