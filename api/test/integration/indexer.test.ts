import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Address, Hash, LocalAccount } from "viem";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Deployment } from "../../src/deployment.js";
import { escrowAbi } from "../../src/generated/contracts.js";
import { ensureIndexerState } from "../../src/indexer/guard.js";
import { indexNextBatch, type IndexerContext } from "../../src/indexer/indexer.js";
import {
  act,
  alice,
  bob,
  createActivity,
  createEscrow,
  deployContracts,
  startAnvil,
  TTL,
  type Anvil,
} from "../support/chain.js";
import {
  countEvents,
  createTestDatabase,
  dumpProjection,
  readCheckpoint,
  silentLog,
  type TestDatabase,
} from "../support/db.js";
import { catchUp, expectProjectionMatchesChain, indexerContext } from "../support/indexer.js";

let anvil: Anvil;
let db: TestDatabase;
let deployment: Deployment;
let context: IndexerContext;

beforeAll(async () => {
  // fifo: transactions mined together keep the order they were sent in.
  anvil = await startAnvil(["--order", "fifo"]);
  return anvil.stop;
});

beforeAll(async () => {
  db = await createTestDatabase();
  return db.drop;
});

// Each test indexes a contract of its own, into an empty database.
beforeEach(async () => {
  await db.reset();
  deployment = await deployContracts(anvil.client);
  await ensureIndexerState(db.pool, deployment, false, silentLog);
  context = indexerContext(db.pool, anvil.url, deployment);
});

