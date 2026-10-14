// Entry point: runs the migrations and then, depending on MODE, the indexer that projects the Escrow
// events into Postgres, the HTTP API that serves them, or both.
import { createChainClient } from "./chain.js";
import { createChainClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { loadDeployment } from "./deployment.js";
import { buildServer, serve } from "./http/server.js";
import { ensureIndexerState, verifyDeployment } from "./indexer/guard.js";
import { runIndexer } from "./indexer/indexer.js";
import { createLogger } from "./logger.js";
import { retry } from "./retry.js";

const log = createLogger();
const shutdown = new AbortController();

// SIGTERM comes from `docker compose stop`: cancel the RPC requests in flight, let the DB transaction
// and the HTTP requests in progress finish, then exit. A second signal exits right away.
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

async function main(shutdown: AbortSignal): Promise<void> {
  const config = loadConfig(process.env);
  log.level = config.logLevel;
  const indexer = config.indexer && {
    ...config.indexer,
    deployment: await loadDeployment(config.indexer.deploymentsFile),
  };

  // Stops everything on a shutdown signal, and the indexer and the API as soon as either one fails.
  const stop = new AbortController();
  const signal = AbortSignal.any([shutdown, stop.signal]);
  const stopOnFailure = (component: Promise<void>) =>
    component.catch((error: unknown) => {
      stop.abort(error);
      throw error;
    });

  const client = createChainClient(config.rpcUrl, signal);
  const pool = createPool(config.databaseUrl, log);
  try {
    await retry("migrations", () => migrate(pool, log), log, signal);

    const components: Promise<void>[] = [];
    if (indexer) {
      await retry(
        "chain guard",
        async () => {
          await verifyDeployment(client, indexer.deployment);
          await ensureIndexerState(pool, indexer.deployment, indexer.resetOnChainMismatch, log);
        },
        log,
        signal,
      );
      const options = {
        confirmations: config.confirmations,
        batchSize: indexer.batchSize,
        pollIntervalMs: indexer.pollIntervalMs,
      };
      components.push(
        stopOnFailure(
          runIndexer({ client, pool, deployment: indexer.deployment, log, options }, signal),
        ),
      );
    }
    if (config.http) {
      const app = buildServer({
        pool,
        client,
        clock: createChainClock(client),
        log,
        health: { confirmations: config.confirmations, maxLag: config.http.healthMaxLag },
      });
      components.push(stopOnFailure(serve(app, config.http, signal)));
    }

    const results = await Promise.allSettled(components);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
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
