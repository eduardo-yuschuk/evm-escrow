# syntax=docker/dockerfile:1
ARG FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry:v1.8.3

# deps: Foundry + solc 0.8.37 + Soldeer dependencies. Used by the forge service with ./contracts mounted.
FROM ${FOUNDRY_IMAGE} AS deps
USER root
ENV HOME=/home/foundry
WORKDIR /app

# Download solc into the image so compiling does not need the network.
RUN mkdir -p /tmp/solc/src \
    && printf 'pragma solidity 0.8.37;\ncontract Solc {}\n' >/tmp/solc/src/Solc.sol \
    && forge build --root /tmp/solc --use 0.8.37 \
    && rm -rf /tmp/solc

COPY foundry.toml soldeer.lock remappings.txt ./
RUN forge soldeer install && sha256sum soldeer.lock >dependencies/.soldeer.lock.sha256

COPY docker-entrypoint.sh /usr/local/bin/forge-entrypoint
# The entrypoint may drop to any uid (the owner of the mounted code), so HOME must be usable by it.
RUN chmod -R a+rwX /home/foundry && chown -R foundry:foundry /app
ENTRYPOINT ["forge-entrypoint"]
CMD ["forge", "build"]

# build: compiled contracts, no mounted code. Used by the deployer.
FROM deps AS build
COPY --chown=foundry:foundry . .
USER foundry
RUN forge build
