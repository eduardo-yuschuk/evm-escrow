import type { FastifyInstance } from "fastify";
import { getAddress, isAddress, maxUint256, type Address } from "viem";
import { z } from "zod";

import type { ChainClient } from "../chain.js";
import type { ChainClock } from "../clock.js";
import type { Pool } from "../db/pool.js";
import { HttpError, parseInput } from "./errors.js";
import { findContractAddress, findEscrow, listEscrows } from "./queries.js";
import { EFFECTIVE_STATUSES, toView } from "./view.js";
import { maxWithdrawal } from "./withdrawal.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const idSchema = z
  .string()
  .regex(/^\d{1,78}$/, "expected a decimal integer")
  .transform((value) => BigInt(value))
  .refine((id) => id <= maxUint256, "out of the uint256 range");

/** Any letter case: the checksum is not enforced. */
const addressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "invalid address")
  .transform((value) => value.toLowerCase() as Address);

const integerSchema = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, "expected a non-negative integer")
    .transform(Number)
    .pipe(z.number().min(min).max(max));

/** Unknown parameters are rejected, so that a typo does not silently drop a filter. */
const listQuerySchema = z.strictObject({
  sender: addressSchema.optional(),
  beneficiary: addressSchema.optional(),
  status: z.enum(EFFECTIVE_STATUSES).optional(),
  limit: integerSchema(1, MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: integerSchema(0, Number.MAX_SAFE_INTEGER).default(0),
});

/** An empty parameter (`?status=`) means "not given", as in `/escrows?sender=&beneficiary=&status=`. */
function withoutEmptyValues(query: unknown): unknown {
  if (typeof query !== "object" || query === null) return query;
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== ""));
}

/** The derived state needs the chain clock: without the node there is no answer. */
async function chainNow(clock: ChainClock): Promise<bigint> {
  try {
    return await clock.now();
  } catch (error) {
    throw new HttpError(503, "Cannot read the latest block from the chain", { cause: error });
  }
}

/** Nor without the database: a failed or timed out query is unavailability, not a bug. */
async function fromDatabase<T>(query: Promise<T>): Promise<T> {
  try {
    return await query;
  } catch (error) {
    throw new HttpError(503, "Cannot read the database", { cause: error });
  }
}

export function escrowRoutes(
  app: FastifyInstance,
  { pool, client, clock }: { pool: Pool; client: ChainClient; clock: ChainClock },
): void {
  app.get("/escrows/:id", async (request) => {
    const { id } = parseInput(z.object({ id: idSchema }), request.params);
    const [escrow, now] = await Promise.all([fromDatabase(findEscrow(pool, id)), chainNow(clock)]);
    if (!escrow) throw new HttpError(404, `Escrow ${id.toString()} not found`);
    return toView(escrow, now);
  });

  // The largest transferAmount the holder can withdraw now, found by simulating withdrawals against
  // the latest block. Reads the escrow from the chain: the projection may lag behind.
  app.get("/escrows/:id/max-withdrawal", async (request) => {
    const { id } = parseInput(z.object({ id: idSchema }), request.params);
    const escrow = await fromDatabase(findContractAddress(pool));
    if (!escrow) throw new HttpError(503, "The indexer has not started yet");
    let result;
    try {
      result = await maxWithdrawal(client, escrow, id);
    } catch (error) {
      throw new HttpError(503, "Cannot simulate the withdrawal against the chain", {
        cause: error,
      });
    }
    if (!result) throw new HttpError(404, `Escrow ${id.toString()} not found`);
    // Nothing passes, and not because of a fee: e.g. the token blocks the holder.
    if (result.transferAmount === 0n && result.failure && result.failure.debited === undefined) {
      throw new HttpError(
        409,
        `A withdrawal from escrow ${id.toString()} reverts with any amount: ${result.failure.reason}`,
      );
    }
    return {
      id: id.toString(),
      holder: result.holder && getAddress(result.holder),
      withdrawable: result.withdrawable.toString(),
      transferAmount: result.transferAmount.toString(),
      received: result.received.toString(),
      blockNumber: Number(result.blockNumber),
    };
  });

  app.get("/escrows", async (request) => {
    const query = parseInput(listQuerySchema, withoutEmptyValues(request.query));
    const now = await chainNow(clock);
    const { escrows, total } = await fromDatabase(listEscrows(pool, query, query, now));
    return {
      items: escrows.map((escrow) => toView(escrow, now)),
      limit: query.limit,
      offset: query.offset,
      total,
    };
  });
}
