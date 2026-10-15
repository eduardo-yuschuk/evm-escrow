#!/bin/sh
# Deployer service of docker compose: deploys with script/Deploy.s.sol, unless deployments/<chainId>.json
# already describes the chain behind RPC_URL. `docker compose up` runs the service on every start, and
# a second deployment on a running chain would leave the API indexing the first contract. A restarted
# Anvil is a new chain, so it gets a new deployment.
#
# forge also verifies the contracts: on a Sourcify instance with SOURCIFY_URL set (Monad testnet,
# docker-compose.monad.yml), or on Etherscan with ETHERSCAN_API_KEY set (docker-compose.sepolia.yml).
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

if [ -n "${SOURCIFY_URL:-}" ]; then
  set -- --verify --verifier sourcify --verifier-url "$SOURCIFY_URL"
elif [ -n "${ETHERSCAN_API_KEY:-}" ]; then
  # forge reads the key itself from ETHERSCAN_API_KEY.
  set -- --verify
fi

# --skip-simulation makes forge take each gas limit from the node (eth_estimateGas) instead of from its
# own simulation, which charges the gas costs of the compile target (cancun). Sepolia already charges
# far more to create contracts: 6.5M gas for the Escrow instead of 934k, so the simulated limits run
# out of gas.
exec forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast --skip-simulation \
  --private-key "$PRIVATE_KEY" "$@"
