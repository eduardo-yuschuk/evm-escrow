import type { Address, Hash } from "viem";

import { withTransaction, type Pool, type PoolClient } from "../db/pool.js";
import type { Logger } from "../logger.js";
import type { IndexedEvent } from "./events.js";
import { applyEvent, type EscrowState, type EscrowStatus, type Mutation } from "./projector.js";

/** The chain and contract the database was built from, and how far it got. */
export interface IndexerState {
  chainId: number;
  contractAddress: Address;
  startBlock: bigint;
  startBlockHash: Hash;
  lastIndexedBlock: bigint;
}

/** Another writer moved the checkpoint while a batch was being read: the batch is discarded. */
export class CheckpointMovedError extends Error {
  override name = "CheckpointMovedError";
}

interface IndexerStateRow {
  chain_id: string;
  contract_address: Address;
  start_block: string;
  start_block_hash: Hash;
  last_indexed_block: string;
}

/** Reads the state row and locks it until the end of the transaction. */
export async function lockIndexerState(db: PoolClient): Promise<IndexerState | undefined> {
  const { rows } = await db.query<IndexerStateRow>(
    `SELECT chain_id, contract_address, start_block, start_block_hash, last_indexed_block
     FROM indexer_state FOR UPDATE`,
  );
  const row = rows[0];
  return (
    row && {
      chainId: Number(row.chain_id),
      contractAddress: row.contract_address,
      startBlock: BigInt(row.start_block),
      startBlockHash: row.start_block_hash,
      lastIndexedBlock: BigInt(row.last_indexed_block),
    }
  );
}

/** Replaces the state row. The projection, if any, must be emptied first (see `clearProjection`). */
export async function writeIndexerState(db: PoolClient, state: IndexerState): Promise<void> {
  await db.query(
    `INSERT INTO indexer_state
       (chain_id, contract_address, start_block, start_block_hash, last_indexed_block)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (singleton) DO UPDATE SET
       chain_id = EXCLUDED.chain_id,
       contract_address = EXCLUDED.contract_address,
       start_block = EXCLUDED.start_block,
       start_block_hash = EXCLUDED.start_block_hash,
       last_indexed_block = EXCLUDED.last_indexed_block,
       updated_at = now()`,
    [
      state.chainId,
      state.contractAddress,
      state.startBlock,
      state.startBlockHash,
      state.lastIndexedBlock,
    ],
  );
}

export async function clearProjection(db: PoolClient): Promise<void> {
  await db.query("TRUNCATE events, withdrawals, escrows");
}

export async function readCheckpoint(pool: Pool): Promise<bigint> {
  const { rows } = await pool.query<{ last_indexed_block: string }>(
    "SELECT last_indexed_block FROM indexer_state",
  );
  const row = rows[0];
  if (!row) throw new Error("indexer_state is empty: the chain guard must run first");
  return BigInt(row.last_indexed_block);
}

const eventKey = (txHash: string, logIndex: number) => `${txHash}:${String(logIndex)}`;

