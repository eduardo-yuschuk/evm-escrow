import { describe, expect, it } from "vitest";

import { findMaxTransfer, type Simulation } from "../../src/http/withdrawal.js";

/** What a token takes from the escrow, and what the holder gets, for a transfer of `amount`. */
interface TokenModel {
  debit: (amount: bigint) => bigint;
  credit: (amount: bigint) => bigint;
}

const noFee: TokenModel = { debit: (t) => t, credit: (t) => t };
/** Like FeeOnTopERC20: the payer also pays `bps` of the amount, rounded down. */
const feeOnTop = (bps: bigint): TokenModel => ({
  debit: (t) => t + (t * bps) / 10_000n,
  credit: (t) => t,
});
/** Like FeeOnTransferERC20: the fee comes out of the amount. */
const feeOnTransfer = (bps: bigint): TokenModel => ({
  debit: (t) => t,
  credit: (t) => t - (t * bps) / 10_000n,
});
const fixedOnTop = (fee: bigint): TokenModel => ({ debit: (t) => t + fee, credit: (t) => t });

/**
 * The escrow's withdraw, simulated: against an escrow balance of `balance` and a contract holding
 * `held` of the token. If the contract cannot pay the debit the token reverts first, without
 * reporting it; otherwise the escrow's own check reports it.
 */
function simulator(balance: bigint, token: TokenModel, held = balance) {
  const calls: bigint[] = [];
  const simulate = (amount: bigint): Promise<Simulation> => {
    calls.push(amount);
    const debited = token.debit(amount);
    if (debited > held) return Promise.resolve({ ok: false, reason: "insufficient balance" });
    if (debited > balance) return Promise.resolve({ ok: false, debited, reason: "ExcessiveDebit" });
    return Promise.resolve({ ok: true, received: token.credit(amount) });
  };
  return { simulate, calls };
}

/** Independent oracle: the largest amount whose debit fits in the balance and in what the contract holds. */
function expectedMax(balance: bigint, token: TokenModel, held = balance): bigint {
  let lo = 0n;
  let hi = balance;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const debited = token.debit(mid);
    if (debited <= balance && debited <= held) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** As strings, so that test names do not show the bigint suffix. */
const BALANCES = ["1", "7", "1000", String(10n ** 20n), "123456789012345678901234"];

describe("findMaxTransfer", () => {
  it("withdraws the whole balance of a token without fees, in one simulation", async () => {
    const { simulate, calls } = simulator(1_000n, noFee);
    expect(await findMaxTransfer(1_000n, simulate)).toEqual({
      transferAmount: 1_000n,
      received: 1_000n,
      failure: undefined,
      simulations: 1,
    });
    expect(calls).toEqual([1_000n]);
  });

  it("does not simulate when there is nothing to withdraw", async () => {
    const { simulate, calls } = simulator(0n, noFee);
    expect((await findMaxTransfer(0n, simulate)).transferAmount).toBe(0n);
    expect(calls).toEqual([]);
  });

  describe.each([1, 100, 250, 1_000, 10_000])("a fee of %i bps on top of the amount", (bps) => {
    it.each(BALANCES)(
      "finds the exact maximum of a balance of %s in a few simulations",
      async (value) => {
        const balance = BigInt(value);
        const token = feeOnTop(BigInt(bps));
        const { simulate } = simulator(balance, token, 2n * balance + 10n);
        const result = await findMaxTransfer(balance, simulate);
        expect(result.transferAmount).toBe(expectedMax(balance, token));
        expect(result.received).toBe(result.transferAmount);
        expect(result.simulations).toBeLessThanOrEqual(6);
      },
    );
  });

  it("finds the exact maximum for a 1% fee on top: 100 tokens leave no dust", async () => {
    const balance = 100n * 10n ** 18n;
    const { simulate, calls } = simulator(balance, feeOnTop(100n), 2n * balance);
    const result = await findMaxTransfer(balance, simulate);
    // 99.0099...01 plus its 1% fee, rounded down, is exactly 100.
    expect(result.transferAmount).toBe(99_009_900_990_099_009_901n);
    expect(feeOnTop(100n).debit(result.transferAmount)).toBe(balance);
    expect(calls).toHaveLength(5);
  });

  it.each(["1", "3", String(10n ** 16n), String(10n ** 18n)])(
    "finds the exact maximum for a fixed fee of %s on top",
    async (value) => {
      const fee = BigInt(value);
      const balance = 100n * 10n ** 18n;
      const token = fixedOnTop(fee);
      const { simulate } = simulator(balance, token, 2n * balance);
      expect((await findMaxTransfer(balance, simulate)).transferAmount).toBe(balance - fee);
    },
  );

  it("withdraws the whole balance when the fee comes out of the amount, and says what arrives", async () => {
    const { simulate } = simulator(1_000n, feeOnTransfer(100n));
    expect(await findMaxTransfer(1_000n, simulate)).toMatchObject({
      transferAmount: 1_000n,
      received: 990n,
      simulations: 1,
    });
  });

  it.each(BALANCES)(
    "finds the exact maximum of %s when the token reverts before reporting the debit, bisecting",
    async (value) => {
      const balance = BigInt(value);
      // The only escrow of its token: the contract holds just its balance, and cannot pay the fee.
      const token = feeOnTop(100n);
      const { simulate } = simulator(balance, token, balance);
      const result = await findMaxTransfer(balance, simulate);
      expect(result.transferAmount).toBe(expectedMax(balance, token));
      expect(result.simulations).toBeLessThanOrEqual(balance.toString(2).length + 2);
    },
  );

  it("finds nothing when the fee alone exceeds the balance, and says it is the fee", async () => {
    const { simulate } = simulator(100n, fixedOnTop(100n), 1_000n);
    const result = await findMaxTransfer(100n, simulate);
    expect(result.transferAmount).toBe(0n);
    expect(result.failure?.debited).toBeDefined();
  });

  it("gives up after two simulations when every amount fails without a debit", async () => {
    // E.g. a token that blocks the holder.
    const calls: bigint[] = [];
    const simulate = (amount: bigint): Promise<Simulation> => {
      calls.push(amount);
      return Promise.resolve({ ok: false, reason: "Blocked(holder)" });
    };
    expect(await findMaxTransfer(10n ** 20n, simulate)).toEqual({
      transferAmount: 0n,
      received: 0n,
      failure: { ok: false, reason: "Blocked(holder)" },
      simulations: 2,
    });
    expect(calls).toEqual([10n ** 20n, 1n]);
  });

  it("stops at the simulation limit with an amount that passes", async () => {
    const balance = 10n ** 20n;
    const token = feeOnTop(100n);
    const { simulate } = simulator(balance, token, balance);
    const result = await findMaxTransfer(balance, simulate, 5);
    expect(result.simulations).toBe(5);
    expect(result.transferAmount).toBeGreaterThan(0n);
    expect(result.transferAmount).toBeLessThanOrEqual(expectedMax(balance, token));
  });
});
