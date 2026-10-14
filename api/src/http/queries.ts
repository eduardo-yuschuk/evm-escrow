import type { Address, Hash } from "viem";

import { withTransaction, type Pool } from "../db/pool.js";
import type { EscrowStatus } from "../indexer/projector.js";
import type { EffectiveStatus, Escrow } from "./view.js";

const COLUMNS = `id, sender, beneficiary, token, amount, created_at, cancel_deadline, expires_at,
                 status, created_tx, resolved_tx, resolved_at`;

/** numeric and bigint columns arrive as strings. */
interface EscrowRow {
  id: string;
  sender: Address;
  beneficiary: Address;
  token: Address;
  amount: string;
  created_at: string;
  cancel_deadline: string;
  expires_at: string;
  status: EscrowStatus;
  created_tx: Hash;
  resolved_tx: Hash | null;
  resolved_at: string | null;
}

const toEscrow = (row: EscrowRow): Escrow => ({
  id: BigInt(row.id),
  sender: row.sender,
  beneficiary: row.beneficiary,
  token: row.token,
  amount: BigInt(row.amount),
  createdAt: BigInt(row.created_at),
  cancelDeadline: BigInt(row.cancel_deadline),
  expiresAt: BigInt(row.expires_at),
  status: row.status,
  createdTx: row.created_tx,
  resolvedTx: row.resolved_tx,
  resolvedAt: row.resolved_at === null ? null : BigInt(row.resolved_at),
});

export async function findEscrow(pool: Pool, id: bigint): Promise<Escrow | undefined> {
  const { rows } = await pool.query<EscrowRow>(`SELECT ${COLUMNS} FROM escrows WHERE id = $1`, [
    id,
  ]);
  const row = rows[0];
  return row && toEscrow(row);
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
 * is computed with `now`, with the same rule as `toView`.
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

  return withTransaction(pool, async (db) => {
    // One snapshot for both queries, so that `total` matches the page while the indexer writes.
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const count = await db.query<{ total: string }>(
      `SELECT count(*) AS total FROM escrows ${where}`,
      filterParams,
    );
    const { rows } = await db.query<EscrowRow>(pageSql, params);
    return { escrows: rows.map(toEscrow), total: Number(count.rows[0]?.total) };
  });
}

/** The checkpoint of the indexer, or undefined if it has not started yet. */
export async function findLastIndexedBlock(pool: Pool): Promise<bigint | undefined> {
  const { rows } = await pool.query<{ last_indexed_block: string }>(
    "SELECT last_indexed_block FROM indexer_state",
  );
  const row = rows[0];
  return row && BigInt(row.last_indexed_block);
}
