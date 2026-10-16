import {
  BaseError,
  ContractFunctionRevertedError,
  erc20Abi,
  maxUint256,
  parseAbi,
  type Address,
} from "viem";

import type { ChainClient } from "../chain.js";
import { escrowAbi } from "../generated/contracts.js";

/** Most simulations per request: enough for the exact maximum of any balance below 2^128. */
export const MAX_SIMULATIONS = 128;

/** Escrow.Status, as getEscrow returns it. */
const PENDING = 1;
const RELEASED = 2;

/**
 * The escrow's errors plus ERC-6093's, which OpenZeppelin tokens revert with when the escrow cannot
 * pay a transfer and its fee: then the escrow's own check is never reached.
 */
const simulationAbi = [
  ...escrowAbi,
  ...parseAbi(["error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)"]),
] as const;

/** What a simulated withdrawal of one amount tells. */
export type Simulation =
  | { ok: true; received: bigint }
  /** `debited`, when known, is what the token would take from the escrow for that amount. */
  | { ok: false; debited?: bigint; reason: string };

export type FailedSimulation = Extract<Simulation, { ok: false }>;

export interface MaxTransfer {
  /** The largest amount whose withdrawal passes, or 0 if none does. */
  transferAmount: bigint;
  /** What the holder would receive for it. */
  received: bigint;
  /** The last amount that failed, and why. */
  failure: FailedSimulation | undefined;
  simulations: number;
}

/**
 * The largest amount in [1, balance] whose withdrawal passes, simulating candidates. Assumes that if
 * an amount passes, every smaller one does too, which holds for any fee that grows with the amount.
 *
 * Every candidate is checked by `simulate`; the debit of a failed amount only picks the next one,
 * scaled to fit the balance, which lands on or just below the maximum for a proportional or a fixed
 * fee. From there it climbs one unit at a time, doubling the step while it passes. Without a debit,
 * it tries the smallest amount, to tell at once whether any passes, and then bisects.
 */
export async function findMaxTransfer(
  balance: bigint,
  simulate: (transferAmount: bigint) => Promise<Simulation>,
  maxSimulations = MAX_SIMULATIONS,
): Promise<MaxTransfer> {
  let lo = 0n; // largest amount known to pass, or 0
  let received = 0n;
  let hi = balance + 1n; // smallest amount known to fail
  let failure: FailedSimulation | undefined;
  let step = 1n;
  let next = balance;
  let simulations = 0;

  while (hi - lo > 1n && simulations < maxSimulations) {
    const outcome = await simulate(next);
    simulations += 1;
    if (outcome.ok) {
      lo = next;
      received = outcome.received;
      if (failure?.debited === undefined) {
        next = lo + (hi - lo) / 2n;
      } else {
        next = lo + step;
        step *= 2n;
      }
    } else {
      hi = next;
      failure = outcome;
      step = 1n;
      if (outcome.debited !== undefined && outcome.debited > 0n) {
        next = (next * balance) / outcome.debited;
      } else if (lo === 0n) {
        next = 1n;
      } else {
        next = lo + (hi - lo) / 2n;
      }
    }
    if (next <= lo || next >= hi) next = lo + (hi - lo) / 2n;
  }
  return { transferAmount: lo, received, failure, simulations };
}

export interface MaxWithdrawal {
  /** Who can withdraw: null while Pending. Lowercase. */
  holder: Address | null;
  /** `amount - withdrawn` once resolved, 0 while Pending. */
  withdrawable: bigint;
  transferAmount: bigint;
  received: bigint;
  failure: FailedSimulation | undefined;
  /** How many withdrawals were simulated. */
  simulations: number;
  /** The block every read and simulation ran against. */
  blockNumber: bigint;
}

function describe(revert: ContractFunctionRevertedError): string {
  if (revert.data) {
    const args = (revert.data.args ?? []).map(String).join(", ");
    return `${revert.data.errorName}(${args})`;
  }
  return revert.signature ? `error ${revert.signature}` : (revert.reason ?? "no reason");
}

/** The revert behind `error`, or undefined if the call failed for another reason (e.g. the node). */
function revertOf(error: unknown): ContractFunctionRevertedError | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? revert : undefined;
}

/**
 * How much the holder of escrow `id` can withdraw right now: the largest `transferAmount` whose
 * withdrawal, simulated as the holder against the latest block, passes. Reads the escrow from the
 * chain, not from the projection, at the same block as the simulations. Undefined if the escrow does
 * not exist.
 */
export async function maxWithdrawal(
  client: ChainClient,
  escrow: Address,
  id: bigint,
): Promise<MaxWithdrawal | undefined> {
  const blockNumber = await client.getBlockNumber();
  let state;
  try {
    state = await client.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "getEscrow",
      args: [id],
      blockNumber,
    });
  } catch (error) {
    if (revertOf(error)?.data?.errorName === "EscrowNotFound") return undefined;
    throw error;
  }
  if (state.status === PENDING) {
    return {
      holder: null,
      withdrawable: 0n,
      transferAmount: 0n,
      received: 0n,
      failure: undefined,
      simulations: 0,
      blockNumber,
    };
  }

  const holder = (
    state.status === RELEASED ? state.beneficiary : state.sender
  ).toLowerCase() as Address;
  const withdrawable = state.amount - state.withdrawn;
  const held = await client.readContract({
    address: state.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [escrow],
    blockNumber,
  });

  // With minReceived at its maximum, a withdrawal that passes the escrow's debit check always
  // reverts with ReceivedBelowMinimum, which says what the holder would receive.
  const simulate = async (transferAmount: bigint): Promise<Simulation> => {
    try {
      await client.simulateContract({
        address: escrow,
        abi: simulationAbi,
        functionName: "withdraw",
        args: [id, transferAmount, maxUint256],
        account: holder,
        blockNumber,
      });
    } catch (error) {
      const revert = revertOf(error);
      if (!revert) throw error;
      const reason = describe(revert);
      const args = revert.data?.args ?? [];
      switch (revert.data?.errorName) {
        case "ReceivedBelowMinimum":
          return { ok: true, received: args[1] as bigint };
        case "ExcessiveDebit":
          return { ok: false, debited: args[2] as bigint, reason };
        case "ERC20InsufficientBalance": {
          // The token already took `held - balance` from the escrow and needed `needed` more.
          const [sender, balance, needed] = args as [Address, bigint, bigint];
          if (sender.toLowerCase() === escrow && balance <= held) {
            return { ok: false, debited: held - balance + needed, reason };
          }
          return { ok: false, reason };
        }
        default:
          return { ok: false, reason };
      }
    }
    throw new Error(`withdraw(${String(id)}) passed with minReceived = 2^256 - 1`);
  };

  const result = await findMaxTransfer(withdrawable, simulate);
  return {
    holder,
    withdrawable,
    transferAmount: result.transferAmount,
    received: result.received,
    failure: result.failure,
    simulations: result.simulations,
    blockNumber,
  };
}
