# syntax=docker/dockerfile:1.7

# Node is pinned by digest so local and release builds use the same toolchain.
# pnpm 11.12's upstream Node floor is 22.13, so use the first compatible Node 22
# patch release rather than silently changing the repository package manager.
ARG NODE_IMAGE=node:22.13.1-bookworm-slim@sha256:83fdfa2a4de32d7f8d79829ea259bd6a4821f8b2d123204ac467fbe3966450fc

FROM ${NODE_IMAGE} AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace

# Node 22.13's bundled Corepack trust store predates pnpm 11's signing key. A fixed
# newer Corepack release validates and activates the repository-pinned pnpm version;
# signature verification is never bypassed.
RUN npm install --global corepack@0.31.0 \
    && corepack enable \
    && corepack prepare pnpm@11.12.0 --activate

# Prisma detects the available OpenSSL ABI while generating its client. This build-only
# package is not copied into the final API/Admin images.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Dockerfile.dockerignore deliberately keeps source, Prisma migrations, and browser
# assets while excluding installed dependencies and every local/generated artifact.
COPY . .
RUN pnpm install --frozen-lockfile

# Prisma's CLI is a build-time dependency for the API package, so it is kept in a
# separate versioned migration image rather than expanding the API runtime image.
# It contains only the migration CLI/dependencies and checked-in schema history.
FROM ${NODE_IMAGE} AS migration

ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE=https://github.com/caseweaver/caseweaver
ARG CREATED=unknown
LABEL org.opencontainers.image.title="CaseWeaver migration runner" \
      org.opencontainers.image.description="CaseWeaver Prisma migration runner" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

ENV NODE_ENV=production
WORKDIR /opt/caseweaver

# Prisma's migration engine detects its OpenSSL ABI at runtime. Keep this dependency
# in the operational migration image, not the API/Admin runtime images.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Prisma is a package-local build dependency of the PostgreSQL adapter. Preserve its
# normal pnpm-relative executable path alongside the root virtual store; copying only
# the root .bin directory would omit this package-local CLI.
COPY --from=dependencies --chown=node:node /workspace/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /workspace/infrastructure/postgres/node_modules ./infrastructure/postgres/node_modules
COPY --from=dependencies --chown=node:node /workspace/infrastructure/postgres/prisma ./infrastructure/postgres/prisma
COPY --from=dependencies --chown=node:node /workspace/infrastructure/postgres/prisma.config.ts ./infrastructure/postgres/prisma.config.ts
COPY --chown=node:node deploy/docker/container-entrypoint.sh /usr/local/bin/caseweaver-entrypoint

USER node
ENTRYPOINT ["/usr/local/bin/caseweaver-entrypoint"]
CMD ["./infrastructure/postgres/node_modules/.bin/prisma", "migrate", "deploy", "--config", "/opt/caseweaver/infrastructure/postgres/prisma.config.ts"]

FROM dependencies AS api-build

# The API filter includes its workspace dependencies in dependency order.
RUN pnpm --filter @caseweaver/api... run build \
    && pnpm --filter @caseweaver/api deploy --legacy --prod /opt/caseweaver/api \
    && generated_client="$(find /workspace/node_modules -type d -path '*/node_modules/.prisma/client' -print -quit)" \
    && deployed_client="$(find /opt/caseweaver/api/node_modules -type d -path '*/node_modules/@prisma/client' -print -quit)" \
    && test -n "$generated_client" \
    && test -n "$deployed_client" \
    && mkdir -p "$deployed_client/node_modules/.prisma" \
    && cp -a "$generated_client" "$deployed_client/node_modules/.prisma/client"

# A deployed workspace package includes its authoring files by default. Runtime Node
# only needs compiled JavaScript and production dependencies; remove CaseWeaver
# authoring/test artifacts before they can cross the final-stage boundary.
RUN set -eux; \
    rm -rf /opt/caseweaver/api/src; \
    find /opt/caseweaver/api/node_modules/@caseweaver -type d \( -name src -o -name test -o -name tests -o -name coverage -o -name .git \) -prune -exec rm -rf {} +; \
    find /opt/caseweaver/api/node_modules/.pnpm -type d -path '*/node_modules/@caseweaver/*/src' -prune -exec rm -rf {} +; \
    find /opt/caseweaver/api -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.map' -o -name '.env' -o -name '.env.*' \) -delete

FROM ${NODE_IMAGE} AS api

ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE=https://github.com/caseweaver/caseweaver
ARG CREATED=unknown
LABEL org.opencontainers.image.title="CaseWeaver API" \
      org.opencontainers.image.description="CaseWeaver authenticated control-plane API" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

ENV NODE_ENV=production
WORKDIR /opt/caseweaver/api

EXPOSE 3000

