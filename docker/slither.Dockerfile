# syntax=docker/dockerfile:1
# Slither image. Build context: the repository root (see slither.Dockerfile.dockerignore).
ARG FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry:v1.8.3
ARG PYTHON_IMAGE=python:3.12.14-slim-bookworm

FROM ${FOUNDRY_IMAGE} AS foundry

FROM ${PYTHON_IMAGE}
ENV HOME=/home/slither \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore
WORKDIR /app

# crytic-compile compiles the project by invoking `forge build`. The Foundry image is Ubuntu 22.04
# (glibc 2.35) and this one is Debian 12 (glibc 2.36), so the binary runs as is.
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge

COPY docker/slither.requirements.txt /tmp/requirements.txt
RUN pip install --require-hashes --no-deps -r /tmp/requirements.txt && rm /tmp/requirements.txt

# Download solc into the image so compiling does not need the network.
RUN mkdir -p /tmp/solc/src \
    && printf 'pragma solidity 0.8.37;\ncontract Solc {}\n' >/tmp/solc/src/Solc.sol \
    && forge build --root /tmp/solc --use 0.8.37 \
    && rm -rf /tmp/solc

# Same entrypoint as the forge service: drops to the owner of ./contracts and installs the Soldeer
# dependencies when they are missing. HOME must be usable by any uid.
COPY contracts/docker-entrypoint.sh /usr/local/bin/forge-entrypoint
RUN chmod -R a+rwX "$HOME"
ENTRYPOINT ["forge-entrypoint"]
CMD ["slither", ".", "--config-file", "slither.config.json"]
