# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.21.0-bookworm-slim
ARG FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry:v1.8.3

FROM ${FOUNDRY_IMAGE} AS foundry

# deps: Node + dependencies. Base of the dev and build stages.
FROM ${NODE_IMAGE} AS deps
ENV HOME=/home/node \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false
WORKDIR /app
# The dev entrypoint may drop to any uid (the owner of the mounted code), so HOME must be usable by it.
RUN chmod a+rwx /home/node && chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
    && sha256sum package-lock.json >node_modules/.package-lock.json.sha256 \
    && rm -rf /tmp/.npm

# dev: dependencies + anvil (for integration tests and the demo).
# Used by the npm service with ./api mounted.
FROM deps AS dev
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
COPY docker-entrypoint.sh /usr/local/bin/api-entrypoint
COPY --chown=node:node . .
ENTRYPOINT ["api-entrypoint"]
CMD ["npm", "test"]

# build: only what the compiler needs, so that changing the tests or the scripts does not rebuild
# the runtime image.
FROM deps AS build
COPY --chown=node:node tsconfig.json tsconfig.build.json ./
COPY --chown=node:node src ./src
RUN npm run build && npm prune --omit=dev

# runtime: production dependencies and compiled code only. Used by the api service.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
USER node
CMD ["node", "dist/index.js"]
