import type { FastifyInstance } from "fastify";

import type { ChainClient } from "../chain.js";
import type { Pool } from "../db/pool.js";
import { findLastIndexedBlock } from "./queries.js";

/** Each check gives up after this long, so that /health answers even if a dependency hangs. */
const CHECK_TIMEOUT_MS = 2_000;

export interface HealthOptions {
  /** The lag the indexer keeps on purpose. */
  confirmations: number;
  /** Blocks of lag tolerated on top of `confirmations`. */
  maxLag: number;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`No answer after ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function check<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const [result] = await Promise.allSettled([withTimeout(promise, CHECK_TIMEOUT_MS)]);
  return result;
}

const toNumber = (value: bigint | undefined) => (value === undefined ? null : Number(value));

/**
 * Database and RPC reachability, the checkpoint, the chain head and the lag between them. Answers
 * 503 with status "degraded" when a check fails, the indexer has not started yet, or the lag is
 * negative or beyond `confirmations + maxLag`.
 */
export function healthRoutes(
  app: FastifyInstance,
  { pool, client, options }: { pool: Pool; client: ChainClient; options: HealthOptions },
): void {
  app.get("/health", async (request, reply) => {
    // The checkpoint is read before the head, so the head can only be below it if the chain went
    // backward: the node was restarted or replaced, or it lags behind the one the indexer reads.
    const db = await check(findLastIndexedBlock(pool));
    const rpc = await check(client.getBlockNumber());
    if (db.status === "rejected") {
      request.log.warn({ err: db.reason }, "health check: database failed");
    }
    if (rpc.status === "rejected") {
      request.log.warn({ err: rpc.reason }, "health check: RPC failed");
    }

    const lastIndexedBlock = db.status === "fulfilled" ? db.value : undefined;
    const chainHead = rpc.status === "fulfilled" ? rpc.value : undefined;
    const lag =
      lastIndexedBlock === undefined || chainHead === undefined
        ? undefined
        : chainHead - lastIndexedBlock;
    const ok =
      lag !== undefined && lag >= 0n && lag <= BigInt(options.confirmations + options.maxLag);

    reply.code(ok ? 200 : 503);
    return {
      status: ok ? "ok" : "degraded",
      db: db.status === "fulfilled" ? "ok" : "error",
      rpc: rpc.status === "fulfilled" ? "ok" : "error",
      lastIndexedBlock: toNumber(lastIndexedBlock),
      chainHead: toNumber(chainHead),
      lag: toNumber(lag),
    };
  });
}
