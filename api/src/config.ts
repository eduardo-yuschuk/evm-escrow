import { z } from "zod";

import { FatalError } from "./errors.js";

const envSchema = z
  .object({
    /** all: indexer and HTTP API in this process. indexer or api: only one of them. */
    MODE: z.enum(["all", "indexer", "api"]).default("all"),
    RPC_URL: z.url(),
    DATABASE_URL: z.url(),
    /** deployments/<chainId>.json written by contracts/script/Deploy.s.sol. */
    DEPLOYMENTS_FILE: z.string().min(1).optional(),
    /** Only blocks with at least this many blocks on top are indexed (reorg safety). */
    CONFIRMATIONS: z.coerce.number().int().nonnegative().default(0),
    /** Maximum block range per eth_getLogs call and per DB transaction. */
    BATCH_SIZE: z.coerce.number().int().positive().default(1000),
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    /** Wipe the projection and reindex when the DB belongs to another chain or contract. */
    RESET_ON_CHAIN_MISMATCH: z.stringbool().default(false),
    HOST: z.string().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    /** Blocks of lag tolerated on top of CONFIRMATIONS before /health reports degraded. */
    HEALTH_MAX_LAG: z.coerce.number().int().nonnegative().default(10),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
  })
  .refine((vars) => vars.MODE === "api" || vars.DEPLOYMENTS_FILE !== undefined, {
    path: ["DEPLOYMENTS_FILE"],
    message: "Required unless MODE=api",
  });

type Env = z.infer<typeof envSchema>;

export interface IndexerConfig {
  deploymentsFile: string;
  batchSize: number;
  pollIntervalMs: number;
  resetOnChainMismatch: boolean;
}

export interface HttpConfig {
  host: string;
  port: number;
  healthMaxLag: number;
}

export interface Config {
  rpcUrl: string;
  databaseUrl: string;
  /** Used by the indexer, and by /health to tell the expected lag from a real one. */
  confirmations: number;
  logLevel: Env["LOG_LEVEL"];
  /** Undefined with MODE=api. */
  indexer: IndexerConfig | undefined;
  /** Undefined with MODE=indexer. */
  http: HttpConfig | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // An empty variable (e.g. `CONFIRMATIONS=`) means "use the default", not zero.
  const defined = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const result = envSchema.safeParse(defined);
  if (!result.success) {
    throw new FatalError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  const vars = result.data;
  // The schema requires DEPLOYMENTS_FILE unless MODE=api.
  const deploymentsFile = vars.DEPLOYMENTS_FILE;
  return {
    rpcUrl: vars.RPC_URL,
    databaseUrl: vars.DATABASE_URL,
    confirmations: vars.CONFIRMATIONS,
    logLevel: vars.LOG_LEVEL,
    indexer:
      vars.MODE === "api" || deploymentsFile === undefined
        ? undefined
        : {
            deploymentsFile,
            batchSize: vars.BATCH_SIZE,
            pollIntervalMs: vars.POLL_INTERVAL_MS,
            resetOnChainMismatch: vars.RESET_ON_CHAIN_MISMATCH,
          },
    http:
      vars.MODE === "indexer"
        ? undefined
        : { host: vars.HOST, port: vars.PORT, healthMaxLag: vars.HEALTH_MAX_LAG },
  };
}
