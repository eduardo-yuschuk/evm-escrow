import type { Address, Hash } from "viem";

import type { IndexedEvent, ResolutionEventName } from "./events.js";

/** On-chain status of an escrow, as stored in the projection. */
export type EscrowStatus = "Pending" | "Released" | "Rejected" | "CancelledBySender" | "Expired";
export type FinalStatus = Exclude<EscrowStatus, "Pending">;

/** What the projector needs to know about an escrow that is already projected. */
export interface EscrowState {
  status: EscrowStatus;
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

export type Mutation =
  | { kind: "create"; escrow: NewEscrow }
  | { kind: "resolve"; id: bigint; status: FinalStatus; resolvedTx: Hash; resolvedAt: bigint }
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
 * Applying the same event twice is a no-op. The contract guarantees that an escrow is created once
 * and resolved at most once, so any other conflict means the projection is out of sync with the
 * chain: it is reported with level "error" and the event is not applied.
 */
export function applyEvent(state: EscrowState | undefined, indexed: IndexedEvent): Mutation {
  const { event, txHash, blockTimestamp } = indexed;

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
