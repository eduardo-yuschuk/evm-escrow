import { setTimeout as delay } from "node:timers/promises";

import { FatalError } from "./errors.js";
import type { Logger } from "./logger.js";

const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/** Waits `ms` or until `signal` aborts, whichever comes first. Never rejects. */
export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // Aborted: the caller checks the signal.
  }
}

/** Exponential backoff with a cap: 0.5 s, 1 s, 2 s, ... 30 s. */
export function backoffDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, INITIAL_DELAY_MS * 2 ** (attempt - 1));
}

/**
 * Runs `task` until it succeeds, waiting with exponential backoff after each failure (RPC or DB
 * unreachable, timeouts, ...). A FatalError is rethrown at once. Once `signal` aborts, throws its
 * reason instead of starting another attempt.
 */
export async function retry<T>(
  what: string,
  task: () => Promise<T>,
  log: Logger,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await task();
    } catch (error) {
      if (error instanceof FatalError) throw error;
      // Shutting down cancels the RPC requests in flight: that failure is expected.
      signal.throwIfAborted();
      const retryInMs = backoffDelay(attempt);
      log.error({ err: error, attempt, retryInMs }, `${what} failed`);
      await sleep(retryInMs, signal);
    }
  }
}
