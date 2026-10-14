# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.21.0-bookworm-slim
ARG FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry:v1.8.3

FROM ${FOUNDRY_IMAGE} AS foundry

# dev: Node + dependencies + anvil (for integration tests and the demo).
# Used by the npm service with ./api mounted.
FROM ${NODE_IMAGE} AS dev
ENV HOME=/home/node \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false
WORKDIR /app
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
COPY docker-entrypoint.sh /usr/local/bin/api-entrypoint
# The entrypoint may drop to any uid (the owner of the mounted code), so HOME must be usable by it.
RUN chmod a+rwx /home/node && chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
    && sha256sum package-lock.json >node_modules/.package-lock.json.sha256 \
    && rm -rf /tmp/.npm
COPY --chown=node:node . .
ENTRYPOINT ["api-entrypoint"]
CMD ["npm", "test"]

FROM dev AS build
RUN npm run build && npm prune --omit=dev

# runtime: production dependencies and compiled code only.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/migrations ./migrations
USER node
CMD ["node", "dist/index.js"]
