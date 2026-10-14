import type { ChainClient } from "./chain.js";

/** How long the timestamp of the latest block is reused before asking the node again. */
const TTL_MS = 1_000;

/**
 * "Now" for the state derived from time: the timestamp of the latest block, not the server clock.
 * That is what the contract compares its deadlines with, and it follows the node when the demo
 * moves time forward on Anvil.
 */
export interface ChainClock {
  now(): Promise<bigint>;
}

/**
 * Reuses the timestamp for `ttlMs`, and concurrent callers share a single request to the node.
 * Failures are not cached: the next call asks again.
 */
export function createChainClock(client: ChainClient, ttlMs = TTL_MS): ChainClock {
  let cached: { timestamp: bigint; fetchedAt: number } | undefined;
  let inFlight: Promise<bigint> | undefined;

  return {
    now() {
      if (cached && performance.now() - cached.fetchedAt < ttlMs) {
        return Promise.resolve(cached.timestamp);
      }
      if (!inFlight) {
        const fetchedAt = performance.now();
        inFlight = client
          .getBlock()
          .then((block) => {
            cached = { timestamp: block.timestamp, fetchedAt };
            return block.timestamp;
          })
          .finally(() => {
            inFlight = undefined;
          });
      }
      return inFlight;
    },
  };
}
