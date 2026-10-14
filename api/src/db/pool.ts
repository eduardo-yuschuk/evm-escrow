import { Pool, type PoolClient } from "pg";

import type { Logger } from "../logger.js";

export type { Pool, PoolClient };

export function createPool(databaseUrl: string, log: Logger): Pool {
  const pool = new Pool({ connectionString: databaseUrl });
  // An idle connection can fail (e.g. Postgres restarts). Without a listener the process would crash;
  // the pool discards the connection and the next query opens a new one.
  pool.on("error", (error) => {
    log.warn({ err: error }, "idle database connection failed");
  });
  return pool;
}

/** Runs `fn` inside a transaction: commits if it resolves, rolls back if it throws. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is unusable: destroy it instead of returning it to the pool.
      destroy = true;
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}
