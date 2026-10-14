// An isolated database for each test file: a schema of its own in TEST_DATABASE_URL, migrated.
import { randomUUID } from "node:crypto";

import { pino } from "pino";

import { migrate } from "../../src/db/migrate.js";
import { createPool, type Pool } from "../../src/db/pool.js";

export const silentLog = pino({ level: "silent" });

export interface TestDatabase {
  /** Connection string that selects the schema, e.g. for a child process. */
  url: string;
  pool: Pool;
  /** Empties every table: the next indexer starts from a new database. */
  reset: () => Promise<void>;
  drop: () => Promise<void>;
}

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set: run the tests with `docker compose run --rm npm test`",
    );
  }
  return url;
}

/** A new schema, used through search_path, so that test files can run in parallel. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const baseUrl = testDatabaseUrl();
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = createPool(baseUrl, silentLog);
  await admin.query(`CREATE SCHEMA ${schema}`);

  const url = new URL(baseUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const pool = createPool(url.toString(), silentLog);
  await migrate(pool, silentLog);

  return {
    url: url.toString(),
    pool,
    reset: async () => {
      await pool.query("TRUNCATE events, escrows, indexer_state");
    },
    drop: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export async function readCheckpoint(pool: Pool): Promise<bigint | undefined> {
  const { rows } = await pool.query<{ last_indexed_block: string }>(
    "SELECT last_indexed_block FROM indexer_state",
  );
  const row = rows[0];
  return row && BigInt(row.last_indexed_block);
}

export async function countEvents(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM events");
  return Number(rows[0]?.count);
}

/** Every row of the projection, in a stable order. */
export async function dumpProjection(
  pool: Pool,
): Promise<{ events: unknown[]; escrows: unknown[] }> {
  const events = await pool.query("SELECT * FROM events ORDER BY block_number, log_index");
  const escrows = await pool.query("SELECT * FROM escrows ORDER BY id");
  return { events: events.rows, escrows: escrows.rows };
}
