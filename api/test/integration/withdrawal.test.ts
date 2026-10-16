// GET /escrows/:id/max-withdrawal against tokens that charge fees or block the holder. Nothing is
// indexed: the endpoint reads the escrow from the chain and simulates withdrawals against it.
import type { FastifyInstance } from "fastify";
import { parseAbi, type Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createChainClient } from "../../src/chain.js";
import { createChainClock } from "../../src/clock.js";
import type { Deployment } from "../../src/deployment.js";
import {
  blacklistErc20Abi,
  blacklistErc20Bytecode,
  escrowAbi,
  feeOnTopErc20Abi,
  feeOnTopErc20Bytecode,
} from "../../src/generated/contracts.js";
import { buildServer } from "../../src/http/server.js";
import { maxWithdrawal } from "../../src/http/withdrawal.js";
import { ensureIndexerState } from "../../src/indexer/guard.js";
import {
  act,
  alice,
  bob,
  createEscrow,
  deployContracts,
  deployedAddress,
  fundForEscrow,
  mined,
  startAnvil,
  withdraw,
  type Anvil,
} from "../support/chain.js";
import { createTestDatabase, silentLog, type TestDatabase } from "../support/db.js";

interface MaxWithdrawal {
  id: string;
  holder: Address | null;
  withdrawable: string;
  transferAmount: string;
  received: string;
  blockNumber: number;
}

let anvil: Anvil;
let db: TestDatabase;
let deployment: Deployment;
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
  // The endpoint takes the contract address from the indexer state.
  await ensureIndexerState(db.pool, deployment, false, silentLog);
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

const get = async (id: bigint) => {
  const response = await app.inject({
    method: "GET",
    url: `/escrows/${String(id)}/max-withdrawal`,
  });
  return { statusCode: response.statusCode, body: response.json<MaxWithdrawal>() };
};

/** A token that charges 1% to the payer on top of the amount, funded for alice and bob. */
async function feeOnTopToken(): Promise<Address> {
  const { client } = anvil;
  const receipt = await mined(
    client,
    await client.deployContract({
      account: alice,
      abi: feeOnTopErc20Abi,
      bytecode: feeOnTopErc20Bytecode,
      args: [100n],
    }),
  );
  const token = deployedAddress(receipt);
  await fundForEscrow(client, deployment, token, 10_000n);
  return token;
}

/** The escrow's errors, plus the one OpenZeppelin tokens revert with when a balance falls short. */
const withdrawAbi = [
  ...escrowAbi,
  ...parseAbi(["error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)"]),
] as const;

/** Simulates withdraw as `holder`, to check what the endpoint answers against the contract itself. */
const simulateWithdraw = (holder: Address, id: bigint, transferAmount: bigint) =>
  anvil.client.simulateContract({
    address: deployment.escrow,
    abi: withdrawAbi,
    functionName: "withdraw",
    args: [id, transferAmount, 0n],
    account: holder,
  });

describe("GET /escrows/:id/max-withdrawal", () => {
  it("is the whole balance with a token without fees, read from the chain before indexing", async () => {
    const { client } = anvil;
    const { id } = await createEscrow(client, deployment, alice, bob.address, 1000n);
    await act(client, deployment, bob, "confirm", id);

    expect(await get(id)).toEqual({
      statusCode: 200,
      body: {
        id: String(id),
        holder: bob.address,
        withdrawable: "1000",
        transferAmount: "1000",
        received: "1000",
        blockNumber: Number(await client.getBlockNumber()),
      },
    });
  });

  it("with a fee on top, is the most whose amount plus fee fits in the balance", async () => {
    const { client } = anvil;
    const token = await feeOnTopToken();
    const { id } = await createEscrow(client, deployment, alice, bob.address, 1000n, token);
    await createEscrow(client, deployment, alice, bob.address, 1000n, token);
    await act(client, deployment, bob, "confirm", id);

    // 991 plus its fee, 9, is exactly 1000; 992 plus 9 is not.
    const { body } = await get(id);
    expect(body).toMatchObject({ withdrawable: "1000", transferAmount: "991", received: "991" });
    await expect(simulateWithdraw(bob.address, id, 992n)).rejects.toThrow("ExcessiveDebit");

    await withdraw(client, deployment, bob, id, 991n, 991n);
    expect((await get(id)).body).toMatchObject({ withdrawable: "0", transferAmount: "0" });
  });

  it("with a fee on top and nothing else of the token in the contract, is the same", async () => {
    // The token reverts before the escrow's check, since the contract cannot pay the fee.
    const { client } = anvil;
    const token = await feeOnTopToken();
    const { id } = await createEscrow(client, deployment, alice, bob.address, 1000n, token);
    await act(client, deployment, alice, "cancel", id);
    await expect(simulateWithdraw(alice.address, id, 1000n)).rejects.toThrow(
      "ERC20InsufficientBalance",
    );

    expect((await get(id)).body).toMatchObject({
      holder: alice.address,
      transferAmount: "991",
      received: "991",
    });
    // The token's ERC20InsufficientBalance tells the debit too, so there is no need to bisect.
    const chain = createChainClient(anvil.url, new AbortController().signal);
    const result = await maxWithdrawal(chain, deployment.escrow, id);
    expect(result?.simulations).toBeLessThanOrEqual(6);
    await withdraw(client, deployment, alice, id, 991n, 991n);
  });

  it("is nothing while the escrow is Pending, with no holder", async () => {
    const { id } = await createEscrow(anvil.client, deployment, alice, bob.address, 1000n);
    expect((await get(id)).body).toMatchObject({
      holder: null,
      withdrawable: "0",
      transferAmount: "0",
      received: "0",
    });
  });

  it("answers 409 when the token makes every withdrawal revert", async () => {
    const { client } = anvil;
    const token = deployedAddress(
      await mined(
        client,
        await client.deployContract({
          account: alice,
          abi: blacklistErc20Abi,
          bytecode: blacklistErc20Bytecode,
        }),
      ),
    );
    await fundForEscrow(client, deployment, token, 10_000n);
    const { id } = await createEscrow(client, deployment, alice, bob.address, 1000n, token);
    await act(client, deployment, bob, "confirm", id);
    await mined(
      client,
      await client.writeContract({
        account: alice,
        address: token,
        abi: blacklistErc20Abi,
        functionName: "setBlocked",
        args: [bob.address, true],
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: `/escrows/${String(id)}/max-withdrawal`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toMatch(
      new RegExp(`^A withdrawal from escrow ${String(id)} reverts with any amount: `),
    );
  });

  it("answers 404 for an escrow that does not exist, and 400 for an invalid id", async () => {
    const count = await anvil.client.readContract({
      address: deployment.escrow,
      abi: escrowAbi,
      functionName: "escrowCount",
    });
    expect((await get(count + 1n)).statusCode).toBe(404);
    expect((await get(0n)).statusCode).toBe(404);
    const invalid = await app.inject({ method: "GET", url: "/escrows/abc/max-withdrawal" });
    expect(invalid.statusCode).toBe(400);
  });

  it("has the sender as the holder of a rejected escrow", async () => {
    const { client } = anvil;
    const { id } = await createEscrow(client, deployment, bob, alice.address, 1000n);
    await act(client, deployment, alice, "reject", id);
    expect((await get(id)).body).toMatchObject({ holder: bob.address, transferAmount: "1000" });
  });
});
