import { getAddress, type Address, type Hash } from "viem";

import type { EscrowStatus } from "../indexer/projector.js";

/** An escrow as projected from the events. Addresses and hashes are lowercase. */
export interface Escrow {
  id: bigint;
  sender: Address;
  beneficiary: Address;
  token: Address;
  amount: bigint;
  createdAt: bigint;
  cancelDeadline: bigint;
  expiresAt: bigint;
  status: EscrowStatus;
  createdTx: Hash;
  resolvedTx: Hash | null;
  resolvedAt: bigint | null;
}

/** The on-chain status, except that a Pending escrow is ExpiredRecoverable from expiresAt on. */
export type EffectiveStatus = EscrowStatus | "ExpiredRecoverable";

export const EFFECTIVE_STATUSES = [
  "Pending",
  "ExpiredRecoverable",
  "Released",
  "Rejected",
  "CancelledBySender",
  "Expired",
] as const satisfies readonly EffectiveStatus[];

/** An escrow as the API returns it. */
export interface EscrowView {
  /** uint256 values are strings: they do not fit in a JSON number. */
  id: string;
  /** EIP-55 checksummed. */
  sender: Address;
  beneficiary: Address;
  token: Address;
  amount: string;
  /** Unix seconds. */
  createdAt: number;
  cancelDeadline: number;
  expiresAt: number;
  onchainStatus: EscrowStatus;
  status: EffectiveStatus;
  canCancel: boolean;
  canConfirm: boolean;
  canReject: boolean;
  canRecover: boolean;
  createdTx: Hash;
  resolvedTx: Hash | null;
  resolvedAt: number | null;
  /** The timestamp of the latest block, which the derived fields were computed with. */
  now: number;
}

/**
 * The escrow with the state derived from `now`, the timestamp of the latest block. Same rules as
 * the contract: `cancelDeadline` and `expiresAt` are the first second at which cancelling, and
 * confirming or rejecting, are no longer accepted, and recovering is accepted from `expiresAt` on.
 * Pure. The SQL filter by effective status in queries.ts follows the same rule.
 */
export function toView(escrow: Escrow, now: bigint): EscrowView {
  const pending = escrow.status === "Pending";
  const expired = now >= escrow.expiresAt;
  return {
    id: escrow.id.toString(),
    sender: getAddress(escrow.sender),
    beneficiary: getAddress(escrow.beneficiary),
    token: getAddress(escrow.token),
    amount: escrow.amount.toString(),
    createdAt: Number(escrow.createdAt),
    cancelDeadline: Number(escrow.cancelDeadline),
    expiresAt: Number(escrow.expiresAt),
    onchainStatus: escrow.status,
    status: pending && expired ? "ExpiredRecoverable" : escrow.status,
    canCancel: pending && now < escrow.cancelDeadline,
    canConfirm: pending && !expired,
    canReject: pending && !expired,
    canRecover: pending && expired,
    createdTx: escrow.createdTx,
    resolvedTx: escrow.resolvedTx,
    resolvedAt: escrow.resolvedAt === null ? null : Number(escrow.resolvedAt),
    now: Number(now),
  };
}
