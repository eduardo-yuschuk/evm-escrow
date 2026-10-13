#!/bin/sh
# Entrypoint for the contracts images (forge and deployer services).
set -eu

# With ./contracts mounted from the host, run as the owner of those files so that out/, cache/,
# dependencies/ and .gas-snapshot belong to the host user under classic, rootless or Desktop Docker.
if [ "$(id -u)" = 0 ]; then
  owner=$(stat -c %u:%g /app)
  if [ "$owner" != "0:0" ]; then
    exec setpriv --reuid="${owner%:*}" --regid="${owner#*:}" --clear-groups "$0" "$@"
  fi
fi

# Install Soldeer dependencies when they are missing or the lockfile changed.
stamp=dependencies/.soldeer.lock.sha256
if ! sha256sum --check --status "$stamp" 2>/dev/null; then
  forge soldeer install
  sha256sum soldeer.lock >"$stamp"
fi

exec "$@"