/** Inserts the events that are not stored yet and returns the keys of those. */
async function insertEvents(db: PoolClient, events: IndexedEvent[]): Promise<Set<string>> {
  if (events.length === 0) return new Set();
  const { rows } = await db.query<{ tx_hash: string; log_index: number }>(
    `INSERT INTO events (tx_hash, log_index, block_number, block_hash, block_timestamp, name, args)
     SELECT * FROM unnest(
       $1::text[], $2::integer[], $3::bigint[], $4::text[], $5::bigint[], $6::text[], $7::jsonb[]
     )
     ON CONFLICT (tx_hash, log_index) DO NOTHING
     RETURNING tx_hash, log_index`,
    [
      events.map((e) => e.txHash),
      events.map((e) => e.logIndex),
      events.map((e) => e.blockNumber),
      events.map((e) => e.blockHash),
      events.map((e) => e.blockTimestamp),
      events.map((e) => e.event.name),
      events.map((e) =>
        // uint256 values do not fit in a JSON number: stored as strings.
        JSON.stringify(e.event.args, (_, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ),
    ],
  );
  return new Set(rows.map((row) => eventKey(row.tx_hash, row.log_index)));
}

async function loadEscrowState(db: PoolClient, id: bigint): Promise<EscrowState | undefined> {
  const { rows } = await db.query<{
    status: EscrowStatus;
    amount: string;
    withdrawn: string;
    created_tx: Hash;
    resolved_tx: Hash | null;
  }>("SELECT status, amount, withdrawn, created_tx, resolved_tx FROM escrows WHERE id = $1", [id]);
  const row = rows[0];
  return (
    row && {
      status: row.status,
      amount: BigInt(row.amount),
      withdrawn: BigInt(row.withdrawn),
      createdTx: row.created_tx,
      resolvedTx: row.resolved_tx,
    }
  );
}

async function writeMutation(
  db: PoolClient,
  mutation: Mutation,
  indexed: IndexedEvent,
  log: Logger,
): Promise<void> {
  switch (mutation.kind) {
    case "create": {
      const escrow = mutation.escrow;
      await db.query(
        `INSERT INTO escrows (id, sender, beneficiary, token, amount, created_at, cancel_deadline,
                              expires_at, status, created_tx)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending', $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          escrow.id,
          escrow.sender,
          escrow.beneficiary,
          escrow.token,
          escrow.amount,
          escrow.createdAt,
          escrow.cancelDeadline,
          escrow.expiresAt,
          escrow.createdTx,
        ],
      );
      return;
    }
    case "resolve":
      await db.query(
        `UPDATE escrows SET status = $2, resolved_tx = $3, resolved_at = $4
         WHERE id = $1 AND status = 'Pending'`,
        [mutation.id, mutation.status, mutation.resolvedTx, mutation.resolvedAt],
      );
      return;
    case "withdraw": {
      const withdrawal = mutation.withdrawal;
      // Counted only if the row is new: the constraints on escrows reject a Pending escrow or a
      // withdrawn above the amount.
      await db.query(
        `WITH inserted AS (
           INSERT INTO withdrawals (tx_hash, log_index, escrow_id, debited, received, block_number,
                                    withdrawn_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tx_hash, log_index) DO NOTHING
           RETURNING escrow_id, debited
         )
         UPDATE escrows SET withdrawn = escrows.withdrawn + inserted.debited
         FROM inserted WHERE escrows.id = inserted.escrow_id`,
        [
          withdrawal.txHash,
          withdrawal.logIndex,
          withdrawal.id,
          withdrawal.debited,
          withdrawal.received,
          withdrawal.blockNumber,
          withdrawal.withdrawnAt,
        ],
      );
      return;
    }
    case "skip":
      log[mutation.level](
        {
          escrowId: indexed.event.args.id,
          event: indexed.event.name,
          blockNumber: indexed.blockNumber,
          txHash: indexed.txHash,
          logIndex: indexed.logIndex,
        },
        `event not applied: ${mutation.reason}`,
      );
      return;
  }
}

/**
 * Stores the events of `[fromBlock, toBlock]`, applies the new ones to the projection and moves the
 * checkpoint to `toBlock`, all in one transaction: a crash leaves either all of it or none.
 * Events already stored (a range processed again) are not applied twice. Returns how many events
 * were new.
 */
export async function commitBatch(
  pool: Pool,
  fromBlock: bigint,
  toBlock: bigint,
  events: IndexedEvent[],
  log: Logger,
): Promise<number> {
  return withTransaction(pool, async (db) => {
    const state = await lockIndexerState(db);
    if (state?.lastIndexedBlock !== fromBlock - 1n) {
      throw new CheckpointMovedError(
        `Checkpoint moved to ${String(state?.lastIndexedBlock)} while indexing from ${String(fromBlock)}`,
      );
    }

    const fresh = await insertEvents(db, events);
    for (const indexed of events) {
      if (!fresh.has(eventKey(indexed.txHash, indexed.logIndex))) continue;
      const current = await loadEscrowState(db, indexed.event.args.id);
      await writeMutation(db, applyEvent(current, indexed), indexed, log);
    }

    await db.query("UPDATE indexer_state SET last_indexed_block = $1, updated_at = now()", [
      toBlock,
    ]);
    return fresh.size;
  });
}