COPY --from=api-build --chown=node:node /opt/caseweaver/api ./
COPY --chown=node:node deploy/docker/container-entrypoint.sh /usr/local/bin/caseweaver-entrypoint

USER node
ENTRYPOINT ["/usr/local/bin/caseweaver-entrypoint"]
CMD ["node", "dist/main.js"]

# The durable worker is a separate executable image, not a hidden API process.
# It includes the configured Git transport required by the real connector runtime;
# checkout credentials remain runtime-only environment/vault references.
FROM dependencies AS worker-build

RUN pnpm --filter @caseweaver/worker... run build \
    && pnpm --filter @caseweaver/worker deploy --legacy --prod /opt/caseweaver/worker \
    && generated_client="$(find /workspace/node_modules -type d -path '*/node_modules/.prisma/client' -print -quit)" \
    && deployed_client="$(find /opt/caseweaver/worker/node_modules -type d -path '*/node_modules/@prisma/client' -print -quit)" \
    && test -n "$generated_client" \
    && test -n "$deployed_client" \
    && mkdir -p "$deployed_client/node_modules/.prisma" \
    && cp -a "$generated_client" "$deployed_client/node_modules/.prisma/client"

RUN set -eux; \
    rm -rf /opt/caseweaver/worker/src; \
    find /opt/caseweaver/worker/node_modules/@caseweaver -type d \( -name src -o -name test -o -name tests -o -name coverage -o -name .git \) -prune -exec rm -rf {} +; \
    find /opt/caseweaver/worker/node_modules/.pnpm -type d -path '*/node_modules/@caseweaver/*/src' -prune -exec rm -rf {} +; \
    find /opt/caseweaver/worker -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.map' -o -name '.env' -o -name '.env.*' \) -delete

FROM ${NODE_IMAGE} AS worker

ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE=https://github.com/caseweaver/caseweaver
ARG CREATED=unknown
LABEL org.opencontainers.image.title="CaseWeaver worker" \
      org.opencontainers.image.description="CaseWeaver durable queue worker" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

ENV NODE_ENV=production
WORKDIR /opt/caseweaver/worker

RUN apt-get update \
    && apt-get install --yes --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=worker-build --chown=node:node /opt/caseweaver/worker ./
COPY --chown=node:node deploy/docker/container-entrypoint.sh /usr/local/bin/caseweaver-entrypoint

USER node
ENTRYPOINT ["/usr/local/bin/caseweaver-entrypoint"]
CMD ["node", "dist/main.js", "start"]

FROM dependencies AS scheduler-build

RUN pnpm --filter @caseweaver/scheduler... run build \
    && pnpm --filter @caseweaver/scheduler deploy --legacy --prod /opt/caseweaver/scheduler \
    && generated_client="$(find /workspace/node_modules -type d -path '*/node_modules/.prisma/client' -print -quit)" \
    && deployed_client="$(find /opt/caseweaver/scheduler/node_modules -type d -path '*/node_modules/@prisma/client' -print -quit)" \
    && test -n "$generated_client" \
    && test -n "$deployed_client" \
    && mkdir -p "$deployed_client/node_modules/.prisma" \
    && cp -a "$generated_client" "$deployed_client/node_modules/.prisma/client"

RUN set -eux; \
    rm -rf /opt/caseweaver/scheduler/src; \
    find /opt/caseweaver/scheduler/node_modules/@caseweaver -type d \( -name src -o -name test -o -name tests -o -name coverage -o -name .git \) -prune -exec rm -rf {} +; \
    find /opt/caseweaver/scheduler/node_modules/.pnpm -type d -path '*/node_modules/@caseweaver/*/src' -prune -exec rm -rf {} +; \
    find /opt/caseweaver/scheduler -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.map' -o -name '.env' -o -name '.env.*' \) -delete

FROM ${NODE_IMAGE} AS scheduler

ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE=https://github.com/caseweaver/caseweaver
ARG CREATED=unknown
LABEL org.opencontainers.image.title="CaseWeaver scheduler" \
      org.opencontainers.image.description="CaseWeaver durable schedule producer" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

ENV NODE_ENV=production
WORKDIR /opt/caseweaver/scheduler

COPY --from=scheduler-build --chown=node:node /opt/caseweaver/scheduler ./
COPY --chown=node:node deploy/docker/container-entrypoint.sh /usr/local/bin/caseweaver-entrypoint

USER node
ENTRYPOINT ["/usr/local/bin/caseweaver-entrypoint"]
CMD ["node", "dist/main.js", "start"]

FROM dependencies AS webhook-build

