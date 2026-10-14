// Entry point: runs the migrations, checks the chain and indexes the Escrow events into Postgres.
// The HTTP API joins this process in phase 7 of the ROADMAP.
import { createChainClient } from "./chain.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { loadDeployment } from "./deployment.js";
import { ensureIndexerState, verifyDeployment } from "./indexer/guard.js";
import { runIndexer } from "./indexer/indexer.js";
import { createLogger } from "./logger.js";
import { retry } from "./retry.js";

const log = createLogger();
const shutdown = new AbortController();

// SIGTERM comes from `docker compose stop`: cancel the RPC requests in flight, let the DB transaction
// in progress commit, then exit. A second signal exits right away.
for (const name of ["SIGTERM", "SIGINT"] as const) {
  process.on(name, () => {
    if (shutdown.signal.aborted) {
      log.warn({ signal: name }, "second signal: exiting now");
      process.exit(1);
    }
    log.info({ signal: name }, "shutting down");
    shutdown.abort();
  });
}

async function main(signal: AbortSignal): Promise<void> {
  const config = loadConfig(process.env);
  log.level = config.logLevel;
  const deployment = await loadDeployment(config.deploymentsFile);
  const client = createChainClient(config.rpcUrl, signal);
  const pool = createPool(config.databaseUrl, log);
  try {
    await retry("migrations", () => migrate(pool, log), log, signal);
    await retry(
      "chain guard",
      async () => {
        await verifyDeployment(client, deployment);
        await ensureIndexerState(pool, deployment, config.resetOnChainMismatch, log);
      },
      log,
      signal,
    );
    await runIndexer(
      {
        client,
        pool,
        deployment,
        log,
        options: {
          confirmations: config.confirmations,
          batchSize: config.batchSize,
          pollIntervalMs: config.pollIntervalMs,
        },
      },
      signal,
    );
  } finally {
    await pool.end();
  }
}

try {
  await main(shutdown.signal);
} catch (error) {
  // Aborting by a signal is a clean exit; anything else is fatal.
  if (error !== shutdown.signal.reason) {
    log.fatal({ err: error }, "exiting");
    process.exitCode = 1;
  }
}
