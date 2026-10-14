// The status derived from time, against a chain whose clock the tests move: separate from
// http.test.ts so that moving time does not disturb its escrows.
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createChainClient } from "../../src/chain.js";
import { createChainClock } from "../../src/clock.js";
import type { Deployment } from "../../src/deployment.js";
import { escrowAbi } from "../../src/generated/contracts.js";
import { buildServer } from "../../src/http/server.js";
import type { EscrowView } from "../../src/http/view.js";
import { ensureIndexerState } from "../../src/indexer/guard.js";
import type { IndexerContext } from "../../src/indexer/indexer.js";
import {
  alice,
  bob,
  CANCEL_WINDOW,
  createEscrow,
  deployContracts,
  ONCHAIN_STATUS,
  startAnvil,
  TTL,
  type Anvil,
} from "../support/chain.js";
import { countEvents, createTestDatabase, silentLog, type TestDatabase } from "../support/db.js";
import { catchUp, indexerContext } from "../support/indexer.js";

let anvil: Anvil;
let db: TestDatabase;
let deployment: Deployment;
let context: IndexerContext;
let app: FastifyInstance;

beforeAll(async () => {
  anvil = await startAnvil();
  return anvil.stop;
});

beforeAll(async () => {
  db = await createTestDatabase();
  return db.drop;
});

beforeAll(async () => {
  deployment = await deployContracts(anvil.client);
  await ensureIndexerState(db.pool, deployment, false, silentLog);
  context = indexerContext(db.pool, anvil.url, deployment);
  const client = createChainClient(anvil.url, new AbortController().signal);
  app = buildServer({
    pool: db.pool,
    client,
    clock: createChainClock(client, 0),
    log: silentLog,
    health: { confirmations: 0, maxLag: 10 },
  });
});

afterAll(async () => {
  await app.close();
});

const view = async (id: bigint) =>
  (await app.inject({ method: "GET", url: `/escrows/${String(id)}` })).json<EscrowView>();

const listed = async (status: string, id: bigint) => {
  const response = await app.inject({ method: "GET", url: `/escrows?status=${status}` });
  return response.json<{ items: EscrowView[] }>().items.some((item) => item.id === String(id));
};

/** Mines the next block at `timestamp`. */
const mineAt = async (timestamp: bigint) => {
  await anvil.client.setNextBlockTimestamp({ timestamp });
  await anvil.client.mine({ blocks: 1 });
};

describe("status derived from the chain clock", () => {
  it("turns a Pending escrow ExpiredRecoverable after evm_increaseTime, with no transaction", async () => {
    const { client } = anvil;
    const { id } = await createEscrow(client, deployment, alice, bob.address);
    await catchUp(context);
    expect((await view(id)).status).toBe("Pending");
    const events = await countEvents(db.pool);

    await client.increaseTime({ seconds: Number(TTL) });
    await client.mine({ blocks: 1 });

    expect(await view(id)).toMatchObject({
      onchainStatus: "Pending",
      status: "ExpiredRecoverable",
      canCancel: false,
      canConfirm: false,
      canReject: false,
      canRecover: true,
    });
    expect(await listed("ExpiredRecoverable", id)).toBe(true);
    expect(await listed("Pending", id)).toBe(false);

    // Nothing happened on the chain: the contract still has it Pending, and there is nothing new
    // to index.
    const onchain = await client.readContract({
      address: deployment.escrow,
      abi: escrowAbi,
      functionName: "getEscrow",
      args: [id],
    });
    expect(ONCHAIN_STATUS[onchain.status]).toBe("Pending");
    await catchUp(context);
    expect(await countEvents(db.pool)).toBe(events);
  });

  it("follows the deadlines to the second, in the view and in the status filter", async () => {
    const { client } = anvil;
    const { id, receipt } = await createEscrow(client, deployment, bob, alice.address);
    await catchUp(context);
    const createdAt = (await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp;

    await mineAt(createdAt + CANCEL_WINDOW - 1n);
    expect(await view(id)).toMatchObject({ status: "Pending", canCancel: true, canConfirm: true });

    await mineAt(createdAt + CANCEL_WINDOW);
    expect(await view(id)).toMatchObject({ status: "Pending", canCancel: false, canConfirm: true });

    await mineAt(createdAt + TTL - 1n);
    expect(await view(id)).toMatchObject({
      status: "Pending",
      canConfirm: true,
      canRecover: false,
    });
    expect(await listed("Pending", id)).toBe(true);
    expect(await listed("ExpiredRecoverable", id)).toBe(false);

    await mineAt(createdAt + TTL);
    expect(await view(id)).toMatchObject({
      status: "ExpiredRecoverable",
      canConfirm: false,
      canRecover: true,
    });
    expect(await listed("Pending", id)).toBe(false);
    expect(await listed("ExpiredRecoverable", id)).toBe(true);
  });
});