describe("indexer", () => {
  it("projects the four paths and an escrow left Pending, as the contract has them", async () => {
    const { client } = anvil;
    await createActivity(client, deployment, 4);
    const { id } = await createEscrow(client, deployment, alice, bob.address);
    await client.increaseTime({ seconds: Number(TTL) });
    await client.mine({ blocks: 1 });
    await act(client, deployment, alice, "recoverExpired", id);

    await catchUp(context);

    await expectProjectionMatchesChain(db.pool, client, deployment);
    const { rows } = await db.pool.query<{ status: string }>(
      "SELECT status FROM escrows ORDER BY id",
    );
    expect(rows.map((row) => row.status)).toEqual([
      "Released",
      "Rejected",
      "CancelledBySender",
      "Pending",
      "Expired",
    ]);
    expect(await readCheckpoint(db.pool)).toBe(await client.getBlockNumber());
  });

  it("applies several events of the same escrows in the same block, in log order", async () => {
    const { client } = anvil;
    const next =
      (await client.readContract({
        address: deployment.escrow,
        abi: escrowAbi,
        functionName: "escrowCount",
      })) + 1n;
    // Mined together, so gas and nonces are set by hand: estimating against the last block would
    // fail for an escrow that does not exist yet.
    const nonces = new Map<Address, number>();
    for (const { address } of [alice, bob]) {
      nonces.set(address, await client.getTransactionCount({ address }));
    }
    const options = (account: LocalAccount) => {
      const nonce = nonces.get(account.address) ?? 0;
      nonces.set(account.address, nonce + 1);
      return { account, address: deployment.escrow, abi: escrowAbi, gas: 500_000n, nonce };
    };
    const create = () =>
      client.writeContract({
        ...options(alice),
        functionName: "createEscrow",
        args: [deployment.token, bob.address, 1n],
      });
    const resolve = (account: LocalAccount, action: "confirm" | "reject" | "cancel", id: bigint) =>
      client.writeContract({ ...options(account), functionName: action, args: [id] });

    await client.setAutomine(false);
    let hashes: Hash[];
    try {
      hashes = [
        await create(),
        await resolve(bob, "confirm", next),
        await create(),
        await resolve(alice, "cancel", next + 1n),
        await create(),
        await resolve(bob, "reject", next + 2n),
      ];
      await client.mine({ blocks: 1 });
    } finally {
      await client.setAutomine(true);
    }
    const receipts = await Promise.all(
      hashes.map((hash) => client.getTransactionReceipt({ hash })),
    );
    expect(receipts.map((receipt) => receipt.status)).toEqual(Array(6).fill("success"));
    const block = receipts[0]?.blockNumber;
    expect(receipts.every((receipt) => receipt.blockNumber === block)).toBe(true);

    await catchUp(context);

    await expectProjectionMatchesChain(db.pool, client, deployment);
    const { rows } = await db.pool.query<{ status: string; same_second: boolean }>(
      "SELECT status, created_at = resolved_at AS same_second FROM escrows ORDER BY id",
    );
    expect(rows).toEqual([
      { status: "Released", same_second: true },
      { status: "CancelledBySender", same_second: true },
      { status: "Rejected", same_second: true },
    ]);
  });

  it("does not index the last CONFIRMATIONS blocks", async () => {
    const { client } = anvil;
    const confirmed = indexerContext(db.pool, anvil.url, deployment, 2);
    const { id } = await createEscrow(client, deployment, alice, bob.address);
    const head = await client.getBlockNumber();
    const indexedIds = async () => {
      const { rows } = await db.pool.query<{ id: string }>("SELECT id FROM escrows");
      return rows.map((row) => BigInt(row.id));
    };

    await catchUp(confirmed);
    expect(await readCheckpoint(db.pool)).toBe(head - 2n);
    expect(await indexedIds()).toEqual([]);

    await client.mine({ blocks: 1 });
    await catchUp(confirmed);
    expect(await readCheckpoint(db.pool)).toBe(head - 1n);
    expect(await indexedIds()).toEqual([]);

    await client.mine({ blocks: 1 });
    await catchUp(confirmed);
    expect(await readCheckpoint(db.pool)).toBe(head);
    expect(await indexedIds()).toEqual([id]);
  });

  it("leaves the database identical when an indexed range is processed again", async () => {
    await createActivity(anvil.client, deployment, 8, 2);
    await catchUp(context);
    const before = await dumpProjection(db.pool);
    const head = await readCheckpoint(db.pool);

    await db.pool.query("UPDATE indexer_state SET last_indexed_block = start_block");
    await catchUp(context);

    expect(await dumpProjection(db.pool)).toEqual(before);
    expect(await readCheckpoint(db.pool)).toBe(head);
  });

  describe("a batch that fails midway", () => {
    // Fails the first escrow row the indexer writes, after the batch already stored its events.
    // A sequence, because nextval is not rolled back with the failed transaction.
    beforeEach(async () => {
      await db.pool.query(`
        CREATE SEQUENCE escrow_writes;
        CREATE FUNCTION fail_first_escrow_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('escrow_writes') = 1 THEN
            RAISE EXCEPTION 'simulated crash';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER fail_first_escrow_write BEFORE INSERT ON escrows
          FOR EACH ROW EXECUTE FUNCTION fail_first_escrow_write();
      `);
    });

    afterEach(async () => {
      await db.pool.query(`
        DROP TRIGGER fail_first_escrow_write ON escrows;
        DROP FUNCTION fail_first_escrow_write;
        DROP SEQUENCE escrow_writes;
      `);
    });

    it("leaves nothing behind, and the retry applies each event once", async () => {
      await createActivity(anvil.client, deployment, 4);

      await expect(indexNextBatch(context)).rejects.toThrow("simulated crash");
      expect(await countEvents(db.pool)).toBe(0);
      expect(await readCheckpoint(db.pool)).toBe(deployment.startBlock);

      await catchUp(context);
      await expectProjectionMatchesChain(db.pool, anvil.client, deployment);
    });
  });

  it("resumes after being killed, without losing or duplicating events", async () => {
    const { client } = anvil;
    // Many blocks, indexed one per batch, so that the process can be killed halfway.
    await createActivity(client, deployment, 40, 5);
    const dir = await mkdtemp(path.join(tmpdir(), "deployments-"));
    const deploymentsFile = path.join(dir, "31337.json");
    await writeFile(
      deploymentsFile,
      JSON.stringify({ ...deployment, startBlock: Number(deployment.startBlock) }),
    );

    const children: ChildProcess[] = [];
    const start = () => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env: {
          ...process.env,
          MODE: "indexer",
          RPC_URL: anvil.url,
          DATABASE_URL: db.url,
          DEPLOYMENTS_FILE: deploymentsFile,
          BATCH_SIZE: "1",
          POLL_INTERVAL_MS: "20",
          LOG_LEVEL: "error",
        },
        stdio: ["ignore", "inherit", "inherit"],
      });
      children.push(child);
      return child;
    };
    const exited = (child: ChildProcess) =>
      once(child, "exit") as Promise<[number | null, string | null]>;
    const waitForCheckpoint = async (target: bigint) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const checkpoint = (await readCheckpoint(db.pool)) ?? 0n;
        if (checkpoint >= target) return checkpoint;
        if (Date.now() > deadline) {
          throw new Error(
            `The checkpoint is stuck at ${String(checkpoint)}, below ${String(target)}`,
          );
        }
        await delay(5);
      }
    };

    try {
      const head = await client.getBlockNumber();
      const third = (head - deployment.startBlock) / 3n;
      for (const target of [deployment.startBlock + third, deployment.startBlock + 2n * third]) {
        const child = start();
        const checkpoint = await waitForCheckpoint(target);
        child.kill("SIGKILL");
        expect(await exited(child)).toEqual([null, "SIGKILL"]);
        expect(checkpoint).toBeLessThan(head);
      }

      // More activity while it is down, then a run to the end and a clean stop.
      await createActivity(client, deployment, 4);
      const child = start();
      await waitForCheckpoint(await client.getBlockNumber());
      child.kill("SIGTERM");
      expect(await exited(child)).toEqual([0, null]);
    } finally {
      // A failed assertion must not leave an indexer running.
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await rm(dir, { recursive: true, force: true });
    }

    await expectProjectionMatchesChain(db.pool, client, deployment);
  }, 60_000);
});
