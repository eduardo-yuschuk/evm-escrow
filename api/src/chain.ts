import { createPublicClient, http } from "viem";

/**
 * JSON-RPC client. Nothing is cached, since the indexer polls the chain head, and failed requests are
 * not retried here: the caller retries with backoff and logs every failure. Requests in flight are
 * cancelled when `shutdown` aborts, so a node that does not answer cannot delay the exit.
 */
export function createChainClient(rpcUrl: string, shutdown: AbortSignal) {
  return createPublicClient({
    transport: http(rpcUrl, {
      retryCount: 0,
      fetchFn: (input, init) =>
        fetch(input, {
          ...init,
          // init.signal enforces viem's request timeout.
          signal: init?.signal ? AbortSignal.any([init.signal, shutdown]) : shutdown,
        }),
    }),
    cacheTime: 0,
  });
}

export type ChainClient = ReturnType<typeof createChainClient>;
