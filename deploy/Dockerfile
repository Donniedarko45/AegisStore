# syntax=docker/dockerfile:1.7
#
# Behind a TLS-intercepting corporate proxy? Provide its CA as an (optional) build secret:
#   docker build --secret id=extra_ca,src=/path/to/ca-bundle.crt --target api -f deploy/Dockerfile .
# Without the secret nothing changes.
#
# One Dockerfile, one target per service:
#   api | worker | storage-node | web
# Build context is the repository root (see docker-compose.yml).

# ------------------------------------------------------------------ base: pnpm + manifests
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm CI=true NODE_ENV=production
ENV PATH=$PNPM_HOME:$PATH
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm install -g pnpm@10.28.0 --no-fund --no-audit
WORKDIR /app

# Copy only manifests first so the dependency layer is cached until a package.json changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/hashring/package.json packages/hashring/
COPY packages/nodeclient/package.json packages/nodeclient/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/storage-node/package.json apps/storage-node/
COPY apps/web/package.json apps/web/

# ------------------------------------------------------------------ backend services
# `--filter <app>...` installs only that app and the workspace packages it depends on.
FROM base AS api-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --filter @aegis/api...

FROM api-deps AS api
COPY packages packages
COPY apps/api apps/api
WORKDIR /app/apps/api
USER node
EXPOSE 3000
CMD ["./node_modules/.bin/tsx", "src/main.ts"]

FROM base AS worker-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --filter @aegis/worker...

FROM worker-deps AS worker
COPY packages packages
COPY apps/worker apps/worker
WORKDIR /app/apps/worker
USER node
CMD ["./node_modules/.bin/tsx", "src/main.ts"]

FROM base AS node-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --filter @aegis/storage-node...

FROM node-deps AS storage-node
COPY packages packages
COPY apps/storage-node apps/storage-node
WORKDIR /app/apps/storage-node
# Runs as root so it can write the bind-mounted ./runtime/storage-node-N directory on any host.
EXPOSE 4000
CMD ["./node_modules/.bin/tsx", "src/main.ts"]

# ------------------------------------------------------------------ web (build, then nginx)
FROM base AS web-build
ENV NODE_ENV=development
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --filter @aegis/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @aegis/web build

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
