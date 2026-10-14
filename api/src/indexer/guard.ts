import { BlockNotFoundError, type Hash } from "viem";

import type { ChainClient } from "../chain.js";
import { withTransaction, type Pool } from "../db/pool.js";
import type { Deployment } from "../deployment.js";
import { FatalError } from "../errors.js";
import type { Logger } from "../logger.js";
import {
  clearProjection,
  lockIndexerState,
  writeIndexerState,
  type IndexerState,
} from "./store.js";

export class ChainMismatchError extends FatalError {
  override name = "ChainMismatchError";
}

/**
 * Checks that the deployments file describes the chain behind the RPC: same chain id, same hash at
 * the start block and code at the contract address. Fails, for instance, when Anvil was restarted
 * and the contract was not deployed again.
 */
export async function verifyDeployment(client: ChainClient, deployment: Deployment): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== deployment.chainId) {
    throw new ChainMismatchError(
      `The RPC serves chain ${String(chainId)} but the deployments file is for chain ${String(deployment.chainId)}`,
    );
  }

  let hash: Hash | undefined;
  try {
    hash = (await client.getBlock({ blockNumber: deployment.startBlock })).hash;
  } catch (error) {
    if (!(error instanceof BlockNotFoundError)) throw error;
  }
  if (hash?.toLowerCase() !== deployment.startBlockHash) {
    throw new ChainMismatchError(
      `Block ${String(deployment.startBlock)} is ${hash ?? "missing"} on the chain but ` +
        `${deployment.startBlockHash} in the deployments file: the node was restarted or replaced ` +
        "since the deployment. Deploy the contract again.",
    );
  }

  const code = await client.getCode({ address: deployment.escrow });
  if (code === undefined || code === "0x") {
    throw new ChainMismatchError(`There is no contract at ${deployment.escrow}`);
  }
}

/** What identifies the indexed chain and contract, for the logs. */
const chainOf = ({ chainId, contractAddress, startBlock, startBlockHash }: IndexerState) => ({
  chainId,
  contractAddress,
  startBlock: String(startBlock),
  startBlockHash,
});

/**
 * Makes sure the database holds the projection of the deployed contract on this chain, and
 * initializes it on first run. A database built from another chain or contract (e.g. Anvil was
 * restarted but Postgres was not) is wiped when `resetOnMismatch` is set, and is a fatal error
 * otherwise. Assumes `verifyDeployment` passed, so matching the deployment means matching the chain.
 */
export async function ensureIndexerState(
  pool: Pool,
  deployment: Deployment,
  resetOnMismatch: boolean,
  log: Logger,
): Promise<void> {
  const expected: IndexerState = {
    chainId: deployment.chainId,
    contractAddress: deployment.escrow,
    startBlock: deployment.startBlock,
    startBlockHash: deployment.startBlockHash,
    lastIndexedBlock: deployment.startBlock,
  };

  await withTransaction(pool, async (db) => {
    const stored = await lockIndexerState(db);
    if (!stored) {
      await writeIndexerState(db, expected);
      log.info({ startBlock: deployment.startBlock }, "new database: indexing from the deployment");
      return;
    }

    const sameChain =
      stored.chainId === expected.chainId &&
      stored.contractAddress === expected.contractAddress &&
      stored.startBlock === expected.startBlock &&
      stored.startBlockHash === expected.startBlockHash;
    if (sameChain) {
      log.info({ lastIndexedBlock: stored.lastIndexedBlock }, "resuming from the checkpoint");
      return;
    }

    const details = { stored: chainOf(stored), deployment: chainOf(expected) };
    if (!resetOnMismatch) {
      log.error(details, "the database belongs to another chain or contract");
      throw new ChainMismatchError(
        "The database was built from another chain or contract. Set RESET_ON_CHAIN_MISMATCH=true " +
          "to wipe it and reindex, or use another database.",
      );
    }
    await clearProjection(db);
    await writeIndexerState(db, expected);
    log.warn(details, "the database belonged to another chain or contract: wiped, reindexing");
  });
}