RUN pnpm --filter @caseweaver/webhook... run build \
    && pnpm --filter @caseweaver/webhook deploy --legacy --prod /opt/caseweaver/webhook \
    && generated_client="$(find /workspace/node_modules -type d -path '*/node_modules/.prisma/client' -print -quit)" \
    && deployed_client="$(find /opt/caseweaver/webhook/node_modules -type d -path '*/node_modules/@prisma/client' -print -quit)" \
    && test -n "$generated_client" \
    && test -n "$deployed_client" \
    && mkdir -p "$deployed_client/node_modules/.prisma" \
    && cp -a "$generated_client" "$deployed_client/node_modules/.prisma/client"

RUN set -eux; \
    rm -rf /opt/caseweaver/webhook/src; \
    find /opt/caseweaver/webhook/node_modules/@caseweaver -type d \( -name src -o -name test -o -name tests -o -name coverage -o -name .git \) -prune -exec rm -rf {} +; \
    find /opt/caseweaver/webhook/node_modules/.pnpm -type d -path '*/node_modules/@caseweaver/*/src' -prune -exec rm -rf {} +; \
    find /opt/caseweaver/webhook -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.map' -o -name '.env' -o -name '.env.*' \) -delete

FROM ${NODE_IMAGE} AS webhook

ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE=https://github.com/caseweaver/caseweaver
ARG CREATED=unknown
LABEL org.opencontainers.image.title="CaseWeaver webhook" \
      org.opencontainers.image.description="CaseWeaver verified webhook ingress" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

ENV NODE_ENV=production
WORKDIR /opt/caseweaver/webhook

EXPOSE 8081

COPY --from=webhook-build --chown=node:node /opt/caseweaver/webhook ./
COPY --chown=node:node deploy/docker/container-entrypoint.sh /usr/local/bin/caseweaver-entrypoint

USER node
ENTRYPOINT ["/usr/local/bin/caseweaver-entrypoint"]
CMD ["node", "dist/main.js", "start"]

FROM dependencies AS standalone-build

RUN pnpm --filter @caseweaver/standalone... run build \
    && pnpm --filter @caseweaver/standalone deploy --legacy --prod /opt/caseweaver/standalone \
    && generated_client="$(find /workspace/node_modules -type d -path '*/node_modules/.prisma/client' -print -quit)" \
    && deployed_client="$(find /opt/caseweaver/standalone/node_modules -type d -path '*/node_modules/@prisma/client' -print -quit)" \
    && test -n "$generated_client" \
    && test -n "$deployed_client" \
    && mkdir -p "$deployed_client/node_modules/.prisma" \
    && cp -a "$generated_client" "$deployed_client/node_modules/.prisma/client"

RUN set -eux; \
    rm -rf /opt/caseweaver/standalone/src; \
    find /opt/caseweaver/standalone/node_modules/@caseweaver -type d \( -name src -o -name test -o -name tests -o -name coverage -o -name .git \) -prune -exec rm -rf {} +; \
    find /opt/caseweaver/standalone/node_modules/.pnpm -type d -path '*/node_modules/@caseweaver/*/src' -prune -exec rm -rf {} +; \
    find /opt/caseweaver/standalone -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.map' -o -name '.env' -o -name '.env.*' \) -delete

FROM ${NODE_IMAGE} AS standalone

ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE=https://github.com/caseweaver/caseweaver
ARG CREATED=unknown
LABEL org.opencontainers.image.title="CaseWeaver standalone" \
      org.opencontainers.image.description="CaseWeaver single-process durable host" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

ENV NODE_ENV=production
WORKDIR /opt/caseweaver/standalone

EXPOSE 3000

RUN apt-get update \
    && apt-get install --yes --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=standalone-build --chown=node:node /opt/caseweaver/standalone ./
COPY --chown=node:node deploy/docker/container-entrypoint.sh /usr/local/bin/caseweaver-entrypoint

USER node
ENTRYPOINT ["/usr/local/bin/caseweaver-entrypoint"]
CMD ["node", "dist/main.js", "start"]

FROM dependencies AS admin-build

RUN pnpm --filter @caseweaver/admin run build

FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0 AS admin

ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE=https://github.com/caseweaver/caseweaver
ARG CREATED=unknown
LABEL org.opencontainers.image.title="CaseWeaver Admin" \
      org.opencontainers.image.description="CaseWeaver static operator console" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

# This image holds the built static artifact and public runtime-config generator
# only. It deliberately has no Node runtime, database client, OIDC client secret,
# connector credential, or source tree.
EXPOSE 8080
COPY --chown=101:101 deploy/docker/admin-nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=101:101 deploy/docker/admin-runtime-config.sh /usr/local/bin/admin-runtime-config
COPY --from=admin-build --chown=101:101 /workspace/apps/admin/dist /usr/share/nginx/static

USER 101:101
ENTRYPOINT ["/usr/local/bin/admin-runtime-config"]
CMD ["nginx", "-g", "daemon off;"]
