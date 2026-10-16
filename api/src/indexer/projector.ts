import type { Address, Hash } from "viem";

import type { IndexedEvent, ResolutionEventName } from "./events.js";

/** On-chain status of an escrow, as stored in the projection. */
export type EscrowStatus = "Pending" | "Released" | "Rejected" | "CancelledBySender" | "Expired";
export type FinalStatus = Exclude<EscrowStatus, "Pending">;

/** What the projector needs to know about an escrow that is already projected. */
export interface EscrowState {
  status: EscrowStatus;
  amount: bigint;
  withdrawn: bigint;
  createdTx: Hash;
  resolvedTx: Hash | null;
}

export interface NewEscrow {
  id: bigint;
  sender: Address;
  beneficiary: Address;
  token: Address;
  amount: bigint;
  createdAt: bigint;
  cancelDeadline: bigint;
  expiresAt: bigint;
  createdTx: Hash;
}

export interface Withdrawal {
  id: bigint;
  debited: bigint;
  received: bigint;
  txHash: Hash;
  logIndex: number;
  blockNumber: bigint;
  withdrawnAt: bigint;
}

export type Mutation =
  | { kind: "create"; escrow: NewEscrow }
  | { kind: "resolve"; id: bigint; status: FinalStatus; resolvedTx: Hash; resolvedAt: bigint }
  | { kind: "withdraw"; withdrawal: Withdrawal }
  /** Nothing to write. `level` says how surprising that is: anything above debug should not happen. */
  | { kind: "skip"; level: "debug" | "error"; reason: string };

const FINAL_STATUS = {
  EscrowCancelled: "CancelledBySender",
  EscrowReleased: "Released",
  EscrowRejected: "Rejected",
  EscrowExpired: "Expired",
} as const satisfies Record<ResolutionEventName, FinalStatus>;

/**
 * Decides how an event changes the projection, given the current state of its escrow (`undefined`
 * if it is not projected yet). Pure: the caller loads the state and writes the mutation.
 *
 * Applying the same creation or resolution twice is a no-op. The contract guarantees that an escrow
 * is created once, resolved at most once, and withdrawn from only once resolved and never beyond
 * its amount, so any other conflict means the projection is out of sync with the chain: it is
 * reported with level "error" and the event is not applied.
 *
 * An escrow can have several withdrawals, so the projector cannot tell a repeated one from a new
 * one: the caller applies each event once (see `commitBatch`), and the withdrawals table has the
 * same key as the events, so a repeated one is not counted.
 */
export function applyEvent(state: EscrowState | undefined, indexed: IndexedEvent): Mutation {
  const { event, txHash, blockTimestamp } = indexed;

  if (event.name === "EscrowWithdrawn") {
    if (state === undefined) {
      return { kind: "skip", level: "error", reason: "withdrawal from an unknown escrow" };
    }
    if (state.status === "Pending") {
      return { kind: "skip", level: "error", reason: "withdrawal from a Pending escrow" };
    }
    const balance = state.amount - state.withdrawn;
    if (event.args.debited > balance) {
      return {
        kind: "skip",
        level: "error",
        reason: `withdrawal of ${String(event.args.debited)} exceeds the balance of ${String(balance)}`,
      };
    }
    return {
      kind: "withdraw",
      withdrawal: {
        ...event.args,
        txHash,
        logIndex: indexed.logIndex,
        blockNumber: indexed.blockNumber,
        withdrawnAt: blockTimestamp,
      },
    };
  }

  if (event.name === "EscrowCreated") {
    if (state === undefined) {
      return {
        kind: "create",
        escrow: { ...event.args, createdAt: blockTimestamp, createdTx: txHash },
      };
    }
    if (state.createdTx === txHash) {
      return { kind: "skip", level: "debug", reason: "escrow already created by this event" };
    }
    return {
      kind: "skip",
      level: "error",
      reason: `escrow already created by transaction ${state.createdTx}`,
    };
  }

  const status = FINAL_STATUS[event.name];
  if (state === undefined) {
    return { kind: "skip", level: "error", reason: "resolution of an unknown escrow" };
  }
  if (state.status === "Pending") {
    return {
      kind: "resolve",
      id: event.args.id,
      status,
      resolvedTx: txHash,
      resolvedAt: blockTimestamp,
    };
  }
  if (state.status === status && state.resolvedTx === txHash) {
    return { kind: "skip", level: "debug", reason: "escrow already resolved by this event" };
  }
  return {
    kind: "skip",
    level: "error",
    reason: `escrow already resolved as ${state.status} by transaction ${String(state.resolvedTx)}`,
  };
}
