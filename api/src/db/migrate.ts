import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { FatalError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Pool } from "./pool.js";

/** api/migrations, both from src/db (tsx) and from dist/db (compiled). */
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../migrations");
const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** Arbitrary key for pg_advisory_lock: serializes processes that start at the same time. */
const LOCK_KEY = 6_102_026;

interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(): Promise<Migration[]> {
  const migrations: Migration[] = [];
  for (const name of (await readdir(MIGRATIONS_DIR)).sort()) {
    const match = FILE_NAME.exec(name);
    if (!match?.[1]) {
      throw new FatalError(`Unexpected file in ${MIGRATIONS_DIR}: ${name}`);
    }
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    // Line endings are normalized so that a CRLF checkout does not look like an edited migration.
    const checksum = createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");
    migrations.push({ version: Number(match[1]), name, sql, checksum });
  }
  return migrations;
}

/**
 * Applies the pending migrations in api/migrations, in order, each one in its own transaction.
 * Applied migrations are recorded in schema_migrations with their checksum: editing a migration
 * that already ran, or running code older than the database, is a fatal error.
 */
export async function migrate(pool: Pool, log: Logger): Promise<void> {
  const migrations = await loadMigrations();
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows: applied } = await client.query<{ version: number; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    const known = new Map(migrations.map((migration) => [migration.version, migration]));
    for (const row of applied) {
      const migration = known.get(row.version);
      if (!migration) {
        throw new FatalError(
          `Migration ${String(row.version)} was applied but is not in this build`,
        );
      }
      if (migration.checksum !== row.checksum) {
        throw new FatalError(`Migration ${migration.name} changed after being applied`);
      }
    }

    const appliedVersions = new Set(applied.map((row) => row.version));
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
        [migration.version, migration.name, migration.checksum],
      );
      await client.query("COMMIT");
      log.info({ migration: migration.name }, "migration applied");
    }

    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // On failure the connection is destroyed: Postgres rolls back the open transaction, if any, and
    // releases the advisory lock.
    client.release(failed);
  }
}
