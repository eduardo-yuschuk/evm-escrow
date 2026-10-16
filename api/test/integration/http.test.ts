import type { FastifyInstance } from "fastify";
import { getAddress, maxUint256, type TransactionReceipt } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createChainClient } from "../../src/chain.js";
import { createChainClock } from "../../src/clock.js";
import { createPool, type Pool } from "../../src/db/pool.js";
import type { Deployment } from "../../src/deployment.js";
import { buildServer } from "../../src/http/server.js";
import type { EscrowView } from "../../src/http/view.js";
import type { IndexerContext } from "../../src/indexer/indexer.js";
import { ensureIndexerState } from "../../src/indexer/guard.js";
import {
  act,
  alice,
  bob,
  CANCEL_WINDOW,
  createEscrow,
  deployContracts,
  ONE_TOKEN,
  startAnvil,
  TTL,
  withdraw,
  type Anvil,
} from "../support/chain.js";
import { createTestDatabase, silentLog, type TestDatabase } from "../support/db.js";
import { catchUp, indexerContext } from "../support/indexer.js";

interface Page {
  items: EscrowView[];
  limit: number;
  offset: number;
  total: number;
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
}

interface Health {
  status: string;
  db: string;
  rpc: string;
  lastIndexedBlock: number | null;
  chainHead: number | null;
  lag: number | null;
}

const MAX_LAG = 2;
const neverAborted = new AbortController().signal;

