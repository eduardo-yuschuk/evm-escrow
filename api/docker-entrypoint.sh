#!/bin/sh
# Entrypoint for the API images (npm and demo services).
set -eu

# With ./api mounted from the host, run as the owner of those files so that node_modules/, dist/
# and anything the scripts generate belong to the host user under classic, rootless or Desktop Docker.
if [ "$(id -u)" = 0 ]; then
  owner=$(stat -c %u:%g /app)
  if [ "$owner" != "0:0" ]; then
    exec setpriv --reuid="${owner%:*}" --regid="${owner#*:}" --clear-groups "$0" "$@"
  fi
fi

# Install dependencies when they are missing or the lockfile changed.
stamp=node_modules/.package-lock.json.sha256
if ! sha256sum --check --status "$stamp" 2>/dev/null; then
  npm ci --no-audit --no-fund
  sha256sum package-lock.json >"$stamp"
fi

exec "$@"
