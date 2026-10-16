import type { Address, Hash } from "viem";

import { withTransaction, type Pool, type PoolClient } from "../db/pool.js";
import type { EscrowStatus } from "../indexer/projector.js";
import type { EffectiveStatus, Escrow, Withdrawal } from "./view.js";

const COLUMNS = `id, sender, beneficiary, token, amount, withdrawn, created_at, cancel_deadline,
                 expires_at, status, created_tx, resolved_tx, resolved_at`;

/** numeric and bigint columns arrive as strings. */
interface EscrowRow {
  id: string;
  sender: Address;
  beneficiary: Address;
  token: Address;
  amount: string;
  withdrawn: string;
  created_at: string;
  cancel_deadline: string;
  expires_at: string;
  status: EscrowStatus;
  created_tx: Hash;
  resolved_tx: Hash | null;
  resolved_at: string | null;
}

const toEscrow = (row: EscrowRow, withdrawals: Withdrawal[]): Escrow => ({
  id: BigInt(row.id),
  sender: row.sender,
  beneficiary: row.beneficiary,
  token: row.token,
  amount: BigInt(row.amount),
  withdrawn: BigInt(row.withdrawn),
  createdAt: BigInt(row.created_at),
  cancelDeadline: BigInt(row.cancel_deadline),
  expiresAt: BigInt(row.expires_at),
  status: row.status,
  createdTx: row.created_tx,
  resolvedTx: row.resolved_tx,
  resolvedAt: row.resolved_at === null ? null : BigInt(row.resolved_at),
  withdrawals,
});

/** The escrows of `rows`, with their withdrawals in chain order. */
async function withWithdrawals(db: PoolClient, rows: EscrowRow[]): Promise<Escrow[]> {
  if (rows.length === 0) return [];
  const { rows: withdrawalRows } = await db.query<{
    escrow_id: string;
    tx_hash: Hash;
    withdrawn_at: string;
    debited: string;
    received: string;
  }>(
    `SELECT escrow_id, tx_hash, withdrawn_at, debited, received FROM withdrawals
     WHERE escrow_id = ANY($1::numeric[]) ORDER BY escrow_id, block_number, log_index`,
    [rows.map((row) => row.id)],
  );
  const byEscrow = new Map<string, Withdrawal[]>();
  for (const row of withdrawalRows) {
    const list = byEscrow.get(row.escrow_id) ?? [];
    list.push({
      txHash: row.tx_hash,
      withdrawnAt: BigInt(row.withdrawn_at),
      debited: BigInt(row.debited),
      received: BigInt(row.received),
    });
    byEscrow.set(row.escrow_id, list);
  }
  return rows.map((row) => toEscrow(row, byEscrow.get(row.id) ?? []));
}

/** One snapshot for every query of a request, so that they agree while the indexer writes. */
async function inSnapshot<T>(pool: Pool, read: (db: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return read(db);
  });
}

export async function findEscrow(pool: Pool, id: bigint): Promise<Escrow | undefined> {
  return inSnapshot(pool, async (db) => {
    const { rows } = await db.query<EscrowRow>(`SELECT ${COLUMNS} FROM escrows WHERE id = $1`, [
      id,
    ]);
    const [escrow] = await withWithdrawals(db, rows);
    return escrow;
  });
}

export interface EscrowFilter {
  /** Lowercase, like the stored addresses. */
  sender?: Address | undefined;
  beneficiary?: Address | undefined;
  status?: EffectiveStatus | undefined;
}

export interface Page {
  limit: number;
  offset: number;
}

/**
 * The escrows that match `filter`, newest first, and how many match in total. The effective status
 * is computed with `now`, with the same rule as `toView`. `total`, the page and its withdrawals come
 * from the same snapshot.
 */
export async function listEscrows(
  pool: Pool,
  filter: EscrowFilter,
  page: Page,
  now: bigint,
): Promise<{ escrows: Escrow[]; total: number }> {
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${String(params.length)}`;
  };

  const conditions: string[] = [];
  if (filter.sender) conditions.push(`sender = ${param(filter.sender)}`);
  if (filter.beneficiary) conditions.push(`beneficiary = ${param(filter.beneficiary)}`);
  switch (filter.status) {
    case undefined:
      break;
    case "Pending":
      conditions.push(`status = 'Pending' AND expires_at > ${param(now)}`);
      break;
    case "ExpiredRecoverable":
      conditions.push(`status = 'Pending' AND expires_at <= ${param(now)}`);
      break;
    default:
      conditions.push(`status = ${param(filter.status)}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const filterParams = [...params];
  const pageSql = `SELECT ${COLUMNS} FROM escrows ${where}
                   ORDER BY id DESC LIMIT ${param(page.limit)} OFFSET ${param(page.offset)}`;

  return inSnapshot(pool, async (db) => {
    const count = await db.query<{ total: string }>(
      `SELECT count(*) AS total FROM escrows ${where}`,
      filterParams,
    );
    const { rows } = await db.query<EscrowRow>(pageSql, params);
    return { escrows: await withWithdrawals(db, rows), total: Number(count.rows[0]?.total) };
  });
}

/** The contract the database was built from, or undefined if the indexer has not started yet. */
export async function findContractAddress(pool: Pool): Promise<Address | undefined> {
  const { rows } = await pool.query<{ contract_address: Address }>(
    "SELECT contract_address FROM indexer_state",
  );
  return rows[0]?.contract_address;
}

/** The checkpoint of the indexer, or undefined if it has not started yet. */
export async function findLastIndexedBlock(pool: Pool): Promise<bigint | undefined> {
  const { rows } = await pool.query<{ last_indexed_block: string }>(
    "SELECT last_indexed_block FROM indexer_state",
  );
  const row = rows[0];
  return row && BigInt(row.last_indexed_block);
}
