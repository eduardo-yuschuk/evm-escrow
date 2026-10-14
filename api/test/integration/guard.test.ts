import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createChainClient } from "../../src/chain.js";
import type { Deployment } from "../../src/deployment.js";
import {
  ChainMismatchError,
  ensureIndexerState,
  verifyDeployment,
} from "../../src/indexer/guard.js";
import {
  alice,
  bob,
  createActivity,
  createEscrow,
  deployContracts,
  startAnvil,
  type Anvil,
} from "../support/chain.js";
import {
  createTestDatabase,
  dumpProjection,
  readCheckpoint,
  silentLog,
  type TestDatabase,
} from "../support/db.js";
import { catchUp, expectProjectionMatchesChain, indexerContext } from "../support/indexer.js";

let db: TestDatabase;
/** The deployments file of the first chain, whose projection is in the database. */
let oldDeployment: Deployment;
/** Anvil after the restart, with the contracts deployed again. */
let restarted: Anvil;
let deployment: Deployment;

beforeAll(async () => {
  db = await createTestDatabase();
  return db.drop;
});

// Indexes a chain, then replaces its node with a new one, as `docker compose down` and `up` do
// with Anvil while Postgres keeps its volume.
beforeEach(async () => {
  await db.reset();
  const first = await startAnvil();
  try {
    oldDeployment = await deployContracts(first.client);
    await ensureIndexerState(db.pool, oldDeployment, false, silentLog);
    await createActivity(first.client, oldDeployment, 2);
    await catchUp(indexerContext(db.pool, first.url, oldDeployment));
  } finally {
    await first.stop();
  }

  // A genesis block from another second: two Anvils started within the same second, with the
  // same flags, would be the same chain.
  const genesis = Math.floor(Date.now() / 1000) + 3600;
  restarted = await startAnvil(["--timestamp", String(genesis)]);
  deployment = await deployContracts(restarted.client);
  return restarted.stop;
});

describe("chain guard after an Anvil restart", () => {
  it("only the hash of the start block tells the new chain apart", () => {
    expect(deployment).toMatchObject({
      chainId: oldDeployment.chainId,
      escrow: oldDeployment.escrow,
      token: oldDeployment.token,
      startBlock: oldDeployment.startBlock,
    });
    expect(deployment.startBlockHash).not.toBe(oldDeployment.startBlockHash);
  });

  it("rejects the old deployments file", async () => {
    const client = createChainClient(restarted.url, new AbortController().signal);
    await expect(verifyDeployment(client, oldDeployment)).rejects.toThrow(ChainMismatchError);
    await expect(verifyDeployment(client, deployment)).resolves.toBeUndefined();
  });

  it("aborts without RESET_ON_CHAIN_MISMATCH, leaving the database untouched", async () => {
    const before = await dumpProjection(db.pool);
    const checkpoint = await readCheckpoint(db.pool);

    await expect(ensureIndexerState(db.pool, deployment, false, silentLog)).rejects.toThrow(
      ChainMismatchError,
    );

    expect(await dumpProjection(db.pool)).toEqual(before);
    expect(await readCheckpoint(db.pool)).toBe(checkpoint);
  });

  it("with RESET_ON_CHAIN_MISMATCH, wipes the database and indexes the new chain", async () => {
    await ensureIndexerState(db.pool, deployment, true, silentLog);

    expect(await dumpProjection(db.pool)).toEqual({ events: [], escrows: [] });
    expect(await readCheckpoint(db.pool)).toBe(deployment.startBlock);

    await createEscrow(restarted.client, deployment, bob, alice.address);
    await catchUp(indexerContext(db.pool, restarted.url, deployment));
    await expectProjectionMatchesChain(db.pool, restarted.client, deployment);
  });
});
