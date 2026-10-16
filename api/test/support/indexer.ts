// Running the indexer step by step, and checking its projection against the chain.
import type { Hash } from "viem";
import { expect } from "vitest";

import { createChainClient } from "../../src/chain.js";
import type { Pool } from "../../src/db/pool.js";
import type { Deployment } from "../../src/deployment.js";
import { escrowAbi } from "../../src/generated/contracts.js";
import { indexNextBatch, type IndexerContext } from "../../src/indexer/indexer.js";
import { ONCHAIN_STATUS, type TestClient } from "./chain.js";
import { silentLog } from "./db.js";

export function indexerContext(
  pool: Pool,
  rpcUrl: string,
  deployment: Deployment,
  confirmations = 0,
): IndexerContext {
  return {
    client: createChainClient(rpcUrl, new AbortController().signal),
    pool,
    deployment,
    log: silentLog,
    options: { confirmations, batchSize: 1000, pollIntervalMs: 10 },
  };
}

/** Indexes batch after batch until the indexer reaches the confirmed head. */
export async function catchUp(context: IndexerContext): Promise<void> {
  for (;;) {
    if (await indexNextBatch(context)) return;
  }
}

/**
 * Checks the projection against the chain, which is the oracle: the stored events are exactly the
 * contract logs, each escrow row matches `getEscrow` plus the transactions and timestamps of its
 * logs, and the withdrawals are exactly the EscrowWithdrawn logs.
 */
export async function expectProjectionMatchesChain(
  pool: Pool,
  client: TestClient,
  deployment: Deployment,
): Promise<void> {
  const logs = await client.getContractEvents({
    address: deployment.escrow,
    abi: escrowAbi,
    fromBlock: deployment.startBlock + 1n,
    toBlock: "latest",
    strict: true,
  });
  const stored = await pool.query<{ tx_hash: string; log_index: number }>(
    "SELECT tx_hash, log_index FROM events ORDER BY block_number, log_index",
  );
  expect(stored.rows).toEqual(
    logs.map((log) => ({ tx_hash: log.transactionHash.toLowerCase(), log_index: log.logIndex })),
  );

  const timestamps = new Map<bigint, bigint>();
  for (const log of logs) {
    if (!timestamps.has(log.blockNumber)) {
      timestamps.set(
        log.blockNumber,
        (await client.getBlock({ blockNumber: log.blockNumber })).timestamp,
      );
    }
  }
  const createdTx = new Map<bigint, Hash>();
  const resolution = new Map<bigint, { tx: Hash; at: bigint | undefined }>();
  const withdrawals = [];
  for (const log of logs) {
    const tx = log.transactionHash.toLowerCase() as Hash;
    const at = timestamps.get(log.blockNumber);
    if (log.eventName === "EscrowCreated") {
      createdTx.set(log.args.id, tx);
    } else if (log.eventName === "EscrowWithdrawn") {
      withdrawals.push({
        tx_hash: tx,
        log_index: log.logIndex,
        escrow_id: String(log.args.id),
        debited: String(log.args.debited),
        received: String(log.args.received),
        block_number: String(log.blockNumber),
        withdrawn_at: String(at),
      });
    } else {
      resolution.set(log.args.id, { tx, at });
    }
  }

  const count = await client.readContract({
    address: deployment.escrow,
    abi: escrowAbi,
    functionName: "escrowCount",
  });
  const expected = [];
  for (let id = 1n; id <= count; id++) {
    const escrow = await client.readContract({
      address: deployment.escrow,
      abi: escrowAbi,
      functionName: "getEscrow",
      args: [id],
    });
    const resolved = resolution.get(id);
    // numeric and bigint columns arrive as strings.
    expected.push({
      id: String(id),
      sender: escrow.sender.toLowerCase(),
      beneficiary: escrow.beneficiary.toLowerCase(),
      token: escrow.token.toLowerCase(),
      amount: String(escrow.amount),
      withdrawn: String(escrow.withdrawn),
      created_at: String(escrow.createdAt),
      cancel_deadline: String(escrow.cancelDeadline),
      expires_at: String(escrow.expiresAt),
      status: ONCHAIN_STATUS[escrow.status],
      created_tx: createdTx.get(id),
      resolved_tx: resolved?.tx ?? null,
      resolved_at: resolved?.at === undefined ? null : String(resolved.at),
    });
  }
  const escrows = await pool.query(
    `SELECT id, sender, beneficiary, token, amount, withdrawn, created_at, cancel_deadline,
            expires_at, status, created_tx, resolved_tx, resolved_at
     FROM escrows ORDER BY id`,
  );
  expect(escrows.rows).toEqual(expected);

  const storedWithdrawals = await pool.query(
    `SELECT tx_hash, log_index, escrow_id, debited, received, block_number, withdrawn_at
     FROM withdrawals ORDER BY block_number, log_index`,
  );
  expect(storedWithdrawals.rows).toEqual(withdrawals);
}
