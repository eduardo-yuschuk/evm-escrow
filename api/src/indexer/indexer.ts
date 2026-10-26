import type { ChainClient } from "../chain.js";
import type { Pool } from "../db/pool.js";
import type { Deployment } from "../deployment.js";
import type { Logger } from "../logger.js";
import { retry, sleep } from "../retry.js";
import { fetchEvents } from "./events.js";
import { verifyDeployment } from "./guard.js";
import { commitBatch, readCheckpoint } from "./store.js";

export interface IndexerOptions {
  confirmations: number;
  batchSize: number;
  pollIntervalMs: number;
}

export interface IndexerContext {
  client: ChainClient;
  pool: Pool;
  deployment: Deployment;
  options: IndexerOptions;
  log: Logger;
}

/** Indexes the next range of confirmed blocks, if any. Returns true when it caught up with the chain. */
export async function indexNextBatch({
  client,
  pool,
  deployment,
  options,
  log,
}: IndexerContext): Promise<boolean> {
  // Read on every round, so that a checkpoint moved by hand is honored.
  const checkpoint = await readCheckpoint(pool);
  const head = await client.getBlockNumber();

  console.debug(`Checkpoint: ${checkpoint}, Head: ${head}`);

  if (head < checkpoint) {
    // Either a lagging RPC node, which is worth waiting for, or another chain, which is fatal.
    await verifyDeployment(client, deployment);
    log.warn({ head, checkpoint }, "the chain head is behind the checkpoint: waiting");
    return true;
  }

  const confirmedHead = head - BigInt(options.confirmations);
  if (confirmedHead <= checkpoint) return true;

  const fromBlock = checkpoint + 1n;
  const lastInBatch = checkpoint + BigInt(options.batchSize);
  const toBlock = lastInBatch < confirmedHead ? lastInBatch : confirmedHead;

  const events = await fetchEvents(client, deployment.escrow, fromBlock, toBlock);
  const newEvents = await commitBatch(pool, fromBlock, toBlock, events, log);
  log[events.length > 0 ? "info" : "debug"](
    { fromBlock, toBlock, events: events.length, newEvents, head },
    "blocks indexed",
  );
  return toBlock === confirmedHead;
}

/**
 * Polls the chain and projects the contract events until `signal` aborts. Each round indexes at
 * most `batchSize` blocks up to `head - confirmations`; it sleeps only once caught up. RPC and DB
 * failures are retried with backoff. On abort, a batch that is being written is committed first;
 * one that is still being read is dropped, and indexed again on the next start.
 */
export async function runIndexer(context: IndexerContext, signal: AbortSignal): Promise<void> {
  const { deployment, options, log } = context;
  log.info({ escrow: deployment.escrow, ...options }, "indexer started");
  try {
    while (!signal.aborted) {
      const caughtUp = await retry("indexing", () => indexNextBatch(context), log, signal);
      if (caughtUp) await sleep(options.pollIntervalMs, signal);
    }
  } catch (error) {
    if (error !== signal.reason) throw error;
  }
  log.info("indexer stopped");
}
