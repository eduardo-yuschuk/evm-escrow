import { z } from "zod";

import { FatalError } from "./errors.js";

const envSchema = z.object({
  RPC_URL: z.url(),
  DATABASE_URL: z.url(),
  /** deployments/<chainId>.json written by contracts/script/Deploy.s.sol. */
  DEPLOYMENTS_FILE: z.string().min(1),
  /** Only blocks with at least this many blocks on top are indexed (reorg safety). */
  CONFIRMATIONS: z.coerce.number().int().nonnegative().default(0),
  /** Maximum block range per eth_getLogs call and per DB transaction. */
  BATCH_SIZE: z.coerce.number().int().positive().default(1000),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  /** Wipe the projection and reindex when the DB belongs to another chain or contract. */
  RESET_ON_CHAIN_MISMATCH: z.stringbool().default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface Config {
  rpcUrl: string;
  databaseUrl: string;
  deploymentsFile: string;
  confirmations: number;
  batchSize: number;
  pollIntervalMs: number;
  resetOnChainMismatch: boolean;
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // An empty variable (e.g. `CONFIRMATIONS=`) means "use the default", not zero.
  const defined = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const result = envSchema.safeParse(defined);
  if (!result.success) {
    throw new FatalError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  const vars = result.data;
  return {
    rpcUrl: vars.RPC_URL,
    databaseUrl: vars.DATABASE_URL,
    deploymentsFile: vars.DEPLOYMENTS_FILE,
    confirmations: vars.CONFIRMATIONS,
    batchSize: vars.BATCH_SIZE,
    pollIntervalMs: vars.POLL_INTERVAL_MS,
    resetOnChainMismatch: vars.RESET_ON_CHAIN_MISMATCH,
    logLevel: vars.LOG_LEVEL,
  };
}
