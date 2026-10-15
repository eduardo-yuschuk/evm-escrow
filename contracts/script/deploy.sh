#!/bin/sh
# Deployer service of docker compose: deploys with script/Deploy.s.sol, unless deployments/<chainId>.json
# already describes the chain behind RPC_URL. `docker compose up` runs the service on every start, and
# a second deployment on a running chain would leave the API indexing the first contract. A restarted
# Anvil is a new chain, so it gets a new deployment.
#
# With ETHERSCAN_API_KEY set (Sepolia, docker-compose.sepolia.yml), forge also verifies the contracts.
set -eu

: "${RPC_URL:?}" "${PRIVATE_KEY:?}"

chain_id=$(cast chain-id --rpc-url "$RPC_URL")
file=deployments/$chain_id.json

# A top-level field of the deployments file. Its values are numbers, addresses and hashes.
field() {
  sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",]*\).*/\1/p" "$file"
}

if [ -f "$file" ]; then
  # The API's chain guard checks the same: the hash of the start block and code at the contract.
  hash=$(cast block "$(field startBlock)" --field hash --rpc-url "$RPC_URL" 2>/dev/null || true)
  if [ "$hash" = "$(field startBlockHash)" ]; then
    code=$(cast code "$(field escrow)" --rpc-url "$RPC_URL")
    if [ "$code" != 0x ]; then
      echo "$file already describes this chain: nothing to deploy"
      exit 0
    fi
  fi
fi

# forge reads the key itself from ETHERSCAN_API_KEY.
exec forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast --private-key "$PRIVATE_KEY" \
  ${ETHERSCAN_API_KEY:+--verify}