function server(pool: Pool, rpcUrl: string): FastifyInstance {
  const client = createChainClient(rpcUrl, neverAborted);
  return buildServer({
    pool,
    client,
    // No cache: each request sees the latest block.
    clock: createChainClock(client, 0),
    log: silentLog,
    health: { confirmations: 0, maxLag: MAX_LAG },
  });
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is the expected body
async function get<T>(app: FastifyInstance, url: string): Promise<{ statusCode: number; body: T }> {
  const response = await app.inject({ method: "GET", url });
  return { statusCode: response.statusCode, body: response.json<T>() };
}

let anvil: Anvil;
let db: TestDatabase;
let deployment: Deployment;
let context: IndexerContext;
let app: FastifyInstance;
let released: {
  created: TransactionReceipt;
  confirmed: TransactionReceipt;
  withdrawals: TransactionReceipt[];
};

const listIds = async (query: string) =>
  (await get<Page>(app, `/escrows?${query}`)).body.items.map((item) => item.id);

beforeAll(async () => {
  anvil = await startAnvil();
  return anvil.stop;
});

beforeAll(async () => {
  db = await createTestDatabase();
  return db.drop;
});

/**
 * One escrow in each effective status, ids in creation order:
 * 1 Expired, 2 ExpiredRecoverable, 3 Released, 4 Rejected, 5 CancelledBySender, 6 and 7 Pending.
 * All from alice to bob, except 4 and 6, from bob to alice. 3 is withdrawn in two parts, 1 fully,
 * and the other resolved ones not at all.
 */
beforeAll(async () => {
  const { client } = anvil;
  deployment = await deployContracts(client);
  const create = async (from: typeof alice, to: typeof bob, tokens: bigint) =>
    createEscrow(client, deployment, from, to.address, tokens * ONE_TOKEN);

  const expired = await create(alice, bob, 1n);
  await create(alice, bob, 2n);
  await client.increaseTime({ seconds: Number(TTL) });
  await client.mine({ blocks: 1 });
  await act(client, deployment, alice, "recoverExpired", expired.id);
  await withdraw(client, deployment, alice, expired.id, ONE_TOKEN);

  const toRelease = await create(alice, bob, 3n);
  released = {
    created: toRelease.receipt,
    confirmed: await act(client, deployment, bob, "confirm", toRelease.id),
    withdrawals: [
      await withdraw(client, deployment, bob, toRelease.id, ONE_TOKEN, ONE_TOKEN),
      await withdraw(client, deployment, bob, toRelease.id, 2n * ONE_TOKEN, 2n * ONE_TOKEN),
    ],
  };
  await act(client, deployment, alice, "reject", (await create(bob, alice, 4n)).id);
  await act(client, deployment, alice, "cancel", (await create(alice, bob, 5n)).id);
  await create(bob, alice, 6n);
  await create(alice, bob, 7n);

  await ensureIndexerState(db.pool, deployment, false, silentLog);
  context = indexerContext(db.pool, anvil.url, deployment);
  await catchUp(context);
  app = server(db.pool, anvil.url);
});

afterAll(async () => {
  await app.close();
});

describe("GET /escrows/:id", () => {
  it("returns the escrow with its derived state", async () => {
    const { client } = anvil;
    const createdAt = (await client.getBlock({ blockNumber: released.created.blockNumber }))
      .timestamp;
    const timestampOf = async (receipt: TransactionReceipt) =>
      Number((await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
    const resolvedAt = await timestampOf(released.confirmed);
    const now = (await client.getBlock()).timestamp;
    const withdrawals = [];
    for (const [i, receipt] of released.withdrawals.entries()) {
      const tokens = String(BigInt(i + 1) * ONE_TOKEN);
      withdrawals.push({
        txHash: receipt.transactionHash,
        withdrawnAt: await timestampOf(receipt),
        debited: tokens,
        received: tokens,
      });
    }

    const { statusCode, body } = await get<EscrowView>(app, "/escrows/3");

    expect(statusCode).toBe(200);
    expect(body).toEqual({
      id: "3",
      sender: alice.address,
      beneficiary: bob.address,
      token: getAddress(deployment.token),
      amount: String(3n * ONE_TOKEN),
      withdrawn: String(3n * ONE_TOKEN),
      withdrawable: "0",
      createdAt: Number(createdAt),
      cancelDeadline: Number(createdAt + CANCEL_WINDOW),
      expiresAt: Number(createdAt + TTL),
      onchainStatus: "Released",
      status: "Released",
      holder: bob.address,
      canCancel: false,
      canConfirm: false,
      canReject: false,
      canRecover: false,
      canWithdraw: false,
      createdTx: released.created.transactionHash,
      resolvedTx: released.confirmed.transactionHash,
      resolvedAt,
      withdrawals,
      now: Number(now),
    });
  });

  it("reports what the holder of a resolved escrow can still withdraw", async () => {
    expect((await get<EscrowView>(app, "/escrows/4")).body).toMatchObject({
      onchainStatus: "Rejected",
      holder: bob.address,
      withdrawn: "0",
      withdrawable: String(4n * ONE_TOKEN),
      canWithdraw: true,
      withdrawals: [],
    });
    expect((await get<EscrowView>(app, "/escrows/1")).body).toMatchObject({
      onchainStatus: "Expired",
      holder: alice.address,
      withdrawn: String(ONE_TOKEN),
      withdrawable: "0",
      canWithdraw: false,
    });
  });

  it("derives the actions a Pending escrow admits", async () => {
    expect((await get<EscrowView>(app, "/escrows/7")).body).toMatchObject({
      onchainStatus: "Pending",
      status: "Pending",
      canCancel: true,
      canConfirm: true,
      canReject: true,
      canRecover: false,
      holder: null,
      withdrawable: "0",
      canWithdraw: false,
      resolvedTx: null,
      resolvedAt: null,
      withdrawals: [],
    });
  });

  it("reports a Pending escrow past expiresAt as ExpiredRecoverable", async () => {
    expect((await get<EscrowView>(app, "/escrows/2")).body).toMatchObject({
      onchainStatus: "Pending",
      status: "ExpiredRecoverable",
      canCancel: false,
      canConfirm: false,
      canReject: false,
      canRecover: true,
    });
  });

  it.each(["8", "0", maxUint256.toString()])("answers 404 for escrow %s", async (id) => {
    expect(await get<ErrorBody>(app, `/escrows/${id}`)).toEqual({
      statusCode: 404,
      body: { statusCode: 404, error: "Not Found", message: `Escrow ${id} not found` },
    });
  });

  it.each(["abc", "-1", "0x1", "1e3", "1.5", (maxUint256 + 1n).toString()])(
    "answers 400 for id %s",
    async (id) => {
      const { statusCode, body } = await get<ErrorBody>(app, `/escrows/${id}`);
      expect(statusCode).toBe(400);
      expect(body).toMatchObject({ statusCode: 400, error: "Bad Request" });
      expect(body.message).toMatch(/^id: /);
    },
  );
});

describe("GET /escrows", () => {
  it("lists every escrow, newest first, 20 per page by default", async () => {
    const { statusCode, body } = await get<Page>(app, "/escrows");
    expect(statusCode).toBe(200);
    expect(body.items.map((item) => item.id)).toEqual(["7", "6", "5", "4", "3", "2", "1"]);
    expect(body).toMatchObject({ limit: 20, offset: 0, total: 7 });
  });

  it("returns each item as /escrows/:id does, withdrawals included", async () => {
    const { body } = await get<Page>(app, "/escrows");
    for (const item of body.items) {
      expect(item).toEqual({
        ...(await get<EscrowView>(app, `/escrows/${item.id}`)).body,
        now: item.now,
      });
    }
    expect(body.items.find((item) => item.id === "3")?.withdrawals).toHaveLength(2);
  });

  it("treats empty parameters as absent, like the form /escrows?sender=&beneficiary=&status=", async () => {
    expect((await get<Page>(app, "/escrows?sender=&beneficiary=&status=")).body).toEqual(
      (await get<Page>(app, "/escrows")).body,
    );
  });

  it.each([
    ["Pending", ["7", "6"]],
    ["ExpiredRecoverable", ["2"]],
    ["Released", ["3"]],
    ["Rejected", ["4"]],
    ["CancelledBySender", ["5"]],
    ["Expired", ["1"]],
  ])("filters by effective status %s", async (status, ids) => {
    expect(await listIds(`status=${status}`)).toEqual(ids);
  });

  it("filters by sender and beneficiary, in any letter case", async () => {
    const aliceIds = ["7", "5", "3", "2", "1"];
    expect(await listIds(`sender=${alice.address}`)).toEqual(aliceIds);
    expect(await listIds(`sender=${alice.address.toLowerCase()}`)).toEqual(aliceIds);
    expect(await listIds(`sender=0x${alice.address.slice(2).toUpperCase()}`)).toEqual(aliceIds);
    expect(await listIds(`beneficiary=${alice.address}`)).toEqual(["6", "4"]);
  });

  it("combines the filters", async () => {
    expect(await listIds(`sender=${alice.address}&status=Pending`)).toEqual(["7"]);
    expect(
      await listIds(`sender=${bob.address}&beneficiary=${alice.address}&status=Rejected`),
    ).toEqual(["4"]);
    expect(
      (await get<Page>(app, `/escrows?sender=${bob.address}&beneficiary=${bob.address}`)).body,
    ).toEqual({ items: [], limit: 20, offset: 0, total: 0 });
  });

  it("paginates, with the total of the filter", async () => {
    const page = async (query: string) => {
      const { body } = await get<Page>(app, `/escrows?${query}`);
      return {
        ids: body.items.map((item) => item.id),
        limit: body.limit,
        offset: body.offset,
        total: body.total,
      };
    };
    expect(await page("limit=3")).toEqual({ ids: ["7", "6", "5"], limit: 3, offset: 0, total: 7 });
    expect(await page("limit=3&offset=3")).toEqual({
      ids: ["4", "3", "2"],
      limit: 3,
      offset: 3,
      total: 7,
    });
    expect(await page("limit=3&offset=6")).toEqual({ ids: ["1"], limit: 3, offset: 6, total: 7 });
    expect(await page("offset=7")).toEqual({ ids: [], limit: 20, offset: 7, total: 7 });
    expect(await page(`sender=${alice.address}&limit=2&offset=1`)).toEqual({
      ids: ["5", "3"],
      limit: 2,
      offset: 1,
      total: 5,
    });
  });

  it.each([
    ["limit=0", "limit"],
    ["limit=101", "limit"],
    ["limit=abc", "limit"],
    ["offset=-1", "offset"],
    ["status=pending", "status"],
    ["sender=0x1234", "sender"],
    ["beneficiary=alice", "beneficiary"],
    [`benficiary=${bob.address}`, "benficiary"],
    ["limit=1&limit=2", "limit"],
  ])("answers 400 for ?%s", async (query, parameter) => {
    const { statusCode, body } = await get<ErrorBody>(app, `/escrows?${query}`);
    expect(statusCode).toBe(400);
    expect(body).toMatchObject({ statusCode: 400, error: "Bad Request" });
    expect(body.message).toContain(parameter);
  });
});

describe("GET /health", () => {
  it("is ok when the indexer is caught up", async () => {
    const head = Number(await anvil.client.getBlockNumber());
    expect(await get<Health>(app, "/health")).toEqual({
      statusCode: 200,
      body: { status: "ok", db: "ok", rpc: "ok", lastIndexedBlock: head, chainHead: head, lag: 0 },
    });
  });

  it("is degraded while the indexer lags more than CONFIRMATIONS + HEALTH_MAX_LAG blocks", async () => {
    await anvil.client.mine({ blocks: MAX_LAG });
    expect((await get<Health>(app, "/health")).body).toMatchObject({ status: "ok", lag: MAX_LAG });

    await anvil.client.mine({ blocks: 1 });
    expect(await get<Health>(app, "/health")).toMatchObject({
      statusCode: 503,
      body: { status: "degraded", db: "ok", rpc: "ok", lag: MAX_LAG + 1 },
    });

    await catchUp(context);
    expect(await get<Health>(app, "/health")).toMatchObject({ statusCode: 200, body: { lag: 0 } });
  });

  // As seen by a MODE=api process when Anvil restarts: the head falls below the checkpoint.
  it("is degraded when the chain head is behind the checkpoint", async () => {
    const head = await anvil.client.getBlockNumber();
    await db.pool.query("UPDATE indexer_state SET last_indexed_block = $1", [head + 5n]);
    try {
      expect(await get<Health>(app, "/health")).toMatchObject({
        statusCode: 503,
        body: { status: "degraded", chainHead: Number(head), lag: -5 },
      });
    } finally {
      await db.pool.query("UPDATE indexer_state SET last_indexed_block = $1", [head]);
    }
  });
});

describe("unavailable dependencies", () => {
  it("answers 503 without the node, since there is no clock for the derived state", async () => {
    // Nothing listens on port 1: connections are refused at once.
    const offline = server(db.pool, "http://127.0.0.1:1");
    try {
      for (const url of ["/escrows/1", "/escrows"]) {
        expect(await get<ErrorBody>(offline, url)).toEqual({
          statusCode: 503,
          body: {
            statusCode: 503,
            error: "Service Unavailable",
            message: "Cannot read the latest block from the chain",
          },
        });
      }
      expect(await get<ErrorBody>(offline, "/escrows/1/max-withdrawal")).toEqual({
        statusCode: 503,
        body: {
          statusCode: 503,
          error: "Service Unavailable",
          message: "Cannot simulate the withdrawal against the chain",
        },
      });
      expect(await get<Health>(offline, "/health")).toMatchObject({
        statusCode: 503,
        body: { status: "degraded", db: "ok", rpc: "error", chainHead: null, lag: null },
      });
    } finally {
      await offline.close();
    }
  });

  it("answers 503 without the database", async () => {
    const pool = createPool("postgres://escrow:escrow@127.0.0.1:1/escrow_test", silentLog);
    const offline = server(pool, anvil.url);
    try {
      for (const url of ["/escrows/1", "/escrows", "/escrows/1/max-withdrawal"]) {
        expect(await get<ErrorBody>(offline, url)).toEqual({
          statusCode: 503,
          body: {
            statusCode: 503,
            error: "Service Unavailable",
            message: "Cannot read the database",
          },
        });
      }
      expect(await get<Health>(offline, "/health")).toMatchObject({
        statusCode: 503,
        body: { status: "degraded", db: "error", rpc: "ok", lastIndexedBlock: null, lag: null },
      });
    } finally {
      await offline.close();
      await pool.end();
    }
  });

  it("is degraded before the indexer starts, with no contract to simulate against", async () => {
    const empty = await createTestDatabase();
    const fresh = server(empty.pool, anvil.url);
    try {
      expect(await get<Health>(fresh, "/health")).toMatchObject({
        statusCode: 503,
        body: { status: "degraded", db: "ok", rpc: "ok", lastIndexedBlock: null, lag: null },
      });
      expect(await get<ErrorBody>(fresh, "/escrows/1/max-withdrawal")).toMatchObject({
        statusCode: 503,
        body: { message: "The indexer has not started yet" },
      });
    } finally {
      await fresh.close();
      await empty.drop();
    }
  });
});
